#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotate in a real pi under tmux with a fake local model. Checks the notice with the
browser URL and the terminal command, port fallback and request checks, sends several rounds
of annotations, checks the editor and that the model got no new request, checks live updates
after a new reply and after /tree, the long-poll limit, that a second /annotate stops the
server and a third starts a new one, that an old page is rejected after /new, and that
/annotation-end is not a command.

Usage:
  PI_BIN=~/.local/pi-1.1.0/bin extensions/annotation/test/e2e/tmux-annotate.sh

Environment:
  PI_BIN            required. Directory that holds the pi executable.
  TUI_MODE          fullscreen (default) or regular, passed to pi --tui-mode.
  DRIVER            curl (default) submits with HTTP requests; browser drives the page
                    in headless Chromium with browser.mjs and saves screenshots.
  PLAYWRIGHT_CORE   for DRIVER=browser: path to an installed playwright-core package.
  CHROME_BIN        for DRIVER=browser: Chrome or Chromium executable.
  SCREENSHOTS       for DRIVER=browser: screenshot directory. Default: $WORK/screenshots.
  WORK              throwaway HOME, project and captures. Default: a new mktemp -d
                    directory, removed after a passing run. A WORK you set is kept.
  PORT              port of the fake model. Default: 18734.
  ANNOTATE_PORT     passed to pi as PI_ANNOTATE_PORT. Default: 4747. The test holds this
                    port while pi starts the first server, so pi must fall back to the
                    next one.

Needs tmux, python3 and node.
TXT
}

if [ -z "${PI_BIN:-}" ]; then
	echo "tmux-annotate.sh: PI_BIN is not set." >&2
	usage
	exit 2
fi
if [ ! -x "$PI_BIN/pi" ]; then
	echo "tmux-annotate.sh: no pi executable in $PI_BIN" >&2
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in tmux python3 node; do
	command -v "$tool" >/dev/null || { echo "tmux-annotate.sh: $tool not found" >&2; exit 2; }
done
TUI_MODE=${TUI_MODE:-fullscreen}
DRIVER=${DRIVER:-curl}
case "$TUI_MODE" in fullscreen | regular) ;; *) echo "tmux-annotate.sh: TUI_MODE must be fullscreen or regular" >&2; exit 2 ;; esac
case "$DRIVER" in curl | browser) ;; *) echo "tmux-annotate.sh: DRIVER must be curl or browser" >&2; exit 2 ;; esac

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-18734}
ANNOTATE_PORT=${ANNOTATE_PORT:-4747}
SCREENSHOTS=${SCREENSHOTS:-$WORK/screenshots}
S=annotate-e2e-$$
export WORK PORT ANNOTATE_PORT S HERE ROOT PI_BIN TUI_MODE DRIVER SCREENSHOTS
PI_HOME=$WORK/home
mkdir -p "$PI_HOME/.pi/agent" "$WORK/project" "$WORK/captures"
rm -f "$WORK/editor.json"

node "$HERE/fake-openai.mjs" "$PORT" >"$WORK/fake.log" 2>&1 &
FAKE_PID=$!
cleanup() {
	tmux kill-session -t "$S" 2>/dev/null || true
	kill "$FAKE_PID" 2>/dev/null || true
}
trap cleanup EXIT

