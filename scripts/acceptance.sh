#!/usr/bin/env bash
set -euo pipefail

PI_BIN=$(cd "${1:?usage: scripts/acceptance.sh <pi bin dir> <git ref> [out dir]}" && pwd)
REF=${2:?usage: scripts/acceptance.sh <pi bin dir> <git ref> [out dir]}
OUT=${3:-/tmp/pi-extras-acceptance}
SRC="git:github.com/tp6gw94/pi-extras@$REF"
ALL=(annotation hooks inline-skills ralph resume-handoff rpc-subagents skill-name-normalizer ux)
T=$(mktemp -d /tmp/pi-extras-acc.XXXXXX)
export HOME=$T/home PATH="$PI_BIN:$PATH"
unset PI_CODING_AGENT_DIR
mkdir -p "$HOME" "$T/project" "$OUT"
SETTINGS=$HOME/.pi/agent/settings.json
S=pi-extras-acc
startup_settle_seconds=3
fail=0

capture_start() {
	local out=$1
	tmux kill-session -t $S 2>/dev/null || true
	tmux new-session -d -s $S -x 160 -y 50 -e HOME="$HOME" -e PATH="$PATH" -c "$T/project" "pi; sleep 600"
	for _ in $(seq 1 40); do
		sleep 1
		tmux capture-pane -p -t $S -S -200 | grep -q '^\[Extensions\]' && break
	done
	sleep "$startup_settle_seconds"
	tmux capture-pane -p -t $S -S -200 | grep -v '^\s*$' | grep -v '^─*$' >"$out"
	tmux kill-session -t $S
}
loaded() {
	local file=$1
	sed -n '/^\[Extensions\]/,/^ [A-Z]/p' "$file" | grep -o 'pi-extras:[a-z-]*' | sed 's/pi-extras://' | sort | tr '\n' ' '
}
expect_loaded() {
	local label=$1 file=$2; shift 2
	local want got
	want=$(printf '%s\n' "$@" | sort | tr '\n' ' ')
	got=$(loaded "$file")
	if [ "$got" = "$want" ]; then echo "PASS $label: $got"; else echo "FAIL $label: got [$got] want [$want]"; fail=1; fi
	local bare_box_warnings='No models available\|extended-keys is off' extra
	extra=$(grep -i 'warning\|error\|duplicate\|conflict' "$file" | grep -v "$bare_box_warnings" || true)
	if [ -z "$extra" ]; then echo "PASS $label: no other warnings"; else echo "FAIL $label: $extra"; fail=1; fi
}

echo "pi $(pi --version) in $T"
pi install "$SRC" >"$OUT/install.log" 2>&1
tail -1 "$OUT/install.log"
cp "$SETTINGS" "$OUT/settings-installed.json"

capture_start "$OUT/1-all.txt"
expect_loaded "1 install" "$OUT/1-all.txt" "${ALL[@]}"
SEVEN=(annotation hooks inline-skills resume-handoff rpc-subagents skill-name-normalizer ux)

printf '{\n\t"packages": [\n\t\t{\n\t\t\t"source": "%s",\n\t\t\t"extensions": ["!extensions/ralph/index.ts"]\n\t\t}\n\t]\n}\n' "$SRC" >"$SETTINGS"
cp "$SETTINGS" "$OUT/settings-filter.json"
capture_start "$OUT/2-filter.txt"
expect_loaded "2 settings filter" "$OUT/2-filter.txt" "${SEVEN[@]}"

cp "$OUT/settings-installed.json" "$SETTINGS"
tmux new-session -d -s $S -x 140 -y 45 -e HOME="$HOME" -e PATH="$PATH" -c "$T/project" "pi config; sleep 600"
sleep 5
tmux capture-pane -p -t $S | grep -v '^\s*$' >"$OUT/3-config-before.txt"
ralph_row=0
for name in "${ALL[@]}"; do [ "$name" = ralph ] && break; ralph_row=$((ralph_row + 1)); done
for ((i = 0; i < ralph_row; i++)); do tmux send-keys -t $S Down; sleep 0.3; done
tmux send-keys -t $S Space; sleep 0.5
tmux capture-pane -p -t $S | grep -v '^\s*$' >"$OUT/3-config-toggled.txt"
tmux send-keys -t $S Escape; sleep 1.5
tmux kill-session -t $S
cp "$SETTINGS" "$OUT/settings-config.json"
if grep -q '"-extensions/ralph/index.ts"' "$SETTINGS"; then echo 'PASS 3 pi config wrote "-extensions/ralph/index.ts"'; else echo "FAIL 3 pi config: $(cat "$SETTINGS")"; fail=1; fi
capture_start "$OUT/3-config.txt"
expect_loaded "3 pi config" "$OUT/3-config.txt" "${SEVEN[@]}"

rm -rf "$T"
exit $fail
