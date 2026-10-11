#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotate in a real pi under tmux with a fake local model, submits annotations,
checks the editor and that the model got no new request, then checks that a send
after a session switch is rejected.

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
SCREENSHOTS=${SCREENSHOTS:-$WORK/screenshots}
S=annotate-e2e-$$
export WORK PORT S HERE ROOT PI_BIN TUI_MODE DRIVER SCREENSHOTS
PI_HOME=$WORK/home
mkdir -p "$PI_HOME/.pi/agent" "$WORK/project" "$WORK/captures" "$WORK/bin"
rm -f "$WORK/opened.txt" "$WORK/editor.json"

cat >"$WORK/bin/xdg-open" <<SH
#!/bin/sh
echo "\$1" >>"$WORK/opened.txt"
SH
cp "$WORK/bin/xdg-open" "$WORK/bin/open"
chmod +x "$WORK/bin/xdg-open" "$WORK/bin/open"

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
	"export HOME='$PI_HOME' PATH='$WORK/bin:$PI_BIN:$PATH' TERM=xterm-256color ANNOTATE_EDITOR_PROBE='$WORK/editor.json'; unset PI_CODING_AGENT_DIR SSH_CONNECTION DISPLAY; pi --tui-mode $TUI_MODE --provider fake --model fake-model --extension '$ROOT/index.ts' --extension '$HERE/editor-probe.ts'; echo PI_EXITED \$?; sleep 600"

set +e
python3 - <<'PY'
import http.client, json, os, subprocess, sys, time, urllib.request
from urllib.parse import urlparse, parse_qs

S, WORK, PORT, DRIVER = os.environ["S"], os.environ["WORK"], os.environ["PORT"], os.environ["DRIVER"]
HERE, SHOTS = os.environ["HERE"], os.environ["SCREENSHOTS"]
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

def opened():
    try:
        return [l for l in open(f"{WORK}/opened.txt").read().split("\n") if l]
    except FileNotFoundError:
        return []

def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, resp.read().decode()
    except (ConnectionError, OSError) as error:
        return None, str(error)
    finally:
        conn.close()

def alive():
    return "PI_EXITED" not in cap()

wait(lambda: editor() is not None, 40)
time.sleep(2)
cap("00-start")
check("pi started with the annotation extension", editor() is not None and alive(), cap()[-600:])

text("Check the cache <img src=x onerror=window.__pwned=1>"); keys("Enter")
check("the fake model answered after a tool call", wait(lambda: requests() >= 2 and "It evicts the oldest entry first." in cap(), 30), f"{requests()} requests")
time.sleep(1)
before = requests()
cap("01-reply")

text("/annotate"); keys("Enter")
urls = wait(lambda: opened(), 10)
check("/annotate opened the browser with xdg-open", len(urls) == 1, repr(urls))
if not urls:
    print(cap()[-1500:]); sys.exit(1)
url = urls[0]
parsed = urlparse(url)
port, token = parsed.port, parse_qs(parsed.query)["token"][0]
screen = cap("02-annotate")
check("the TUI shows the URL", url in screen.replace("\n", ""), screen[-800:])
check("the TUI shows that the page is open", "annotate: page open" in screen)
check("the editor is empty and still usable", (editor() or {}).get("editor") == "")

text("/annotate"); keys("Enter")
wait(lambda: len(opened()) == 2, 10)
check("running /annotate again re-opens the same URL", opened() == [url, url], repr(opened()))

status, body = call(port, "GET", "/api/snapshot", {"Host": f"127.0.0.1:{port}", "X-Annotate-Token": token})
snap = json.loads(body) if status == 200 else {}
kinds = [i["kind"] for i in snap.get("items", [])]
check("the snapshot has user, assistant and tool items", status == 200 and kinds == ["user", "assistant", "tool", "assistant"], f"{status} {kinds}")
check("tool output is in the snapshot", any(i["kind"] == "tool" and "cache-hit-ratio 0.93" in i["text"] for i in snap.get("items", [])))

