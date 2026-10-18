#!/usr/bin/env -S node --experimental-strip-types
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ViewportTUI } from "@earendil-works/pi-tui";
import { agentDirFromEnv, listEntries, pickEntry, registryDir, type SessionEntry } from "../registry.ts";
import { AnnotateApp, type TuiLib } from "../tui/app.ts";
import { createClient, disconnectReason } from "../tui/client.ts";

const USAGE = `Usage: pi-annotation [session-id-part]
       pi-annotation --interactive
       pi-annotation --list
       pi-annotation --help

Attach a terminal annotation view to a pi session started with /annotate.
Any unique part of the session id works. Without one it attaches to the only
live session, or to the only one started in the current directory.
--interactive selects a live session in this exact directory with arrows and Enter.
Escape or Ctrl-C cancels.`;

function describe(entry: SessionEntry): string {
	return `${entry.sessionId}  ${entry.cwd}  port ${entry.port}  pid ${entry.pid}  since ${entry.startedAt}`;
}

let app: AnnotateApp | undefined;
let tui: ViewportTUI | undefined;
let exiting = false;

function shutdown(code: number): void {
	if (exiting) return;
	exiting = true;
	app?.stop();
	tui?.stop({ preserveScreen: true });
	process.exit(code);
}

function fail(error: unknown): void {
	console.error(`pi-annotation: ${error instanceof Error ? error.message : String(error)}`);
	shutdown(1);
}

async function loadTui(entry: SessionEntry): Promise<TuiLib> {
	if (!entry.tuiModule) throw new Error("this session recorded no pi-tui module; run /annotate from a pi install that can resolve @earendil-works/pi-tui");
	return (await import(pathToFileURL(entry.tuiModule).href)) as TuiLib;
}

async function selectInteractive(entries: readonly SessionEntry[]): Promise<SessionEntry | undefined> {
	const lib = await loadTui(entries[0]!);
	const terminal = new lib.TuiAltScreen(new lib.ProcessTerminal(), true, undefined, { mouse: false });
	tui = terminal;
	const plain = (text: string) => text;
	const items = entries.map((entry, index) => ({
		value: String(index),
		label: `${entry.sessionId}  since ${entry.startedAt}  port ${entry.port}`,
	}));
	try {
		return await new Promise<SessionEntry | undefined>((resolve) => {
			const build = (maxVisible: number, selected: number) => {
				const next = new lib.SelectList(items, maxVisible, {
					selectedPrefix: plain,
					selectedText: (text) => `\x1b[7m${text}\x1b[0m`,
					description: plain,
					scrollInfo: plain,
					noMatch: plain,
				});
				next.setSelectedIndex(selected);
				next.onSelect = (item) => resolve(entries[Number(item.value)]);
				next.onCancel = () => resolve(undefined);
				return next;
			};
			const visibleRows = () => Math.max(1, terminal.terminal.rows - 2);
			let height = visibleRows();
			let list = build(height, 0);
			const component = {
				render: (width: number) => {
					if (height !== visibleRows()) {
						height = visibleRows();
						list = build(height, Number(list.getSelectedItem()!.value));
					}
					return [lib.truncateToWidth("Select session · arrows / Enter · Esc / Ctrl-C cancel", width), ...list.render(width)];
				},
				invalidate: () => list.invalidate(),
				handleInput: (data: string) => list.handleInput(data),
			};
			terminal.setLayoutRoot(component);
			terminal.setFocus(component);
			terminal.start();
		});
	} finally {
		terminal.stop();
		tui = undefined;
	}
}

async function attach(entry: SessionEntry): Promise<void> {
	const lib = await loadTui(entry);
	const client = createClient(entry);
	const snapshot = await client.snapshot().catch((error: unknown) => {
		throw new Error(disconnectReason(error));
	});
	tui = new lib.TuiAltScreen(new lib.ProcessTerminal(), true, undefined, { mouse: false });
	app = new AnnotateApp({
		lib,
		tui,
		client,
		snapshot,
		title: (sessionId) => `pi-annotation · ${basename(entry.cwd) || entry.cwd} · ${sessionId.slice(-8)}`,
		onExit: () => shutdown(0),
	});
	tui.setLayoutRoot(app);
	tui.setFocus(app);
	tui.start();
	app.start();
}

async function main(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(USAGE);
		return 0;
	}
	const entries = listEntries(registryDir(agentDirFromEnv(process.env)));
	if (argv.includes("-l") || argv.includes("--list")) {
		for (const entry of entries) console.log(describe(entry));
		return 0;
	}
	if (argv.includes("--interactive")) {
		if (argv.length !== 1) throw new Error("--interactive cannot be combined with a session id or other arguments");
		const here = entries.filter((entry) => entry.cwd === process.cwd());
		if (here.length === 0) throw new Error("no live annotate session in this directory; run /annotate in pi first");
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--interactive requires a TTY on stdin and stdout");
		const selected = here.length === 1 ? here[0] : await selectInteractive(here);
		if (selected) await attach(selected);
		return 0;
	}
	const picked = pickEntry(entries, argv[0], process.cwd());
	if (typeof picked === "string") {
		console.error(`pi-annotation: ${picked}`);
		for (const entry of entries) console.error(`  ${describe(entry)}`);
		return 1;
	}
	await attach(picked);
	return 0;
}

process.once("SIGTERM", () => shutdown(143));
process.on("uncaughtException", fail);

try {
	const code = await main(process.argv.slice(2));
	if (code !== 0) shutdown(code);
} catch (error) {
	fail(error);
}