cat >"$PI_HOME/.pi/agent/models.json" <<JSON
{ "providers": { "fake": { "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "fake", "models": [{ "id": "fake-model", "name": "Fake model" }] } } }
JSON

echo "pi $(HOME=$PI_HOME "$PI_BIN/pi" --version 2>/dev/null), $TUI_MODE, driver $DRIVER, in $WORK"
tmux new-session -d -s "$S" -x 120 -y 50 -c "$WORK/project" \
	"export HOME='$PI_HOME' PATH='$PI_BIN:$PATH' TERM=xterm-256color PI_ANNOTATE_PORT='$ANNOTATE_PORT' ANNOTATE_EDITOR_PROBE='$WORK/editor.json'; unset PI_CODING_AGENT_DIR SSH_CONNECTION DISPLAY; pi --tui-mode $TUI_MODE --provider fake --model fake-model --extension '$ROOT/index.ts' --extension '$HERE/editor-probe.ts'; echo PI_EXITED \$?; sleep 600"

set +e
python3 - <<'PY'
import http.client, json, os, re, socket, subprocess, sys, threading, time, urllib.request
from urllib.parse import urlparse, parse_qs

S, WORK, PORT, DRIVER = os.environ["S"], os.environ["WORK"], os.environ["PORT"], os.environ["DRIVER"]
HERE, SHOTS = os.environ["HERE"], os.environ["SCREENSHOTS"]
BASE = int(os.environ["ANNOTATE_PORT"])
CAP = f"{WORK}/captures"
failures = 0

def check(name, ok, detail=""):
    global failures
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  [{detail}]"), flush=True)
    failures += 0 if ok else 1

def tmux(*args):
    return subprocess.run(["tmux", *args], check=True, capture_output=True, text=True).stdout

def cap(name=None):
    text = tmux("capture-pane", "-p", "-J", "-t", S, "-S", "-200")
    if name:
        open(f"{CAP}/{name}.txt", "w").write(text)
        open(f"{CAP}/{name}.ansi", "w").write(tmux("capture-pane", "-p", "-e", "-t", S))
    return text

def keys(*k): tmux("send-keys", "-t", S, *k)
def text(s): tmux("send-keys", "-t", S, "-l", s); time.sleep(0.4)
def footer_line():
    lines = [l for l in tmux("capture-pane", "-p", "-J", "-t", S).split("\n") if l.strip()]
    return lines[-1] if lines else ""

def wait(pred, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        value = pred()
        if value:
            return value
        time.sleep(0.25)
    return pred()

def requests():
    return int(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/count").read())

def editor():
    try:
        return json.load(open(f"{WORK}/editor.json"))
    except Exception:
        return None

def editor_text():
    return (editor() or {}).get("editor")

def clear_editor():
    if editor_text():
        keys("C-c")
    wait(lambda: editor_text() == "", 5)

URL_RE = re.compile(r"Browser: (http://127\.0\.0\.1:\d+/[\w-]+#t=[\w-]+)")

def opened_urls():
    return URL_RE.findall(cap())

def command(line):
    text(line); keys("Enter")

def call(port, method, path, headers=None, body=None, timeout=5):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, resp.read().decode()
    except (ConnectionError, OSError, http.client.HTTPException) as error:
        return None, str(error)
    finally:
        conn.close()

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

def alive():
    return "PI_EXITED" not in cap()

class Page:
    def __init__(self, url):
        parsed = urlparse(url)
        self.url, self.port, self.sid = url, parsed.port, parsed.path.lstrip("/")
        self.token = parse_qs(parsed.fragment)["t"][0]
        self.base = f"/{self.sid}/api"

    def headers(self, **extra):
        return {"Host": f"127.0.0.1:{self.port}", "X-Annotate-Token": self.token, **extra}

    def snapshot(self):
        status, body = call(self.port, "GET", f"{self.base}/snapshot", self.headers())
        return status, json.loads(body) if status == 200 else body

    def send(self, seq, items):
        status, body = call(self.port, "POST", f"{self.base}/send", self.headers(**{"Content-Type": "application/json"}), json.dumps({"seq": seq, "items": items}))
        try:
            return status, json.loads(body)
        except Exception:
            return status, body

    def events(self, after, timeout=35):
        started = time.time()
        status, body = call(self.port, "GET", f"{self.base}/events?after={after}", self.headers(), timeout=timeout)
        try:
            body = json.loads(body)
        except Exception:
            pass
        return status, body, time.time() - started

    def poll_in_background(self, after):
        box = {}
        thread = threading.Thread(target=lambda: box.update(result=self.events(after)), daemon=True)
        thread.start()
        time.sleep(0.4)
        return thread, box

def collect_until(page, version, needle, seen, timeout=40):
    seen = list(seen)
    if any(needle in item["text"] for item in seen):
        return seen, version, 200
    end = time.time() + timeout
    while time.time() < end:
        status, body, _ = page.events(version)
        if status != 200:
            return seen, version, status
        seen += body["items"]
        version = body["version"]
        if any(needle in item["text"] for item in seen):
            break
    return seen, version, 200

wait(lambda: editor() is not None, 40)
time.sleep(2)
cap("00-start")
check("pi started with the annotation extension", editor() is not None and alive(), cap()[-600:])

text("Check the cache <img src=x onerror=window.__pwned=1>"); keys("Enter")
check("the fake model answered after a tool call", wait(lambda: requests() >= 2 and "It evicts the oldest entry first." in cap(), 30), f"{requests()} requests")
time.sleep(1)
before = requests()
cap("01-reply")

hold = socket.socket()
hold.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    hold.bind(("127.0.0.1", BASE)); hold.listen(1); held = True
except OSError:
    held = False
command("/annotate")
urls = wait(lambda: opened_urls(), 10)
hold.close()
check("/annotate printed the notice with the browser URL and the terminal command", len(urls) == 1 and "Terminal: " in cap(), repr(urls))
if not urls:
    print(cap()[-1500:]); sys.exit(1)
url = urls[0]
page = Page(url)
session = (editor() or {}).get("session")
parsed = urlparse(url)
check("the URL is http://127.0.0.1:<port>/<session id>#t=<token> with no query", parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and page.sid == session and parsed.query == "" and len(page.token) >= 32, url)
check(f"pi fell back to the next port while {BASE} was busy" if held else f"pi used a port from {BASE} up ({BASE} was already busy)", page.port == BASE + 1 if held else BASE <= page.port <= BASE + 9, page.port)
screen = cap("02-annotate")
flat = screen.replace("\n", "")
check("the TUI shows the URL and how to stop it", url in flat and "Run/annotateagaintostopit." in "".join(screen.split()), screen[-800:])
check("the status line shows the live server", f"annotate: live on 127.0.0.1:{page.port}" in footer_line())
check("the editor is empty and still usable", editor_text() == "")

status, snap = page.snapshot()

kinds = [i["kind"] for i in snap.get("items", [])] if status == 200 else []
check("the snapshot has user, assistant and tool items", kinds == ["user", "assistant", "tool", "assistant"], f"{status} {kinds}")
check("tool output is in the snapshot", any(i["kind"] == "tool" and "cache-hit-ratio 0.93" in i["text"] for i in snap.get("items", [])))
check("the snapshot starts at seq 1", status == 200 and snap.get("nextSeq") == 1 and snap.get("sessionId") == session, snap if status == 200 else "")
version = snap.get("version", 0) if status == 200 else 0

good = json.dumps({"seq": 1, "items": [{"quote": "The cache is LRU.", "note": "why LRU?"}]})
json_headers = page.headers(**{"Content-Type": "application/json"})
send_path = f"{page.base}/send"
status, _ = call(page.port, "POST", send_path, {k: v for k, v in json_headers.items() if k != "X-Annotate-Token"}, good)
check("send without the token is rejected (403)", status == 403, status)
status, _ = call(page.port, "POST", send_path, {**json_headers, "X-Annotate-Token": page.token[:-2] + "xx"}, good)
check("send with a wrong token is rejected (403)", status == 403, status)
status, _ = call(page.port, "POST", send_path, {**json_headers, "Host": f"localhost:{page.port}"}, good)
check("send with a wrong Host is rejected (403)", status == 403, status)
status, _ = call(page.port, "POST", send_path, {**json_headers, "Host": f"127.0.0.1:{page.port + 1}"}, good)
check("send with the Host of another port is rejected (403)", status == 403, status)
status, _ = call(page.port, "POST", send_path, {**json_headers, "Content-Type": "text/plain"}, good)
check("send with a wrong Content-Type is rejected (415)", status == 415, status)
status, _ = call(page.port, "POST", send_path, json_headers, json.dumps({"seq": 1, "items": [{"quote": "x" * (1024 * 1024), "note": ""}]}))
check("send with a body over 1 MB is rejected (413)", status == 413, status)
status, _ = call(page.port, "GET", f"{page.base}/snapshot?t={page.token}", {"Host": f"127.0.0.1:{page.port}"})
check("the token as a query parameter is not accepted (403)", status == 403, status)
status, _ = call(page.port, "GET", f"{page.base}/snapshot?token={page.token}", {"Host": f"127.0.0.1:{page.port}"})
check("the token as ?token= is not accepted (403)", status == 403, status)
bad = [call(page.port, "GET", path, page.headers())[0] for path in ("/%E0", "/%E0/api/snapshot", "/%E0/api/events?after=1", f"/{page.sid}/api/events?after=%E0")]
check("malformed paths get 400 and pi keeps running", bad == [400, 400, 400, 400] and alive() and page.snapshot()[0] == 200, bad)
status, _ = call(page.port, "GET", "/not-this-session/api/snapshot", page.headers())
check("another session id in the path gets 410", status == 410, status)
status, body = call(page.port, "GET", f"/{page.sid}", {"Host": f"127.0.0.1:{page.port}"})
check("the page itself loads without the token and holds no conversation", status == 200 and "<script" in body and "cache-hit-ratio" not in body, status)
time.sleep(0.5)
check("nothing was inserted by the rejected sends", editor_text() == "", repr(editor()))

text("Please review:")
wait(lambda: editor_text() == "Please review:", 5)
keys("Home"); time.sleep(0.3)

browser = None
ready1, ready2, go2 = f"{WORK}/browser-ready-1", f"{WORK}/browser-ready-2", f"{WORK}/browser-go-2"
for f in (ready1, ready2, go2):
    if os.path.exists(f): os.remove(f)
if DRIVER == "browser":
    browser = subprocess.Popen(["node", f"{HERE}/browser.mjs", "live", url, SHOTS, ready1, ready2, go2], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("browser: two rounds were sent from the page", wait(lambda: os.path.exists(ready1) or browser.poll() is not None, 90) and os.path.exists(ready1), browser.stderr.read()[-1500:] if browser.poll() is not None else "")
    expected = "Please review:\n> The cache is LRU.\n\nwhy LRU and not LFU?\n\n> cache-hit-ratio 0.93\n\nline one\nline two\n\n> It evicts the oldest entry first.\n\nround two\n\n"
else:
    round1 = [{"quote": "The cache is LRU.", "note": "why LRU?"}, {"quote": "cache-hit-ratio 0.93", "note": "line one\nline two"}]
    round2 = [{"quote": "It evicts the oldest entry first.", "note": "round two"}]
    status, body = page.send(1, round1)
    check("round 1 (seq 1) is accepted", status == 200 and body == {"ok": True, "inserted": 2, "seq": 1, "nextSeq": 2}, f"{status} {body}")
    wait(lambda: "line two" in (editor_text() or ""), 5)
    status, body = page.send(2, round2)
    check("round 2 (seq 2) is accepted", status == 200 and body.get("nextSeq") == 3, f"{status} {body}")
    status, body = page.send(2, round2)
    check("a repeated seq is rejected (409) with the expected seq", status == 409 and body.get("expectedSeq") == 3, f"{status} {body}")
    status, body = page.send(1, round2)
    check("an old seq is rejected (409)", status == 409, f"{status} {body}")
    status, body = page.send(5, round2)
    check("a skipped seq is rejected (409)", status == 409, f"{status} {body}")
    expected = "Please review:\n> The cache is LRU.\n\nwhy LRU?\n\n> cache-hit-ratio 0.93\n\nline one\nline two\n\n> It evicts the oldest entry first.\n\nround two\n\n"

got = wait(lambda: editor_text() == expected, 8)
check("both rounds are appended after the draft in order, once each, though the cursor was at the start", bool(got), repr(editor_text()))
time.sleep(1)
screen = cap("03-inserted")
shown = [l.rstrip() for l in screen.split("\n")]
wanted = [l for l in expected.split("\n") if l]
appended = expected[len("Please review:"):].split("\n")
check(f"the {len(appended)}-line insert is shown in full in the input box, without a [paste # marker", len(appended) > 10 and all(l in shown for l in wanted) and "[paste #" not in screen and "more ─" not in screen, screen[-1500:])
time.sleep(1.5)
check("the model received no request from the sends", requests() == before, f"{requests()} vs {before}")
status, snap = page.snapshot()
check("the server is still running after the sends", status == 200 and snap.get("nextSeq") == 3, f"{status} {snap if status == 200 else ''}")
version = snap.get("version", version) if status == 200 else version

clear_editor()
thread, box = page.poll_in_background(version)
text("And eviction?"); keys("Enter")
thread.join(30)
status, body, took = box.get("result", (None, None, 0))
check("a pending long-poll is answered when the user message is finished", status == 200 and any(i["kind"] == "user" and "And eviction?" in i["text"] for i in body["items"]) and body["reset"] is False, f"{status} {body}")
seen, version, status = collect_until(page, body["version"] if status == 200 else version, "Eviction runs on every insert.", body["items"] if status == 200 else [])
check("the long-poll delivers the new assistant reply as an append", status == 200 and any(i["kind"] == "assistant" and i["text"] == "Eviction runs on every insert.\nOld keys leave in order." for i in seen), f"{status} {seen}")
before = requests()
check("the new prompt reached the model once", before >= 3)
status, snap = page.snapshot()
check("the snapshot now ends with the new reply", status == 200 and snap["items"][-1]["text"].startswith("Eviction runs") and len(snap["items"]) == 6, [i["text"][:20] for i in snap.get("items", [])] if status == 200 else status)
cap("04-live-update")

if browser:
    check("browser: round 3 was sent after the live update", wait(lambda: os.path.exists(ready2) or browser.poll() is not None, 90) and os.path.exists(ready2))
    third = "> Old keys leave in order.\n\nround three\n\n"
else:
    status, body = page.send(3, [{"quote": "Old keys leave in order.", "note": "round three"}])
    check("round 3 (seq 3) is accepted after the live update", status == 200 and body.get("nextSeq") == 4, f"{status} {body}")
    third = "> Old keys leave in order.\n\nround three\n\n"
check("round 3 lands in the empty editor", bool(wait(lambda: editor_text() == third, 8)), repr(editor_text()))
clear_editor()

status, snap = page.snapshot()
version = snap["version"]
thread, box = page.poll_in_background(version)
command("/probe-tree Checking the cache stats.")
thread.join(30)
status, body, took = box.get("result", (None, None, 0))
check("/tree to an earlier entry pushes a full reset", status == 200 and body["reset"] is True and [i["kind"] for i in body["items"]] == ["user", "assistant"], f"{status} {body}")
check("the reset came right away", took < 5, took)
cap("05-tree")
if browser:
    open(go2, "w").write("go")
    out, err = browser.communicate(timeout=90)
    result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 else {}
    check("the browser flow finished", browser.returncode == 0, err[-1500:])
    checks = result.get("checks", {})
    check("browser: <img onerror> in the conversation is inert text", checks.get("xssInert") == {"images": 0, "pwned": "undefined", "literal": True}, checks.get("xssInert"))
    check("browser: the token is removed from the address bar", checks.get("tokenRemoved") is True, checks.get("href"))
    check("browser: tool output is collapsed until clicked", checks.get("toolCollapsed") is True and checks.get("toolExpanded") is True)
    check("browser: the composer quotes exactly the dragged text", result.get("selected", [])[:2] == ["The cache is LRU.", "cache-hit-ratio 0.93"], result.get("selected"))
    check("browser: the selection stays highlighted while the note box has focus", checks.get("highlightWhileOpen") == ["The cache is LRU."] and checks.get("focusInNote") is True and checks.get("highlightBeforeEsc") == ["oldest entry"], checks)
    check("browser: the highlight is gone after Enter and after Esc", checks.get("highlightAfterEnter") is None and checks.get("highlightAfterEsc") is None, checks)
    check("browser: Esc discards, Delete removes", checks.get("escDiscarded") is True and checks.get("listCount") == 2)
    check("browser: after each send the list is cleared and the page stays open", checks.get("afterRound1") == {"count": 0, "round": True, "sendDisabled": True, "messages": 4} and checks.get("afterRound2", {}).get("count") == 0 and checks.get("afterRound2", {}).get("round") is True, (checks.get("afterRound1"), checks.get("afterRound2")))
    check("browser: the new reply appears on the open page without a reload", checks.get("liveUpdate") == {"messages": 6, "last": "Eviction runs on every insert.\nOld keys leave in order.", "status": True}, checks.get("liveUpdate"))
    check("browser: round 3 from the new message", checks.get("afterRound3", {}).get("round") is True and result.get("selected", [])[-1] == "Old keys leave in order.", (checks.get("afterRound3"), result.get("selected")))
    check("browser: /tree resets the page to the new branch", checks.get("treeReset") == {"messages": 2, "status": True}, checks.get("treeReset"))
    check("browser: no page errors", result.get("errors") == [], result.get("errors"))
    print("screenshots: " + " ".join(result.get("screenshots", [])))

status, snap = page.snapshot()
version = snap["version"]
pollers = [page.poll_in_background(version) for _ in range(4)]
status, body, took = page.events(version, timeout=5)
check("a 5th concurrent long-poll gets 429", status == 429 and took < 2, f"{status} {took}")
shown = set(opened_urls())
started = time.time()
command("/annotate")
for thread, _ in pollers:
    thread.join(10)
ends = [box.get("result", (None, None, 99)) for _, box in pollers]
check("a second /annotate ends all pending long-polls at once", all(s is None for s, _, _ in ends) and time.time() - started < 3, [(s, round(t, 2)) for s, _, t in ends])
check("a second /annotate releases the port", bool(wait(lambda: port_free(page.port), 3)), page.port)
check("a second /annotate says the server closed and the port was released", bool(wait(lambda: f"annotate: closed, port {page.port} released" in cap(), 5)), cap()[-600:])
check("a second /annotate printed no new browser URL", set(opened_urls()) <= shown, repr(opened_urls()))
check("the status line no longer shows the server", bool(wait(lambda: "annotate: live on" not in footer_line(), 5)))
cap("06-end")
check("the model received no new request", requests() == before, f"{requests()} vs {before}")

def annotate_again():
    seen = set(opened_urls())
    command("/annotate")
    urls = wait(lambda: [u for u in opened_urls() if u not in seen], 10)
    return Page(urls[-1])

fresh = annotate_again()
check("a third /annotate starts a new server with a new token", fresh.token != page.token and fresh.sid == page.sid and (fresh.port == BASE or not held), fresh.url)
status, _ = call(fresh.port, "GET", f"{fresh.base}/snapshot", {"Host": f"127.0.0.1:{fresh.port}", "X-Annotate-Token": page.token})
check("the old token is not accepted by the new server", status == 403, status)
seq = 1
for draft, label in [("Ends with a newline\n", "after text ending in a newline adds no extra newline"), ("", "into an empty input box starts with the quote")]:
    clear_editor()
    if draft:
        text("/probe-set-editor " + json.dumps(draft)); keys("Enter")
    ok = wait(lambda: editor_text() == draft, 5)
    status, _ = fresh.send(seq, [{"quote": "It evicts the oldest entry first.", "note": "ok"}])
    seq += 1
    want = draft + "> It evicts the oldest entry first.\n\nok\n\n"
    got = wait(lambda: editor_text() == want, 5)
    check(f"append {label}", ok and status == 200 and bool(got), f"{status} {editor_text()!r}")
clear_editor()

if DRIVER == "browser":
    ready, restarted = f"{WORK}/browser-reload-ready", f"{WORK}/browser-reload-restarted"
    for f in (ready, restarted):
        if os.path.exists(f): os.remove(f)
    browser = subprocess.Popen(["node", f"{HERE}/browser.mjs", "reload", fresh.url, SHOTS, ready, restarted], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("browser: reload, send and a fresh tab ran", wait(lambda: os.path.exists(ready) or browser.poll() is not None, 90) and os.path.exists(ready), browser.stderr.read()[-1500:] if browser.poll() is not None else "")
    got = wait(lambda: editor_text() == "> Checking the cache stats.\n\nafter reload\n\n", 5)
    check("browser: a send after reloading the tab reaches the editor", bool(got), repr(editor_text()))
    clear_editor()
    command("/annotate")
    check("browser: /annotate stopped the server", bool(wait(lambda: port_free(fresh.port), 5)))
    stale = fresh
    fresh = annotate_again()
    seq = 1
    check("browser: /annotate restarted the server with a new token", fresh.token != stale.token, fresh.url)
    open(restarted, "w").write("go")
    out, err = browser.communicate(timeout=60)
    result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 else {}
    checks = result.get("checks", {})
    key = f"annotate-token:{stale.sid}"
    stored, after = checks.get("stored", {}), checks.get("afterReload", {})
    check("browser: the token is kept only in sessionStorage under the session id", stored.get("session") == {key: stale.token} and stored.get("local") == 0 and stored.get("cookie") == "" and "#" not in stored.get("href", "#"), stored or err[-800:])
    check("browser: after a reload the page is live without the token in the URL", after.get("status", "").startswith("Live") and after.get("session") == {key: stale.token} and "#" not in after.get("href", "#"), after)
    check("browser: the reloaded tab can send", checks.get("reloadSend", {}).get("round") is True and checks.get("reloadSend", {}).get("count") == 0, checks.get("reloadSend"))
    fresh_tab = checks.get("freshTab", {})
    check("browser: a fresh tab without the fragment says it is not authorized", fresh_tab.get("status", "").startswith("Not authorized") and fresh_tab.get("sendDisabled") is True and fresh_tab.get("stored") == 0, fresh_tab)
    stale_state = checks.get("stale", {})
    check("browser: after a restart the reloaded old tab shows the stale-token message and clears the stored token", "no longer valid" in stale_state.get("status", "") and "new URL printed by /annotate" in stale_state.get("status", "") and stale_state.get("sendDisabled") is True and stale_state.get("stored") is None, stale_state)
    check("browser: the stale tab stops making requests", checks.get("staleRequests") == 0, checks.get("staleRequests"))
    check("browser: no page errors besides the rejected request", all("403" in e or "Failed to load resource" in e for e in result.get("errors", [])), result.get("errors"))
    print("screenshots: " + " ".join(result.get("screenshots", [])))
    time.sleep(0.5)
    check("browser: nothing else was inserted", editor_text() == "", repr(editor_text()))

session_before = (editor() or {}).get("session")
old = fresh
if DRIVER == "browser":
    ready, go = f"{WORK}/browser-ready", f"{WORK}/browser-go"
    for f in (ready, go):
        if os.path.exists(f): os.remove(f)
    browser = subprocess.Popen(["node", f"{HERE}/browser.mjs", "switched", old.url, SHOTS, ready, go], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("browser: page loaded and an annotation was added before the switch", wait(lambda: os.path.exists(ready), 60))
thread, box = old.poll_in_background(old.snapshot()[1]["version"])
command("/new")
switched = wait(lambda: (editor() or {}).get("session") not in (None, session_before) and editor(), 15)
check("the session switched", bool(switched), repr(editor()))
thread.join(5)
check("the session switch ends the pending long-poll", box.get("result", (0,))[0] is None, box.get("result"))
check("the session switch released the port", bool(wait(lambda: port_free(old.port), 3)))
status, _ = old.send(seq, [{"quote": "The cache is LRU.", "note": "too late"}])
check("a send while no server runs fails to connect", status is None, status)
new = annotate_again()
check("/annotate in the new session gets the new session id on the same port", new.sid == switched["session"] and new.sid != old.sid and new.port == old.port, new.url)
status, body = old.send(seq, [{"quote": "The cache is LRU.", "note": "too late"}])
check("the old tab's send gets 410 Session switched", status == 410 and "Session switched" in str(body), f"{status} {body}")
status, _, _ = old.events(0, timeout=5)
check("the old tab's long-poll gets 410", status == 410, status)
status, body = call(old.port, "GET", f"/{old.sid}", {"Host": f"127.0.0.1:{old.port}"})
check("reloading the old page path gets 410", status == 410 and "Session switched" in body, status)
if DRIVER == "browser":
    open(go, "w").write("go")
    out, err = browser.communicate(timeout=60)
    result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 else {}
    closed = result.get("closed", {})
    check("browser: when /new closes the server the page says so and keeps the list with Send disabled", closed.get("status", "").startswith("Server closed.") and closed.get("sendDisabled") is True and closed.get("count") == 1 and closed.get("notes") == ["too late"], closed)
    check("browser: the old page says the session switched", result.get("statusText") == "Session switched, run /annotate again.", result.get("statusText") or err[-800:])
    check("browser: Send is disabled afterwards", result.get("sendDisabled") is True)
    check("browser: no page errors besides failed requests", all("Failed to load resource" in e or "ERR_CONNECTION" in e for e in result.get("errors", [])), result.get("errors"))
    print("screenshots: " + " ".join(result.get("screenshots", [])))
time.sleep(1)
screen = cap("07-after-switch")
check("nothing was inserted into the new session", editor_text() == "" and "too late" not in screen, repr(editor()))
command("/annotate")
check("/annotate stops the new server too", bool(wait(lambda: port_free(new.port), 5)) and bool(wait(lambda: f"annotate: closed, port {new.port} released" in cap(), 5)))
check("the model received no new request", requests() == before, f"{requests()} vs {before}")
shown = set(opened_urls())
notices = cap().count("annotate: ")
command("/annotation-end")
got = wait(lambda: requests() == before + 1, 15)
last = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/last-user").read().decode()
check("/annotation-end is not a command: pi sends it to the model as a prompt", bool(got) and "/annotation-end" in last, f"{requests()} vs {before}, {last!r}")
check("the model's answer to /annotation-end is shown", bool(wait(lambda: "That is not a command I know." in cap(), 15)))
screen = cap("08-annotation-end")
check("/annotation-end does not start, stop or mention a server", set(opened_urls()) <= shown and port_free(new.port) and "annotate: live on" not in footer_line() and screen.count("annotate: ") <= notices, screen[-800:])
if DRIVER == "browser":
    last_page = annotate_again()
    ready = f"{WORK}/browser-closed-ready"
    browser = subprocess.Popen(["node", f"{HERE}/browser.mjs", "closed", last_page.url, SHOTS, ready], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("browser: the page loaded and an annotation is in the list", wait(lambda: os.path.exists(ready) or browser.poll() is not None, 60) and os.path.exists(ready))
    command("/annotate")
    out, err = browser.communicate(timeout=60)
    result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 else {}
    closed = result.get("closed", {})
    check("browser: after /annotate closes the server the page says so", closed.get("status", "").startswith("Server closed. Your list is kept"), closed.get("status") or err[-800:])
    check("browser: /annotate closed the server", bool(wait(lambda: port_free(last_page.port), 5)))
    check("browser: Send is disabled and the unsent list is kept", closed.get("sendDisabled") is True and closed.get("count") == 1 and closed.get("quotes") == ["That is not a command I know."] and closed.get("notes") == ["keep me"] and result.get("before", {}).get("sendDisabled") is False, closed)
    check("browser: the kept list can be selected and copied", "That is not a command I know." in closed.get("copied", "") and closed.get("notesEditable") is True, closed.get("copied"))
    check("browser: no page errors besides failed requests", all("Failed to load resource" in e or "ERR_CONNECTION" in e for e in result.get("errors", [])), result.get("errors"))
    print("screenshots: " + " ".join(result.get("screenshots", [])))
check("pi is still running", alive())
print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
status=$?
set -e

echo "captures: $WORK/captures"
if [ "$status" -eq 0 ] && [ -z "$KEEP_WORK" ]; then rm -rf "$WORK"; echo "(removed $WORK)"; fi
exit "$status"
