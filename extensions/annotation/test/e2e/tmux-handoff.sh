#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotate and /resume-handoff in a real pi under tmux with a fake local model. Checks
that the annotation server keeps its port, the attached terminal view and browser tab follow
the replacement session with their unsent notes, old credentials get a successor response,
and /new still closes the server.

Usage:
  PI_BIN=~/.local/pi-1.1.0/bin extensions/annotation/test/e2e/tmux-handoff.sh
  PI_BIN=~/.local/pi-1.1.0/bin DRIVER=browser PLAYWRIGHT_CORE=/path/to/playwright-core \
    CHROME_BIN=/path/to/chrome extensions/annotation/test/e2e/tmux-handoff.sh

Environment:
  PI_BIN            required. Directory that holds the pi executable.
  TUI_MODE          fullscreen (default) or regular, passed to pi --tui-mode.
  DRIVER            curl (default) or browser. Browser mode drives the page with browser.mjs.
  PLAYWRIGHT_CORE   for DRIVER=browser: path to an installed playwright-core package.
  CHROME_BIN        for DRIVER=browser: Chrome or Chromium executable.
  SCREENSHOTS       for DRIVER=browser: screenshot directory. Default: $WORK/screenshots.
  WORK              isolated HOME, project and captures. Default: a new temporary directory,
                    removed after a passing run. A WORK you set is kept.
  PORT              port of the fake model. Default: 18734.
  ANNOTATE_PORT     passed to pi as PI_ANNOTATE_PORT. Default: 4747.

Needs tmux, python3 and node. Browser mode also needs Chrome or Chromium.
TXT
}

if [ -z "${PI_BIN:-}" ]; then
	echo "tmux-handoff.sh: PI_BIN is not set." >&2
	usage
	exit 2
fi
if [ ! -x "$PI_BIN/pi" ]; then
	echo "tmux-handoff.sh: no pi executable in $PI_BIN" >&2
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in tmux python3 node; do
	command -v "$tool" >/dev/null || { echo "tmux-handoff.sh: $tool not found" >&2; exit 2; }
done
TUI_MODE=${TUI_MODE:-fullscreen}
DRIVER=${DRIVER:-curl}
case "$TUI_MODE" in fullscreen | regular) ;; *) echo "tmux-handoff.sh: TUI_MODE must be fullscreen or regular" >&2; exit 2 ;; esac
case "$DRIVER" in curl | browser) ;; *) echo "tmux-handoff.sh: DRIVER must be curl or browser" >&2; exit 2 ;; esac
if [ "$DRIVER" = browser ] && [ -z "${PLAYWRIGHT_CORE:-}" ]; then
	echo "tmux-handoff.sh: PLAYWRIGHT_CORE is required for DRIVER=browser." >&2
	usage
	exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-18734}
ANNOTATE_PORT=${ANNOTATE_PORT:-4747}
SCREENSHOTS=${SCREENSHOTS:-$WORK/screenshots}
CHROME_BIN=${CHROME_BIN:-$(command -v google-chrome || true)}
PLAYWRIGHT_CORE=${PLAYWRIGHT_CORE:-}
S=annotate-handoff-$$
PI_HOME=$WORK/home
export WORK PORT ANNOTATE_PORT SCREENSHOTS S HERE ROOT PI_BIN TUI_MODE DRIVER PLAYWRIGHT_CORE CHROME_BIN PI_HOME
mkdir -p "$PI_HOME/.pi/agent" "$WORK/project" "$WORK/captures"
rm -f "$WORK/editor.json" "$WORK/browser-"* "$WORK/browser.pid"

node "$HERE/fake-openai.mjs" "$PORT" >"$WORK/fake.log" 2>&1 &
FAKE_PID=$!
cleanup() {
	tmux kill-session -t "$S" 2>/dev/null || true
	kill "$FAKE_PID" 2>/dev/null || true
	if [ -f "$WORK/browser.pid" ]; then
		read -r browser_pid < "$WORK/browser.pid"
		kill -TERM "-$browser_pid" 2>/dev/null || true
	fi
	return 0
}
trap cleanup EXIT