good = json.dumps({"items": [{"quote": "The cache is LRU.", "note": "why LRU?"}]})
json_headers = {"Host": f"127.0.0.1:{port}", "X-Annotate-Token": token, "Content-Type": "application/json"}
status, _ = call(port, "POST", "/api/send", {k: v for k, v in json_headers.items() if k != "X-Annotate-Token"}, good)
check("send without the token is rejected (403)", status == 403, status)
status, _ = call(port, "POST", "/api/send", {**json_headers, "X-Annotate-Token": token[:-2] + "xx"}, good)
check("send with a wrong token is rejected (403)", status == 403, status)
status, _ = call(port, "POST", "/api/send", {**json_headers, "Host": f"localhost:{port}"}, good)
check("send with a wrong Host is rejected (403)", status == 403, status)
status, _ = call(port, "POST", "/api/send", {**json_headers, "Content-Type": "text/plain"}, good)
check("send with a wrong Content-Type is rejected (415)", status == 415, status)
status, _ = call(port, "POST", "/api/send", json_headers, json.dumps({"items": [{"quote": "x" * (1024 * 1024), "note": ""}]}))
check("send with a body over 1 MB is rejected (413)", status == 413, status)
time.sleep(0.5)
check("nothing was inserted by the rejected sends", (editor() or {}).get("editor") == "", repr(editor()))

text("Please review:")
wait(lambda: (editor() or {}).get("editor") == "Please review:", 5)
keys("Home"); time.sleep(0.3)

if DRIVER == "browser":
    run = subprocess.run(["node", f"{HERE}/browser.mjs", "annotate", url, SHOTS], capture_output=True, text=True, timeout=120)
    result = json.loads(run.stdout.strip().split("\n")[-1]) if run.returncode == 0 else {}
    check("the browser flow finished", run.returncode == 0, run.stderr[-1500:])
    checks = result.get("checks", {})
    check("browser: <img onerror> in the conversation is inert text", checks.get("xssInert") == {"images": 0, "pwned": "undefined", "literal": True}, checks.get("xssInert"))
    check("browser: the token is removed from the address bar", checks.get("tokenRemoved") is True)
    check("browser: tool output is collapsed until clicked", checks.get("toolCollapsed") is True and checks.get("toolExpanded") is True)
    check("browser: the composer quotes exactly the dragged text", result.get("selected", [])[:2] == ["The cache is LRU.", "cache-hit-ratio 0.93"], result.get("selected"))
    check("browser: Esc discards, Delete removes", checks.get("escDiscarded") is True and checks.get("listCount") == 2)
    check("browser: the page shows done", "Done" in (result.get("doneText") or ""), result.get("doneText"))
    check("browser: no page errors", result.get("errors") == [], result.get("errors"))
    print("screenshots: " + " ".join(result.get("screenshots", [])))
    expected = "Please review:\n> The cache is LRU.\n\nwhy LRU and not LFU?\n\n> cache-hit-ratio 0.93\n\nline one\nline two\n\n"
else:
    items = [{"quote": "The cache is LRU.", "note": "why LRU?"}, {"quote": "cache-hit-ratio 0.93", "note": "line one\nline two"}, {"quote": "It evicts the oldest entry first.", "note": "ok"}]
    status, body = call(port, "POST", "/api/send", json_headers, json.dumps({"items": items}))
    check("send with the token, Host and JSON is accepted", status == 200 and json.loads(body) == {"ok": True, "inserted": 3}, f"{status} {body}")
    expected = "Please review:\n> The cache is LRU.\n\nwhy LRU?\n\n> cache-hit-ratio 0.93\n\nline one\nline two\n\n> It evicts the oldest entry first.\n\nok\n\n"

got = wait(lambda: (editor() or {}).get("editor") == expected and editor(), 5)
check("the annotations are appended after the draft with one newline, though the cursor was at the start", bool(got), repr((editor() or {}).get("editor")))
time.sleep(1)
screen = cap("03-inserted")
shown = [l.rstrip() for l in screen.split("\n")]
wanted = [l for l in expected.split("\n") if l]
appended = expected[len("Please review:"):].split("\n")
check(f"the {len(appended)}-line insert is shown in full in the input box, without a [paste # marker", len(appended) > 10 and all(l in shown for l in wanted) and "[paste #" not in screen and "more ─" not in screen, screen[-1500:])
check("the status no longer says the page is open", "annotate: page open" not in screen.split("\n", 1)[-1][-600:])
time.sleep(2)
check("the model received no new request", requests() == before, f"{requests()} vs {before}")
status, _ = call(port, "POST", "/api/send", json_headers, good)
check("a second send is rejected", status in (None, 410), status)
time.sleep(0.6)
status, _ = call(port, "GET", "/api/snapshot", {"Host": f"127.0.0.1:{port}", "X-Annotate-Token": token})
check("the server is closed after the send", status is None, status)

