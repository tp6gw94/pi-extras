#!/usr/bin/env bash
# Drive interactive pi in tmux and check pi-ux end to end.
#
# Needs: tmux, xclip, xsel, an X server on $DISPLAY (Xvfb works), pi on PATH,
# and a logged-in model. Not part of `npm test` because it calls a real model.
#
#	Xvfb :77 &
#	DISPLAY=:77 PI_UX_MODEL="--provider openai-codex --model gpt-5.5" test/e2e/tmux-verify.sh
#
# Captured panes land in $EV (default /tmp/pi-ux-ev).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
EV=${EV:-/tmp/pi-ux-ev}
WORK=${WORK:-/tmp/pi-ux-e2e}
S=piux-verify
MODEL=${PI_UX_MODEL:-}
: "${DISPLAY:?set DISPLAY to an X server for the clipboard checks}"

mkdir -p "$EV" "$WORK"
rm -rf "$WORK/.sessions"
fail=0

start() {
	tmux kill-session -t "$S" 2>/dev/null || true
	tmux new-session -d -s "$S" -x 110 -y 32 -e "DISPLAY=$DISPLAY" -e "PATH=$PATH" \
		"cd '$WORK' && pi --session-dir '$WORK/.sessions' --extension '$ROOT/ux-pi/index.ts' \
		--extension '$ROOT/test/e2e/inject-ext.ts' $MODEL $*; sleep 600"
	sleep 8
}
keys() { tmux send-keys -t "$S" "$@"; }
type_text() { tmux send-keys -t "$S" -l "$1"; sleep 0.4; }
paste_text() { tmux set-buffer -b piux "$1"; tmux paste-buffer -p -b piux -t "$S"; sleep 0.4; }
cap() { tmux capture-pane -p -t "$S" >"$EV/$1.txt"; cat "$EV/$1.txt"; }
expect() { # name, file, regex
	if grep -qE -- "$3" "$EV/$2.txt"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi
}
reject() {
	if grep -qE -- "$3" "$EV/$2.txt"; then echo "FAIL $1"; fail=1; else echo "PASS $1"; fi
}
send() { keys Enter; sleep "${1:-12}"; }

start

type_text "Reply with exactly: pong"; send
cap 01-short >/dev/null
expect "short prompt pinned" 01-short '^❯ Reply with exactly: pong'

paste_text $'Write the numbers 1 to 60, one per line, each followed by a short English word. This prompt is deliberately long so that the pinned summary has to be truncated at the terminal width with an ellipsis.\n第二行：請用英文回答，不要加任何解釋。\nThird line: no code blocks.'
send 30
cap 02-long >/dev/null
expect "long prompt truncated with …" 02-long '^❯ Write the numbers 1 to 60.*…$'

keys M-p; sleep 1; cap 03-expanded >/dev/null
expect "alt+p expands" 03-expanded '^▾ Last prompt \(alt\+p to collapse\)'
expect "expanded shows CJK line" 03-expanded '^│ 第二行'
keys M-p; sleep 1; cap 04-collapsed >/dev/null
expect "alt+p collapses" 04-collapsed '^❯ Write the numbers 1 to 60'

type_text "/inject"; send
cap 05-inject >/dev/null
expect "extension message answered" 05-inject 'injected-ok'
expect "pin kept after extension message" 05-inject '^❯ Write the numbers 1 to 60'

printf 'const x = 1;\nfunction add(a, b) {\n  return a + b;\n}\n' | xclip -selection clipboard -i
type_text "Explain this code:"; keys M-q; sleep 2
cap 06-quote-shortcut >/dev/null
expect "alt+q keeps typed text" 06-quote-shortcut '^Explain this code:$'
expect "alt+q inserts quote" 06-quote-shortcut '^> function add\(a, b\) \{$'

keys C-c; sleep 0.4; type_text "/quote"; send 2
cap 08-quote-command >/dev/null
expect "/quote inserts quote" 08-quote-command '^> const x = 1;$'

keys C-c; sleep 0.4; type_text "Before: after"; keys Left Left Left Left Left Left; keys M-q; sleep 2
cap 09-quote-mid-cursor >/dev/null
expect "quote lands at the cursor" 09-quote-mid-cursor '^ after$'

pkill -x xclip || true; xsel -bc
keys C-c; sleep 0.4; type_text "keep me"; keys M-q; sleep 3
cap 10-empty-shortcut >/dev/null
expect "empty clipboard warns" 10-empty-shortcut 'clipboard is empty.*Nothing inserted'
expect "empty clipboard keeps editor" 10-empty-shortcut '^keep me$'
reject "empty clipboard inserts nothing" 10-empty-shortcut '^> '

# Resume: send one more prompt, quit, continue the session.
keys C-c; sleep 0.4; type_text "Reply with exactly: resumed-ok"; send
keys C-d; sleep 2
start --continue
cap 07-resume >/dev/null
expect "resume shows last prompt" 07-resume '^❯ Reply with exactly: resumed-ok'

tmux kill-session -t "$S" 2>/dev/null || true
exit $fail