cat >"$PI_HOME/.pi/agent/models.json" <<JSON
{ "providers": { "fake": { "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "fake", "models": [{ "id": "fake-model", "name": "Fake model" }] } } }
JSON

echo "pi $(HOME=$PI_HOME "$PI_BIN/pi" --version 2>/dev/null), $TUI_MODE, driver $DRIVER, in $WORK"
tmux new-session -d -s "$S" -n pi -x 120 -y 50 -c "$WORK/project" \
	"export HOME='$PI_HOME' PATH='$PI_BIN:$PATH' TERM=xterm-256color PI_ANNOTATE_PORT='$ANNOTATE_PORT' ANNOTATE_EDITOR_PROBE='$WORK/editor.json'; unset PI_CODING_AGENT_DIR SSH_CONNECTION DISPLAY; pi --tui-mode $TUI_MODE --provider fake --model fake-model --extension '$ROOT/extensions/annotation/index.ts' --extension '$ROOT/extensions/resume-handoff/index.ts' --extension '$HERE/editor-probe.ts'; echo PI_EXITED \$?; sleep 600"

set +e
python3 - <<'PY'
import atexit, glob, http.client, json, os, re, shlex, signal, socket, subprocess, sys, time, urllib.request
from urllib.parse import urlparse, parse_qs

S, WORK, PORT, DRIVER = os.environ["S"], os.environ["WORK"], os.environ["PORT"], os.environ["DRIVER"]
HERE, ROOT, SHOTS = os.environ["HERE"], os.environ["ROOT"], os.environ["SCREENSHOTS"]
PI_HOME, PI_BIN = os.environ["PI_HOME"], os.environ["PI_BIN"]
BASE = int(os.environ["ANNOTATE_PORT"])
CAP = f"{WORK}/captures"
BROWSER = None
failures = 0

def cleanup_browser():
    if BROWSER and BROWSER.poll() is None:
        try:
            os.killpg(BROWSER.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

atexit.register(cleanup_browser)

def check(name, ok, detail=""):
    global failures
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  [{detail}]"), flush=True)
    failures += 0 if ok else 1

def tmux(*args):
    return subprocess.run(["tmux", *args], check=True, capture_output=True, text=True).stdout

def cap(window="pi", name=None):
    target = f"{S}:{window}"
    text = tmux("capture-pane", "-p", "-J", "-t", target, "-S", "-200")
    if name:
        open(f"{CAP}/{name}-{window}.txt", "w").write(text)
        open(f"{CAP}/{name}-{window}.ansi", "w").write(tmux("capture-pane", "-p", "-e", "-t", target))
    return text

def keys(window, *values):
    tmux("send-keys", "-t", f"{S}:{window}", *values)

def text(window, value):
    tmux("send-keys", "-t", f"{S}:{window}", "-l", value)
    time.sleep(0.4)

def command(value):
    text("pi", value)
    keys("pi", "Enter")

def wait(predicate, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    return predicate()

def requests():
    return int(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/count", timeout=3).read())

def editor():
    try:
        with open(f"{WORK}/editor.json") as source:
            return json.load(source)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

def editor_text():
    return (editor() or {}).get("editor")

def opened_urls():
    return re.findall(r"Browser: (http://127\.0\.0\.1:\d+/[\w-]+#t=[\w-]+)", cap())

def registry_entries():
    entries = []
    for path in glob.glob(f"{PI_HOME}/.pi/agent/annotation/sessions/*.json"):
        with open(path) as source:
            entries.append(json.load(source))
    return entries

def port_free(port):
    probe = socket.socket()
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind(("127.0.0.1", port))
        probe.listen(1)
        return True
    except OSError:
        return False
    finally:
        probe.close()

def call(port, method, path, headers=None, body=None, timeout=5):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.read().decode()
    except (ConnectionError, OSError, http.client.HTTPException) as error:
        return None, str(error)
    finally:
        conn.close()

def note_count(screen):
    found = re.search(r"(\d+) notes?\s+[●○]\s+(?:live|closed)", screen)
    return int(found.group(1)) if found else None

def browser_started(ready_file):
    return os.path.exists(ready_file) or (BROWSER is not None and BROWSER.poll() is not None)

def terminal_followed(session_id):
    screen = cap("terminal")
    return screen if "pi moved to a new session; notes kept" in screen and session_id[-8:] in screen else None

wait(lambda: editor() is not None, 40)
time.sleep(1)
cap(name="00-start")
check("pi started with annotation, resume-handoff and the editor probe", editor() is not None and "PI_EXITED" not in cap(), cap()[-600:])
text("pi", "Please inspect the cache stats.")
keys("pi", "Enter")
check("the fake model answered the initial prompt", bool(wait(lambda: requests() >= 2 and "The cache is LRU." in cap(), 30)), f"{requests()} requests")
old_session = (editor() or {}).get("session")
check("the editor probe reports the source session", bool(old_session), repr(editor()))

hold = socket.socket()
hold.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    hold.bind(("127.0.0.1", BASE))
    hold.listen(1)
    held = True
except OSError:
    held = False
command("/annotate")
url = wait(lambda: (opened_urls() or [None])[0], 10)
notice = cap()
flat_notice = re.sub(r"[ \t]*\n[ \t]*", "", notice)
terminal_match = re.search(r"Terminal:(.*?)" + re.escape(old_session), flat_notice)
terminal_command = terminal_match.group(1).strip() + " " + old_session if terminal_match else None
hold.close()
check("/annotate printed the browser URL and terminal attach command", bool(url and terminal_command), repr((url, terminal_command)))
if not url or not terminal_command:
    print(notice[-1500:])
    sys.exit(1)
parsed = urlparse(url)
old_path = parsed.path.lstrip("/")
old_token = parse_qs(parsed.fragment)["t"][0]
port = parsed.port
old_entry = wait(lambda: next((entry for entry in registry_entries() if entry["sessionId"] == old_session), None), 10)
check("the registry records the source session and server", bool(old_entry) and old_entry["port"] == port and old_entry["token"] == old_token, repr(old_entry))
check("the annotate server started on the expected port", port == BASE + 1 if held else BASE <= port <= BASE + 9, port)

attach = f"export HOME={shlex.quote(PI_HOME)} PATH={shlex.quote(PI_BIN + os.pathsep + os.environ['PATH'])} TERM=xterm-256color; unset PI_CODING_AGENT_DIR SSH_CONNECTION DISPLAY; exec {terminal_command}"
tmux("new-window", "-d", "-t", S, "-n", "terminal", "-c", f"{WORK}/project", attach)
terminal_ready = wait(lambda: "pi-annotation" in cap("terminal") and "live" in cap("terminal"), 20)
check("the printed terminal command attached in a second tmux window", bool(terminal_ready), cap("terminal")[-800:])
keys("terminal", "G")
time.sleep(0.2)
keys("terminal", "A")
time.sleep(0.3)
text("terminal", "terminal handoff note")
keys("terminal", "Enter")
terminal_before = wait(lambda: note_count(cap("terminal")), 10)
cap("terminal", "01-terminal-note")
check("the terminal view has one unsent note", terminal_before == 1, cap("terminal")[-600:])

browser_ready = f"{WORK}/browser-follow-ready"
browser_go = f"{WORK}/browser-follow-go"
if DRIVER == "browser":
    BROWSER = subprocess.Popen(
        ["node", f"{HERE}/browser.mjs", "followed", url, SHOTS, browser_ready, browser_go],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    with open(f"{WORK}/browser.pid", "w") as target:
        target.write(str(BROWSER.pid) + "\n")
    ready = wait(lambda: browser_started(browser_ready), 90)
    check("browser: a note is ready before the handoff", ready and os.path.exists(browser_ready), BROWSER.stderr.read()[-1200:] if BROWSER.poll() is not None else "")

handoff_path = f"{WORK}/handoff.md"
with open(handoff_path, "w") as handoff:
    handoff.write("Continue from this handoff in the replacement session.\n")
check("the handoff input is a non-empty regular file", os.path.isfile(handoff_path) and os.path.getsize(handoff_path) > 0, handoff_path)
command("/resume-handoff " + shlex.quote(handoff_path))
replacement = wait(lambda: (current := editor()) and current.get("session") != old_session and current, 30)
new_session = (replacement or {}).get("session")
check("/resume-handoff created a replacement session", bool(new_session), repr(replacement))
if not new_session:
    cap("pi", "02-handoff-failed")
    cap("terminal", "02-handoff-failed")
    sys.exit(1)

notice = wait(lambda: "annotate: followed to this session" in cap() and f"Browser: http://127.0.0.1:{port}/" in cap(), 15)
check("pi showed the annotation follow notice", bool(notice), cap()[-1000:])
new_entry = wait(lambda: next((entry for entry in registry_entries() if entry["pid"] == old_entry["pid"]), None), 10)
check("the registry now names the new session with a different token and the same port", bool(new_entry) and new_entry["sessionId"] == new_session and new_entry["token"] != old_token and new_entry["port"] == port, repr(new_entry))
status, snapshot_body = call(port, "GET", f"/{new_session}/api/snapshot", {"Host": f"127.0.0.1:{port}", "X-Annotate-Token": (new_entry or {}).get("token", "")})
check("the same server port serves the replacement session", status == 200 and json.loads(snapshot_body).get("sessionId") == new_session, f"{status} {snapshot_body[:500]}")

terminal_after = wait(lambda: terminal_followed(new_session), 20)
count_after = note_count(terminal_after or cap("terminal"))
check("the terminal title shows the new session id suffix", bool(terminal_after) and new_session[-8:] in terminal_after, (terminal_after or cap("terminal"))[-800:])
check("the terminal view shows the handoff message", bool(terminal_after) and "pi moved to a new session; notes kept" in terminal_after, (terminal_after or cap("terminal"))[-800:])
check("the terminal note count is unchanged", terminal_before == 1 and count_after == terminal_before, f"{terminal_before} -> {count_after}")
cap("terminal", "03-followed")

old_status, old_body = call(port, "GET", f"/{old_path}/api/snapshot", {"Host": f"127.0.0.1:{port}", "X-Annotate-Token": old_token})
try:
    old_response = json.loads(old_body)
except json.JSONDecodeError:
    old_response = {}
check("the old token on the old path gets 410 with the replacement successor", old_status == 410 and old_response.get("successor", {}).get("sessionId") == new_session and old_response.get("successor", {}).get("token") == (new_entry or {}).get("token"), f"{old_status} {old_response}")

if DRIVER == "browser":
    with open(browser_go, "w") as release:
        release.write("go")
    out, err = BROWSER.communicate(timeout=90)
    result = json.loads(out.strip().split("\n")[-1]) if BROWSER.returncode == 0 and out.strip() else {}
    browser_checks = result.get("checks", {})
    followed = browser_checks.get("followed", {})
    sent = browser_checks.get("followedSend", {})
    check("browser: the same tab changed to the replacement session path", followed.get("pathChanged") is True and followed.get("tabs") == 1, followed)
    check("browser: the unsent annotation stayed in the list", followed.get("listKept") is True and followed.get("count") == 1 and followed.get("notes") == ["browser handoff note"], followed)
    check("browser: Send was enabled after following", followed.get("sendEnabled") is True and followed.get("sendDisabled") is False, followed)
    check("browser: sending after following reached the editor probe", bool(wait(lambda: "browser handoff note" in (editor_text() or ""), 10)) and (editor() or {}).get("session") == new_session, repr(editor()))
    check("browser: the follow-up send completed", sent.get("accepted") is True and sent.get("count") == 0, sent)
    check("browser: no page errors", result.get("errors") == [], result.get("errors") or err[-1200:])
    print("screenshots: " + " ".join(result.get("screenshots", [])))
    cap("pi", "04-browser-send")
    if "browser handoff note" in (editor_text() or ""):
        keys("pi", "C-c")
        wait(lambda: editor_text() == "", 5)

terminal_note = "terminal handoff note"
keys("terminal", "s")
terminal_sent = wait(lambda: terminal_note in (editor_text() or "") and (editor() or {}).get("session") == new_session, 3)
if not terminal_sent:
    conflict = wait(lambda: "another client sent first; your notes are kept" in cap("terminal"), 5)
    check("the terminal kept its note when the browser advanced the send sequence", bool(conflict) and note_count(cap("terminal")) == 1, cap("terminal")[-600:])
    if conflict:
        keys("terminal", "s")
        terminal_sent = wait(lambda: terminal_note in (editor_text() or "") and (editor() or {}).get("session") == new_session, 10)
check("sending with s from the terminal view inserts the note into the replacement session editor", bool(terminal_sent), repr(editor()))
cap("terminal", "05-terminal-send")
cap("pi", "05-terminal-send")
keys("pi", "C-c")
editor_cleared = wait(lambda: editor_text() == "", 5)
check("the test cleared the editor before /new", bool(editor_cleared), repr(editor()))

command("/new")
closed = wait(lambda: port_free(port) and "○ closed" in cap("terminal"), 20)
check("a plain /new releases the annotation server port", bool(wait(lambda: port_free(port), 5)), port)
check("a plain /new closes the terminal view", bool(closed), cap("terminal")[-800:])
check("pi is still running after /new", "PI_EXITED" not in cap())
cap("pi", "06-new-session")
cap("terminal", "06-new-session")
print(f"captures: {CAP}")
print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
status=$?
set -e

echo "captures: $WORK/captures"
if [ "$status" -eq 0 ] && [ -z "$KEEP_WORK" ]; then rm -rf "$WORK"; echo "(removed $WORK)"; fi
exit "$status"
