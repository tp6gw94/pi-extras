#!/usr/bin/env bash
# Drives annotation in a real pi, fullscreen, in tmux, with SGR mouse sequences and a fake local model.
#
# Usage:
#	PI_BIN=~/.local/pi-1.1.0/bin extensions/annotation/test/e2e/tmux-annotation.sh
#
# Environment:
#	PI_BIN            required. Directory that holds the pi executable to test.
#	WORK              throwaway HOME, project and pane captures. Default: a new mktemp -d directory,
#	                  removed after a passing run. A WORK you set is always kept.
#	PI_EXTRAS_SOURCE  pi package source to install into the throwaway HOME, such as
#	                  git:github.com/tp6gw94/pi-extras@<ref>. Default: load this checkout's
#	                  extensions/annotation/index.ts with --extension.
#	PORT              port of the fake model server. Default: 18733.
#	DISPLAY           X server for the clipboard check (Xvfb works). Without it, or without xclip,
#	                  the clipboard check is skipped.
#
# Needs tmux, python3 and node. Not part of `npm test`.
set -euo pipefail

if [ -z "${PI_BIN:-}" ]; then
	echo "tmux-annotation.sh: set PI_BIN to the directory that holds pi, e.g. PI_BIN=~/.local/pi-1.1.0/bin" >&2
	exit 2
fi
if [ ! -x "$PI_BIN/pi" ]; then
	echo "tmux-annotation.sh: no pi executable in $PI_BIN" >&2
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in tmux python3 node; do
	command -v "$tool" >/dev/null || { echo "tmux-annotation.sh: $tool not found" >&2; exit 2; }
done

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-18733}
S=annotation-e2e-$$
export WORK PORT S HERE ROOT PI_BIN
export PI_HOME=$WORK/home
mkdir -p "$PI_HOME/.pi/agent" "$WORK/project" "$WORK/captures"

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

EXTENSIONS="--extension '$HERE/session-switch-ext.ts'"
if [ -n "${PI_EXTRAS_SOURCE:-}" ]; then
	HOME=$PI_HOME PATH="$PI_BIN:$PATH" pi install "$PI_EXTRAS_SOURCE" </dev/null >"$WORK/install.log" 2>&1
	tail -1 "$WORK/install.log"
else
	EXTENSIONS="--extension '$ROOT/index.ts' $EXTENSIONS"
fi

echo "pi $(HOME=$PI_HOME "$PI_BIN/pi" --version 2>/dev/null) in $WORK"
tmux new-session -d -s "$S" -x 110 -y 32 -c "$WORK/project" \
	"export HOME='$PI_HOME' PATH='$PI_BIN:$PATH' TERM=xterm-256color ${DISPLAY:+DISPLAY='$DISPLAY'}; unset PI_CODING_AGENT_DIR; pi --provider fake --model fake-model $EXTENSIONS; echo PI_EXITED \$?; sleep 600"

set +e
python3 - <<'PY'
import os, re, shutil, subprocess, sys, time, urllib.request

S, WORK, PORT = os.environ["S"], os.environ["WORK"], os.environ["PORT"]
CAP = f"{WORK}/captures"
COLS = 110
failures = 0

def check(name, ok, detail=""):
    global failures
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  [{detail}]"))
    failures += 0 if ok else 1

def skip(name, why):
    print(f"SKIP {name} ({why})")

def tmux(*args):
    return subprocess.run(["tmux", *args], check=True, capture_output=True, text=True).stdout

def cap(name=None):
    text = tmux("capture-pane", "-p", "-t", S)
    if name:
        open(f"{CAP}/{name}.txt", "w").write(text)
        open(f"{CAP}/{name}.ansi", "w").write(tmux("capture-pane", "-p", "-e", "-t", S))
    return text

def keys(*k): tmux("send-keys", "-t", S, *k)
def text(s): tmux("send-keys", "-t", S, "-l", s); time.sleep(0.4)
def raw(s): tmux("send-keys", "-t", S, "-H", *[f"{b:02x}" for b in s.encode()])

def drag(x1, y1, x2, y2):
    raw(f"\x1b[<0;{x1 + 1};{y1 + 1}M"); time.sleep(0.15)
    raw(f"\x1b[<32;{x2 + 1};{y2 + 1}M"); time.sleep(0.15)
    raw(f"\x1b[<0;{x2 + 1};{y2 + 1}m"); time.sleep(1.2)

def find(needle):
    for y, line in enumerate(cap().split("\n")):
        x = line.find(needle)
        if x >= 0:
            return x, y
    return None

