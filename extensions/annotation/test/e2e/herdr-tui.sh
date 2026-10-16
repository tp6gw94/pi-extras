#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'TXT'
Runs /annotate tui in a real pi and the pi-annotation bin in two panes of one
background herdr tab, with a fake local model. Checks the attach notice, the
session registry record, the note flow into the pi editor, the diagram toggle
and quote, that sending made no model request, that a new reply appears live,
that q exits the TUI while pi keeps running, and that /annotate removes the
record.

Usage:
  PI_BIN=~/.local/pi-1.1.0/bin extensions/annotation/test/e2e/herdr-tui.sh

Environment:
  PI_BIN    required. Directory that holds the pi executable.
  WORK      throwaway HOME, agent dir and project. Default: a new mktemp -d
            directory, removed after a passing run. A WORK you set is kept.
  PORT      port of the fake model. Default: a free port.

Run it from inside a herdr pane (HERDR_ENV=1). It creates a background tab,
splits that tab's root pane and closes only that tab at the end; it never
touches the caller's pane.

Needs herdr and node. It is manual, not part of npm test.
TXT
}

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "herdr-tui.sh: run this from inside a herdr pane (HERDR_ENV=1)." >&2
	usage
	exit 2
fi
if [ -z "${PI_BIN:-}" ]; then
	echo "herdr-tui.sh: PI_BIN is not set." >&2
	usage
	exit 2
fi
if [ ! -x "$PI_BIN/pi" ]; then
	echo "herdr-tui.sh: no pi executable in $PI_BIN" >&2
	exit 2
fi
PI_BIN=$(cd "$PI_BIN" && pwd)
for tool in herdr node; do
	if ! command -v "$tool" >/dev/null; then
		echo "herdr-tui.sh: $tool not found" >&2
		exit 2
	fi
done

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
KEEP_WORK=${WORK:+1}
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')}
PI_HOME=$WORK/home
PI_AGENT=$WORK/agent
PROJECT=$WORK/project
TAB_FILE=$WORK/tab-id
export WORK PI_HOME PI_AGENT PROJECT PI_BIN ROOT HERE PORT TAB_FILE

mkdir -p "$PI_HOME" "$PI_AGENT" "$PROJECT" "$WORK/bin"
PROJECT=$(cd "$PROJECT" && pwd -P)
export PROJECT

cat >"$WORK/bin/xdg-open" <<SH
#!/bin/sh
echo "\$1" >>"$WORK/opened.txt"
SH
cp "$WORK/bin/xdg-open" "$WORK/bin/open"
chmod +x "$WORK/bin/xdg-open" "$WORK/bin/open"

