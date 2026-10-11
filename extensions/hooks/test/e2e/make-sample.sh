#!/usr/bin/env bash
# Create the mixed TS + Python sample project used by the e2e acceptance run.
# usage: test/e2e/make-sample.sh <dir>
set -euo pipefail
dir=${1:?usage: make-sample.sh <dir>}
mkdir -p "$dir" && cd "$dir"
git init -q
printf 'node_modules/\n.venv/\n__pycache__/\n.ruff_cache/\n' > .gitignore
printf '{ "name": "pi-hooks-sample", "private": true, "type": "module" }\n' > package.json
cat > eslint.config.js <<'JS'
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
	rules: { "no-var": "error", "@typescript-eslint/no-unused-vars": "error", eqeqeq: "error" },
});
JS
cat > pyproject.toml <<'TOML'
[project]
name = "sample"
version = "0.0.0"

[tool.ruff.lint]
select = ["E", "F"]
TOML
mkdir -p src app docs .pi
printf 'export const one = 1;\n' > src/index.ts
printf 'ONE = 1\n' > app/__init__.py
printf '# sample\n\nMixed TS + Python project for pi-hooks e2e.\n' > README.md
cat > .pi/hooks.json <<'JSON'
{
  "afterWrite": [
    { "name": "prettier", "glob": "*.ts", "command": "node_modules/.bin/prettier --write {files}", "timeoutMs": 20000 },
    { "name": "ruff format", "glob": "*.py", "command": ".venv/bin/ruff format {files}", "timeoutMs": 20000 }
  ],
  "beforeSettle": [
    { "name": "eslint", "glob": "*.ts", "command": "node_modules/.bin/eslint {files}", "timeoutMs": 60000 },
    { "name": "ruff check", "glob": "*.py", "command": ".venv/bin/ruff check --no-cache {files}", "timeoutMs": 60000 }
  ]
}
JSON
npm i -s -D prettier eslint @eslint/js typescript-eslint typescript >/dev/null
python3 -m venv .venv && .venv/bin/pip install -q ruff
git add -A && git -c user.name=sample -c user.email=sample@example.com commit -qm init
echo "sample project ready: $dir"