def annotate_and_send(draft, label):
    keys("C-c"); time.sleep(0.5)
    wait(lambda: (editor() or {}).get("editor") == "", 5)
    count = len(opened())
    text("/annotate"); keys("Enter")
    wait(lambda: len(opened()) == count + 1, 10)
    u = urlparse(opened()[-1])
    if draft:
        text("/probe-set-editor " + json.dumps(draft)); keys("Enter")
    ok = wait(lambda: (editor() or {}).get("editor") == draft, 5)
    status, _ = call(u.port, "POST", "/api/send", {"Host": f"127.0.0.1:{u.port}", "X-Annotate-Token": parse_qs(u.query)["token"][0], "Content-Type": "application/json"}, json.dumps({"items": [{"quote": "It evicts the oldest entry first.", "note": "ok"}]}))
    want = draft + "> It evicts the oldest entry first.\n\nok\n\n"
    got = wait(lambda: (editor() or {}).get("editor") == want, 5)
    check(f"append {label}", ok and status == 200 and bool(got), f"{status} {(editor() or {}).get('editor')!r}")
    time.sleep(0.5)

annotate_and_send("Ends with a newline\n", "after text ending in a newline adds no extra newline")
annotate_and_send("", "into an empty input box starts with the quote")
check("the model received no new request", requests() == before, f"{requests()} vs {before}")

keys("C-c"); time.sleep(0.5)
wait(lambda: (editor() or {}).get("editor") == "", 5)
session_before = (editor() or {}).get("session")
count = len(opened())
text("/annotate"); keys("Enter")
wait(lambda: len(opened()) == count + 1, 10)
url2 = opened()[-1]
check("a new /annotate gets a new URL", url2 != url, url2)
p2 = urlparse(url2)
port2, token2 = p2.port, parse_qs(p2.query)["token"][0]
browser = None
if DRIVER == "browser":
    ready, go = f"{WORK}/browser-ready", f"{WORK}/browser-go"
    for f in (ready, go):
        if os.path.exists(f): os.remove(f)
    browser = subprocess.Popen(["node", f"{HERE}/browser.mjs", "switched", url2, SHOTS, ready, go], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    check("browser: page loaded and an annotation was added before the switch", wait(lambda: os.path.exists(ready), 60))
text("/new"); keys("Enter")
switched = wait(lambda: (editor() or {}).get("session") not in (None, session_before), 15)
check("the session switched", bool(switched), repr(editor()))
time.sleep(1)
if DRIVER == "browser":
    open(go, "w").write("go")
    out, err = browser.communicate(timeout=60)
    result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 else {}
    check("browser: the page says the session switched", "run /annotate again" in (result.get("statusText") or "") and "Session switched" in (result.get("statusText") or ""), result.get("statusText") or err[-800:])
    check("browser: Send is disabled afterwards", result.get("sendDisabled") is True)
    print("screenshots: " + " ".join(result.get("screenshots", [])))
status, body = call(port2, "POST", "/api/send", {"Host": f"127.0.0.1:{port2}", "X-Annotate-Token": token2, "Content-Type": "application/json"}, good)
check("send after the session switch is rejected", status in (None, 409), f"{status} {body}")
time.sleep(1)
screen = cap("04-after-switch")
check("nothing was inserted into the new session", (editor() or {}).get("editor") == "" and "> The cache is LRU." not in screen, repr(editor()))
check("the model received no new request", requests() == before, f"{requests()} vs {before}")
check("pi is still running", alive())
print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
status=$?
set -e

echo "captures: $WORK/captures"
if [ "$status" -eq 0 ] && [ -z "$KEEP_WORK" ]; then rm -rf "$WORK"; echo "(removed $WORK)"; fi
exit "$status"
