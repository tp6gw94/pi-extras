#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotation-mode in a real pi under tmux with a fake local model. Checks entry, the
Ctrl-Shift-A shortcut, the vim-like keys, wide glyphs, notes, the notes list and help, q
confirmation, s and S with a preserved draft, code and markdown quoting, streaming, resize,
eviction, a session rebuild, regular-mode refusal, and the exit transcript.

Usage:
  PI_BIN=~/.local/pi-1.3.0/bin extensions/annotation/test/e2e/tmux-annotation-mode.sh

Environment:
  PI_BIN       required. Directory that holds the pi executable.
  WORK         throwaway HOME, project, tmux socket and captures. Default: a new mktemp -d
               directory, kept on failure and removed after a passing run. A WORK you set is
               kept.
  EVIDENCE_DIR keep captures, editor snapshots, model events and results in a new directory
               under this directory. Default: $WORK/evidence.

Needs tmux, python3 and node.
TXT
}

if [ -z "${PI_BIN:-}" ]; then
	echo "tmux-annotation-mode.sh: PI_BIN is not set." >&2
	usage
	exit 2
fi
if [ ! -x "$PI_BIN/pi" ]; then
	echo "tmux-annotation-mode.sh: no pi executable in $PI_BIN" >&2
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in tmux python3 node; do
	command -v "$tool" >/dev/null || { echo "tmux-annotation-mode.sh: $tool not found" >&2; exit 2; }
done

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
if [ -n "${EVIDENCE_DIR:-}" ]; then
	mkdir -p "$EVIDENCE_DIR"
	EVIDENCE=$EVIDENCE_DIR/annotation-mode-$(date +%Y%m%d-%H%M%S)-$$
else
	EVIDENCE=$WORK/evidence
fi

export PI_BIN ROOT HERE WORK EVIDENCE KEEP_WORK
exec python3 "$HERE/annotation-mode-drive.py"