def box_rows(screen):
    lines = screen.split("\n")
    top = next((i for i, l in enumerate(lines) if "Annotate" in l), None)
    bottom = next((i for i, l in enumerate(lines) if top is not None and i > top and "╰" in l), None)
    return lines, top, bottom

def requests():
    return int(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/count").read())

def alive():
    return "PI_EXITED" not in cap()

clip_ok = bool(os.environ.get("DISPLAY")) and shutil.which("xclip")
def clip():
    r = subprocess.run(["xclip", "-selection", "clipboard", "-o"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

for _ in range(40):
    time.sleep(1)
    if "fake-model" in cap():
        break
time.sleep(3)
cap("00-start")

text("Show me the add helper"); keys("Enter"); time.sleep(5)
before = requests()
cap("01-reply")
start, end = find("function add(a, b) {"), find("return a + b;")
check("the reply shows the code", start and end)
if not (start and end):
    sys.exit(1)

x2, y2 = end[0] + len("return a + b;") - 1, end[1]
drag(start[0], start[1], x2, y2)
lines, top, _ = box_rows(cap("02-box"))
check("a box opens after the selection", top is not None)
if top is not None:
    col = lines[top].find("╭")
    check(f"box top-left on the row below the release row ({y2}) at the release column ({x2})", top == y2 + 1 and col == min(x2, COLS - 60), f"row {top} col {col}")
    check("the box shows the selection", any("│ function add(a, b) {" in l for l in lines[top:top + 6]))
selected = clip() if clip_ok else None
if clip_ok:
    check("the clipboard holds the selection (copy-on-select)", selected is not None and re.fullmatch(r"function add\(a, b\) \{\n\s+return a \+ b;", selected), repr(selected))
else:
    skip("clipboard", "DISPLAY or xclip missing")

text("What does add return?")
cap("03-typed")
keys("Enter"); time.sleep(1.5)
screen = cap("04-inserted")
after = screen.split("\n")
quote = [l for l in after if l.startswith("> ")]
check("Enter closes the box", "Annotate" not in screen)
check("the editor holds the > quote", len(quote) == 2 and quote[0] == "> function add(a, b) {" and re.fullmatch(r">\s+return a \+ b;", quote[1]), repr(quote))
if clip_ok and selected is not None:
    check("the quote is the clipboard text", "\n".join(l[2:] for l in quote) == selected)
qi = after.index(quote[-1]) if quote else -1
check("then a blank line, the note and a blank line", qi >= 0 and after[qi + 1:qi + 4] == ["", "What does add return?", ""], repr(after[qi:qi + 4]))
time.sleep(2)
check("Enter did not submit the prompt", requests() == before, f"{requests()} requests, {before} before")

keys("C-c"); time.sleep(0.6)
start, end = find("Here is the helper:"), find("It adds two numbers.")
drag(start[0], start[1], end[0] + len("It adds two numbers.") - 1, end[1])
lines, top, bottom = box_rows(cap("05-box-above"))
check("near the bottom the box opens right above the selection", top is not None and bottom == start[1] - 1, f"box {top}..{bottom}, selection from row {start[1]}")
text("discard me")
keys("Escape"); time.sleep(1.2)
screen = cap("06-esc")
check("Esc closes the box", "Annotate" not in screen)
check("Esc inserts nothing", "discard me" not in screen and "> Here is" not in screen)
if clip_ok:
    c = clip() or ""
    check("the clipboard holds the second selection", c.startswith("Here is the helper:") and c.endswith("It adds two numbers."), repr(c))

text("/new-later 3"); keys("Enter"); time.sleep(0.8)
spot = find("It adds two numbers.")
drag(spot[0], spot[1], spot[0] + 6, spot[1])
check("a box is open when the session switch starts", "Annotate" in cap("07-box-before-new"))
time.sleep(4)
screen = cap("08-after-new")
check("pi is still running after /new while the box was open", alive(), screen[-400:])
check("the new session starts with an empty transcript and no box", "Show me the add helper" not in screen and "Annotate" not in screen)
check("no annotation error notice", "annotation box failed" not in screen)
text("Show me the add helper"); keys("Enter"); time.sleep(5)
spot = find("It adds two numbers.")
drag(spot[0], spot[1], spot[0] + 6, spot[1])
check("in the new session a selection opens the box again", "Annotate" in cap("09-box-in-new-session"))
keys("Escape"); time.sleep(1.2)
screen = cap("10-alive")
check("Esc closes it and pi keeps running", "Annotate" not in screen and alive())
print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
status=$?
set -e

echo "captures: $WORK/captures"
if [ "$status" -eq 0 ] && [ -z "$KEEP_WORK" ]; then rm -rf "$WORK"; echo "(removed $WORK)"; fi
exit "$status"