cat >"$PI_AGENT/models.json" <<JSON
{ "providers": { "fake": { "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "fake", "models": [{ "id": "fake-model", "name": "Fake model" }] } } }
JSON

node "$HERE/fake-openai.mjs" "$PORT" >"$WORK/fake.log" 2>&1 &
FAKE_PID=$!

cleanup() {
	local code=$?
	if [ -s "$TAB_FILE" ]; then
		herdr tab close "$(cat "$TAB_FILE")" >/dev/null 2>&1 || true
	fi
	kill "$FAKE_PID" 2>/dev/null || true
	wait "$FAKE_PID" 2>/dev/null || true
	if [ "$code" -eq 0 ] && [ -z "$KEEP_WORK" ]; then
		rm -rf "$WORK"
	else
		echo "herdr-tui.sh: work kept in $WORK" >&2
	fi
	exit "$code"
}
trap cleanup EXIT

node - <<'JS'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { WORK, PI_HOME, PI_AGENT, PROJECT, PI_BIN, ROOT, HERE, PORT, TAB_FILE } = process.env;
const EDITOR = path.join(WORK, "editor.json");
const OPENED = path.join(WORK, "opened.txt");
const REGISTRY = path.join(PI_AGENT, "annotation", "sessions");
const PI_INDEX = path.join(ROOT, "index.ts");
const PROBE = path.join(HERE, "editor-probe.ts");
const BIN = path.join(ROOT, "bin", "pi-annotation.ts");

let failures = 0;

function check(name, ok, detail = "") {
	console.log((ok ? "PASS " : "FAIL ") + name + (ok || !detail ? "" : `  [${String(detail).replace(/\s+/g, " ").slice(0, 400)}]`));
	if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

const flat = (text) => String(text ?? "").replace(/\s+/g, " ");

const DIAGRAM_FENCE = [
	"```mermaid",
	"flowchart TD",
	"    A[Request] --> B{In memory?}",
	"    B -->|yes| C[Return value]",
	"    B -->|no| D[Read disk]",
	"    D --> C",
	"```",
];
const DIAGRAM_ART = [
	"   ┌─────────┐",
	"   │ Request │",
	"   └────┬────┘",
	"        │",
	"        ▼",
	" ╭────────────╮",
	" │ In memory? ├──────┐",
	" ╰──────┬─────╯      │",
	"        │            │",
	"        ▼no          │",
	"  ┌───────────┐      │",
	"  │ Read disk │      │",
	"  └─────┬─────┘      │",
	"        │            │",
	"        ▼            │",
	"┌──────────────┐ yes │",
	"│ Return value │◄────┘",
	"└──────────────┘",
];
const DIAGRAM_REQUEST_LINE = DIAGRAM_ART.find((line) => line.includes("Request")).trim();
const DIAGRAM_RESULT_LINE = DIAGRAM_ART.find((line) => line.includes("Return value")).trim();
const DIAGRAM_COLUMNS = Math.max(...DIAGRAM_ART.map((line) => [...line].length)) + 2;
const EXPECTED_DIAGRAM_QUOTE = `${DIAGRAM_FENCE.map((line) => `> ${line}`).join("\n")}\n\ne2e-diagram-note\n\n`;

function herdr(...args) {
	const output = execFileSync("herdr", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
	if (output === "") return {};
	let value;
	try {
		value = JSON.parse(output);
	} catch {
		return { text: output };
	}
	if (value && value.error) throw new Error(value.error.message ?? "herdr command failed");
	return value.result ?? value;
}

function writeScript(name, lines) {
	const file = path.join(WORK, name);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

async function shellReady(paneId) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		herdr("pane", "run", paneId, "echo shell-ready-$((0))");
		try {
			herdr("pane", "wait-output", paneId, "--match", "shell-ready-0", "--timeout", "3000");
			return;
		} catch {}
	}
	throw new Error(`shell in pane ${paneId} never became ready: ${flat(readPane(paneId)).slice(-300)}`);
}

function readPane(paneId) {
	const result = herdr("pane", "read", paneId, "--source", "visible", "--format", "text");
	return result.read?.text ?? result.text ?? "";
}

function paneRect(paneId) {
	const result = herdr("pane", "layout", "--pane", paneId);
	const snapshot = result.layout ?? result;
	const pane = (snapshot.panes ?? []).find((item) => item.pane_id === paneId);
	return pane?.rect;
}

function editor() {
	try {
		return JSON.parse(fs.readFileSync(EDITOR, "utf8"));
	} catch {
		return undefined;
	}
}

function registryNames() {
	try {
		return fs.readdirSync(REGISTRY).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

function requestCount() {
	return new Promise((resolve, reject) => {
		http.get(`http://127.0.0.1:${PORT}/count`, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve(Number(body)));
		}).on("error", reject);
	});
}

async function waitFor(predicate, timeoutMs = 30000, intervalMs = 250) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		let value;
		try {
			value = predicate();
		} catch {
			value = undefined;
		}
		if (value) return value;
		if (Date.now() >= end) return undefined;
		await sleep(intervalMs);
	}
}

async function run() {
	const tab = herdr("tab", "create", "--no-focus", "--cwd", PROJECT, "--label", `annotate-e2e-${process.pid}`);
	const tabId = tab.tab?.tab_id;
	const piPane = tab.root_pane?.pane_id;
	if (!tabId || !piPane) throw new Error(`herdr tab create returned no tab or root pane: ${JSON.stringify(tab)}`);
	fs.writeFileSync(TAB_FILE, `${tabId}\n`);
	const tabWidth = paneRect(piPane)?.width;
	if (!tabWidth) throw new Error(`herdr pane layout returned no geometry for the tab root pane ${piPane}`);
	const ratio = Math.max(0.1, Math.min(0.5, 1 - DIAGRAM_COLUMNS / tabWidth));
	const split = herdr("pane", "split", piPane, "--direction", "right", "--ratio", ratio.toFixed(3), "--cwd", PROJECT, "--no-focus");
	const attachPane = split.pane?.pane_id;
	if (!attachPane) throw new Error(`herdr pane split returned no pane: ${JSON.stringify(split)}`);
	check("created one background tab and split its root pane", piPane !== attachPane, `${piPane} ${attachPane}`);
	const attachWidth = paneRect(attachPane)?.width;
	check("the attach pane is wide enough for the diagram art", (attachWidth ?? 0) >= DIAGRAM_COLUMNS, `${attachWidth} columns, need ${DIAGRAM_COLUMNS}`);

	const panePath = `${WORK}/bin:${PI_BIN}:${process.env.PATH ?? ""}`;
	const piScript = writeScript(
		"pi.sh",
		[
			`cd ${shq(PROJECT)}`,
			`PATH=${shq(panePath)} \\`,
			`HOME=${shq(PI_HOME)} \\`,
			`PI_CODING_AGENT_DIR=${shq(PI_AGENT)} \\`,
			`ANNOTATE_EDITOR_PROBE=${shq(EDITOR)} \\`,
			`TERM=xterm-256color \\`,
			`${shq(path.join(PI_BIN, "pi"))} --provider fake --model fake-model --extension ${shq(PI_INDEX)} --extension ${shq(PROBE)}`,
			"echo PI_EXITED=$?",
		],
	);
	await shellReady(piPane);
	await shellReady(attachPane);
	herdr("pane", "run", piPane, `bash ${shq(piScript)}`);

	const started = await waitFor(() => editor()?.session, 60000);
	check("pi started with the annotation extension", Boolean(started), flat(readPane(piPane)).slice(-500));
	if (!started) return;

	herdr("pane", "run", piPane, "Check the cache");
	const answered = await waitFor(() => (flat(readPane(piPane)).includes("It evicts the oldest entry first") ? true : undefined), 60000);
	check("the fake model answered through a tool call", Boolean(answered), flat(readPane(piPane)).slice(-500));

	herdr("pane", "run", piPane, "/annotate tui");
	const notice = await waitFor(() => {
		const text = flat(readPane(piPane));
		return text.includes("annotate: TUI session live on 127.0.0.1:") && text.includes("Attach from another terminal:") ? text : undefined;
	}, 15000);
	check("/annotate tui printed the attach notice", Boolean(notice), flat(readPane(piPane)).slice(-500));
	check("the notice points at the shipped bin path", Boolean(notice?.includes("bin/pi-annotation.ts")), notice?.slice(-300));
	check("no browser was opened", !fs.existsSync(OPENED) || fs.readFileSync(OPENED, "utf8").trim() === "", fs.existsSync(OPENED) ? fs.readFileSync(OPENED, "utf8") : "");

	const record = await waitFor(() => {
		const names = registryNames();
		if (names.length !== 1) return undefined;
		const file = path.join(REGISTRY, names[0]);
		try {
			return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
		} catch {
			return undefined;
		}
	}, 10000);
	check("the session registry holds one record", Boolean(record), registryNames().join(", ") || "no registry dir");
	check(
		"the record matches the pi session",
		record?.data.sessionId === started && record?.data.cwd === PROJECT && record?.data.pid > 0 && record?.data.port > 0 && typeof record?.data.token === "string",
		JSON.stringify(record?.data),
	);
	check("the record file is named after the pi pid", Boolean(record) && path.basename(record.file) === `${record.data.pid}.json`, record?.file);
	if (!record) return;

	const attachScript = writeScript(
		"attach.sh",
		[
			`PATH=${shq(panePath)} \\`,
			`HOME=${shq(PI_HOME)} \\`,
			`PI_CODING_AGENT_DIR=${shq(PI_AGENT)} \\`,
			`TERM=xterm-256color \\`,
			`${shq(BIN)} ${record.data.sessionId}`,
			"echo ATTACH_EXITED=$?",
		],
	);
	herdr("pane", "run", attachPane, `bash ${shq(attachScript)}`);

	const attached = await waitFor(() => {
		const text = flat(readPane(attachPane));
		return text.includes("pi-annotation") && text.includes("cache is LRU") ? text : undefined;
	}, 30000);
	check("the bin attached and shows the conversation", Boolean(attached), flat(readPane(attachPane)).slice(-500));

	herdr("pane", "send-keys", attachPane, "v");
	await sleep(300);
	herdr("pane", "send-keys", attachPane, "a");
	const noteMode = await waitFor(() => (flat(readPane(attachPane)).includes("NOTE") ? true : undefined), 10000);
	check("v then a opened the note box on the selection", Boolean(noteMode), flat(readPane(attachPane)).slice(-400));
	herdr("pane", "send-text", attachPane, "e2e-note");
	await sleep(300);
	herdr("pane", "send-keys", attachPane, "enter");

	const before = await requestCount();
	herdr("pane", "send-keys", attachPane, "s");
	const inserted = await waitFor(() => {
		const state = editor();
		return state && typeof state.editor === "string" && state.editor.includes("e2e-note") ? state : undefined;
	}, 10000);
	check("s appended the quote and note to the pi editor", inserted?.editor === "> T\n\ne2e-note\n\n", JSON.stringify(inserted?.editor));
	const after = await requestCount();
	check("sending made no model request", after === before, `${before} -> ${after}`);

	herdr("pane", "send-keys", piPane, "ctrl+c");
	const cleared = await waitFor(() => (editor()?.editor === "" ? true : undefined), 10000);
	check("ctrl+c cleared the annotation from the pi editor", Boolean(cleared), JSON.stringify(editor()));

	herdr("pane", "run", piPane, "markdown cache overview");
	const markdown = await waitFor(() => (flat(readPane(piPane)).includes("this is not a diagram") ? true : undefined), 60000);
	check("the fake model answered with the mermaid markdown reply", Boolean(markdown), flat(readPane(piPane)).slice(-500));

	const arrived = await waitFor(() => {
		herdr("pane", "send-keys", attachPane, "G");
		const text = flat(readPane(attachPane));
		return text.includes("this is not a diagram") ? text : undefined;
	}, 30000, 1000);
	check("the markdown reply reached the attach TUI", Boolean(arrived), flat(readPane(attachPane)).slice(-500));

	herdr("pane", "send-keys", attachPane, "/");
	await sleep(300);
	herdr("pane", "send-text", attachPane, "flowchart TD");
	await sleep(300);
	herdr("pane", "send-keys", attachPane, "enter");
	const sourceShown = await waitFor(() => (flat(readPane(attachPane)).includes("flowchart TD") ? true : undefined), 10000);
	check("searching the diagram source switched the block to its source", Boolean(sourceShown), flat(readPane(attachPane)).slice(-400));
	herdr("pane", "send-keys", attachPane, "enter");
	const artShown = await waitFor(() => (flat(readPane(attachPane)).includes(DIAGRAM_REQUEST_LINE) ? true : undefined), 10000);
	check("Enter switched the block back to its diagram", Boolean(artShown), flat(readPane(attachPane)).slice(-400));
	const renderedPane = flat(readPane(attachPane));
	check("the attach pane shows the flowchart art, not its source", renderedPane.includes(DIAGRAM_RESULT_LINE) && !renderedPane.includes("flowchart TD"), renderedPane.slice(-600));

	herdr("pane", "send-keys", attachPane, "a");
	const diagramNote = await waitFor(() => (flat(readPane(attachPane)).includes("NOTE") ? true : undefined), 10000);
	check("a opened the note box on the diagram", Boolean(diagramNote), flat(readPane(attachPane)).slice(-400));
	herdr("pane", "send-text", attachPane, "e2e-diagram-note");
	await sleep(300);
	herdr("pane", "send-keys", attachPane, "enter");

	const beforeDiagram = await requestCount();
	herdr("pane", "send-keys", attachPane, "s");
	const insertedDiagram = await waitFor(() => {
		const state = editor();
		return state && typeof state.editor === "string" && state.editor.includes("e2e-diagram-note") ? state : undefined;
	}, 10000);
	check("s appended the diagram fence and note to the pi editor", insertedDiagram?.editor === EXPECTED_DIAGRAM_QUOTE, JSON.stringify(insertedDiagram?.editor));
	const afterDiagram = await requestCount();
	check("sending the diagram note made no model request", afterDiagram === beforeDiagram, `${beforeDiagram} -> ${afterDiagram}`);

	herdr("pane", "send-keys", piPane, "ctrl+c");
	const diagramCleared = await waitFor(() => (editor()?.editor === "" ? true : undefined), 10000);
	check("ctrl+c cleared the diagram quote from the pi editor", Boolean(diagramCleared), JSON.stringify(editor()));

	herdr("pane", "run", piPane, "Tell me about eviction");
	const second = await waitFor(() => (flat(readPane(piPane)).includes("Old keys leave in order") ? true : undefined), 60000);
	check("the fake model answered the second prompt", Boolean(second), flat(readPane(piPane)).slice(-500));
	const live = await waitFor(() => {
		herdr("pane", "send-keys", attachPane, "G");
		const text = flat(readPane(attachPane));
		return text.includes("Old keys leave in order") ? text : undefined;
	}, 30000, 1000);
	check("the new reply appeared live in the attach TUI", Boolean(live), flat(readPane(attachPane)).slice(-500));

	herdr("pane", "send-keys", attachPane, "q");
	const exited = await waitFor(() => (flat(readPane(attachPane)).includes("ATTACH_EXITED=0") ? true : undefined), 15000);
	check("q exited the TUI cleanly", Boolean(exited), flat(readPane(attachPane)).slice(-400));
	check("pi is still running after the TUI quit", !flat(readPane(piPane)).includes("PI_EXITED"), flat(readPane(piPane)).slice(-400));

	herdr("pane", "run", piPane, "/annotate");
	const stopped = await waitFor(() => (registryNames().length === 0 ? true : undefined), 15000);
	check("/annotate removed the session registry record", Boolean(stopped), registryNames().join(", ") || "no registry dir");
	const closed = await waitFor(() => (flat(readPane(piPane)).includes("annotate: closed") ? true : undefined), 10000);
	check("/annotate reported the server closed", Boolean(closed), flat(readPane(piPane)).slice(-400));
}

(async () => {
	try {
		await run();
	} catch (error) {
		check("the driver finished without an unexpected error", false, error && error.message ? error.message : String(error));
	}
	console.log(failures === 0 ? "PASS all checks" : `FAIL ${failures} check(s)`);
	process.exit(failures === 0 ? 0 : 1);
})();
JS
