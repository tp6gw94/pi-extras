#!/usr/bin/env bash
# Acceptance run against a REAL model. Every scenario starts real `pi --mode rpc`
# with this extension loaded, in a copy of the sample project (test/e2e/make-sample.sh).
#
# usage: test/e2e/acceptance.sh <out-dir> -- <pi model args, e.g. --provider openai-codex --model gpt-5.5>
# Logs: <out-dir>/<scenario>.log (driver) and <scenario>.trace.jsonl (every hook command pi-hooks ran).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: acceptance.sh <out-dir> -- <pi args>}; shift
[ "${1:-}" = "--" ] && shift
model_args=("$@")
mkdir -p "$out" && out=$(cd "$out" && pwd)
tmpl="$out/template"
[ -d "$tmpl" ] || "$here/make-sample.sh" "$tmpl"

fresh() { rm -rf "${out:?}/$1" && cp -a "$tmpl" "$out/$1"; }
drive() {
	local name=$1 dir=$2 confirm=$3; shift 3
	local args=()
	for p in "$@"; do args+=(--prompt "$p"); done
	echo "===== $name ====="
	PI_HOOKS_LOG="$out/$name.trace.jsonl" python3 "$here/drive.py" --cwd "$out/$dir" --confirm "$confirm" --deadline 900 \
		"${args[@]}" -- "${model_args[@]}" 2>&1 | tee "$out/$name.log"
}

only=${ONLY:-1 2 3 4}

if [[ " $only " == *" 1 "* ]]; then
# 1) Unfamiliar repo asks first. One turn writes 5 files (.ts x3, .py, .md) with deliberate lint errors:
#    prettier/ruff format per file, eslint and ruff check once each with only their own files, errors fixed in-turn.
#    Second prompt touches only .md: nothing runs, no re-confirm (same config hash).
fresh s1
drive s1-mixed s1 yes \
"Do all of this in this single turn, using the write tool once per file, then reply with one short line.
1. src/math.ts: export functions add(a: number, b: number) and sub(a: number, b: number).
2. src/greet.ts: export function greet(name: string) that returns a greeting string.
3. src/legacy.ts: write exactly this content first:
var counter = 0
export function inc() { counter++; return counter }
4. app/util.py: write exactly this content first:
import os
def double(x):
    return x*2
5. docs/notes.md: a two-line note about this change." \
"Append one more bullet line saying 'docs only' to docs/notes.md. Do not touch any other file."

# 2) Same project, hooks.json edited: pi-hooks asks again; declining runs nothing.
sed -i 's/"timeoutMs": 60000/"timeoutMs": 61000/' "$out/s1/.pi/hooks.json"
drive s2-reconfirm-decline s1 no "Create src/extra.ts that exports const extra = 1, then reply 'ok'."
fi

if [[ " $only " == *" 3 "* ]]; then
# 3) Unfixable error: a beforeSettle check that always fails. Must stop after 3 fix attempts and list remaining errors.
fresh s3
python3 - "$out/s3/.pi/hooks.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["beforeSettle"].append({"name": "policy-check", "glob": "*.ts",
    "command": "for f in {files}; do echo \"$f:1:1 error POLICY-7: file is not registered in the external policy registry (contact #platform)\"; done; exit 1",
    "timeoutMs": 10000})
json.dump(d, open(p, "w"), indent=2)
PY
drive s3-cap s3 yes "Use the write tool to create src/feature.ts exporting function feature(): number that returns 42. Fix any check failures you are told about, then reply briefly."
fi

if [[ " $only " == *" 4 "* ]]; then
# 4) Hung commands: formatter and linter that never finish. Must be killed at timeoutMs, user told, pi settles.
fresh s4
cat > "$out/s4/.pi/hooks.json" <<'JSON'
{
  "afterWrite": [{ "name": "hung-format", "glob": "*.ts", "command": "sleep 600", "timeoutMs": 3000 }],
  "beforeSettle": [{ "name": "hung-lint", "glob": "*.ts", "command": "echo checking {files}; sleep 600 && echo never", "timeoutMs": 4000 }]
}
JSON
drive s4-timeout s4 yes "Use the write tool (not bash) to create src/slow.ts exporting const slow = true, then reply 'ok'."
echo "leftover sleep 600 processes: $(ps -eo args= | grep -c '^sleep 600$')"
fi
