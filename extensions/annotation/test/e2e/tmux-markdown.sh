#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotate in a real pi under tmux with a fake local model that answers in markdown
with a TypeScript block and mermaid diagrams, then drives the page in headless Chrome with
markdown.mjs: rendering, diagram frames, CSP violations, network requests, quoting a code
selection and a whole diagram, live updates, /tree resets and the frame timeout fallback.

Usage:
  PI_BIN=~/.local/pi-1.1.0/bin PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
    extensions/annotation/test/e2e/tmux-markdown.sh

Environment:
  PI_BIN            required. Directory that holds the pi executable.
  PLAYWRIGHT_CORE   required. Path to an installed playwright-core package.
  CHROME_BIN        Chrome or Chromium executable. Default: google-chrome on PATH.
  TUI_MODE          fullscreen (default) or regular, passed to pi --tui-mode.
  SCREENSHOTS       screenshot directory. Default: $WORK/screenshots.
  WORK              throwaway HOME, project and captures. Default: a new mktemp -d
                    directory, removed after a passing run. A WORK you set is kept.
  PORT              port of the fake model. Default: 18734.
  ANNOTATE_PORT     passed to pi as PI_ANNOTATE_PORT. Default: 4747.

Needs tmux, python3, node and Chrome.
TXT
}

if [ -z "${PI_BIN:-}" ] || [ -z "${PLAYWRIGHT_CORE:-}" ]; then
	echo "tmux-markdown.sh: PI_BIN and PLAYWRIGHT_CORE must be set." >&2
	usage
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in tmux python3 node; do
	command -v "$tool" >/dev/null || { echo "tmux-markdown.sh: $tool not found" >&2; exit 2; }
done
TUI_MODE=${TUI_MODE:-fullscreen}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-18734}
ANNOTATE_PORT=${ANNOTATE_PORT:-4747}
SCREENSHOTS=${SCREENSHOTS:-$WORK/screenshots}
CHROME_BIN=${CHROME_BIN:-$(command -v google-chrome || true)}
S=annotate-md-$$
export WORK PORT ANNOTATE_PORT S HERE ROOT PI_BIN TUI_MODE SCREENSHOTS PLAYWRIGHT_CORE CHROME_BIN
PI_HOME=$WORK/home
mkdir -p "$PI_HOME/.pi/agent" "$WORK/project" "$WORK/captures" "$WORK/bin"
rm -f "$WORK/opened.txt" "$WORK/editor.json" "$WORK"/browser-*

cat >"$WORK/bin/xdg-open" <<EOF
#!/bin/sh
echo "\$1" >>"$WORK/opened.txt"
EOF
chmod +x "$WORK/bin/xdg-open"

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

echo "pi $(HOME=$PI_HOME "$PI_BIN/pi" --version 2>/dev/null), $TUI_MODE, markdown, in $WORK"
tmux new-session -d -s "$S" -x 120 -y 50 -c "$WORK/project" \
	"export HOME='$PI_HOME' PATH='$WORK/bin:$PI_BIN:$PATH' TERM=xterm-256color PI_ANNOTATE_PORT='$ANNOTATE_PORT' ANNOTATE_EDITOR_PROBE='$WORK/editor.json'; unset PI_CODING_AGENT_DIR SSH_CONNECTION DISPLAY; pi --tui-mode $TUI_MODE --provider fake --model fake-model --extension '$ROOT/index.ts' --extension '$HERE/editor-probe.ts'; echo PI_EXITED \$?; sleep 600"

set +e
python3 - <<'PY'
import json, os, subprocess, sys, time, urllib.request

S, WORK, PORT, HERE, SHOTS = os.environ["S"], os.environ["WORK"], os.environ["PORT"], os.environ["HERE"], os.environ["SCREENSHOTS"]
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
        open(f"{WORK}/captures/{name}.txt", "w").write(text)
        open(f"{WORK}/captures/{name}.ansi", "w").write(tmux("capture-pane", "-p", "-e", "-t", S))
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

def editor_text():
    try:
        return json.load(open(f"{WORK}/editor.json")).get("editor")
    except Exception:
        return None

def opened():
    try:
        return [l for l in open(f"{WORK}/opened.txt").read().split("\n") if l]
    except FileNotFoundError:
        return []

def signal(name):
    open(f"{WORK}/browser-{name}", "w").write("go")

def waited(name, browser, timeout=120):
    return wait(lambda: os.path.exists(f"{WORK}/browser-{name}") or browser.poll() is not None, timeout) and os.path.exists(f"{WORK}/browser-{name}")

wait(lambda: editor_text() is not None, 40)
time.sleep(2)
check("pi started with the annotation extension", editor_text() == "" and "PI_EXITED" not in cap())
text("Please answer in markdown"); keys("Enter")
check("the fake model answered in markdown", bool(wait(lambda: requests() >= 1 and "this is not a diagram" in cap(), 30)), f"{requests()} requests")
time.sleep(1)
cap("01-reply")
text("/annotate"); keys("Enter")
urls = wait(lambda: opened(), 10)
check("/annotate opened the page", len(urls) == 1, repr(urls))
if not urls:
    sys.exit(1)
url = urls[0]
before = requests()

browser = subprocess.Popen(["node", f"{HERE}/markdown.mjs", url, SHOTS, WORK], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
check("browser: round 1 sent", waited("sent", browser))
expected = "".join([
    "> ```ts\n> while (cache.size > limit) {\n>         const oldest = cache.keys().next().value;\n> ```\n\nwhy here?\n\n",
    "> ```mermaid\n> flowchart TD\n>     A[Request] --> B{In memory?}\n>     B -->|yes| C[Return value]\n>     B -->|no| D[Read disk]\n>     D --> C\n> ```\n\nis the flow right?\n\n",
    "> ```mermaid\n> B -->|yes| C[Return value]\n> ```\n\nsource view\n\n",
    "> The cache has two layers and uses LRU eviction.\n\nplain text\n\n",
])
got = wait(lambda: editor_text() == expected, 10)
check("the editor got the ts-fenced selection, the mermaid-fenced diagram, the fenced source selection and plain text", bool(got), repr(editor_text()))
cap("02-inserted")
check("the model received no request from the send", requests() == before, f"{requests()} vs {before}")
keys("C-c"); wait(lambda: editor_text() == "", 5)
text("Now a live diagram please"); keys("Enter")
check("the live diagram prompt was answered", bool(wait(lambda: requests() == before + 1 and "call flow" in cap(), 30)))
signal("live")
check("browser: the live diagram rendered", waited("live-done", browser))
text("/probe-tree Cache design"); keys("Enter")
time.sleep(1)
signal("tree")
out, err = browser.communicate(timeout=180)
result = json.loads(out.strip().split("\n")[-1]) if browser.returncode == 0 and out.strip() else {}
check("the browser flow finished", browser.returncode == 0, err[-2500:])
for name, value in result.get("checks", {}).items():
    check(f"browser: {name}", value is True, json.dumps(result.get("details", {}).get(name))[:1500])
print("screenshots: " + " ".join(result.get("screenshots", [])))
check("pi is still running", "PI_EXITED" not in cap())
print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
status=$?
set -e

echo "captures: $WORK/captures"
if [ "$status" -eq 0 ] && [ -z "$KEEP_WORK" ]; then rm -rf "$WORK"; echo "(removed $WORK)"; fi
exit "$status"
