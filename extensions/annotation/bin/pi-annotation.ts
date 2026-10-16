#!/usr/bin/env -S node --experimental-strip-types
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ViewportTUI } from "@earendil-works/pi-tui";
import { agentDirFromEnv, listEntries, pickEntry, registryDir, type SessionEntry } from "../registry.ts";
import { AnnotateApp, type TuiLib } from "../tui/app.ts";
import { createClient, disconnectReason } from "../tui/client.ts";

const USAGE = `Usage: pi-annotation [session-id-part]
       pi-annotation --list
       pi-annotation --help

Attach a terminal annotation view to a pi session started with /annotate tui.
Any unique part of the session id works. Without one it attaches to the only
live session, or to the only one started in the current directory.`;

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

async function attach(entry: SessionEntry): Promise<void> {
	if (!entry.tuiModule) throw new Error("this session recorded no pi-tui module; run /annotate tui from a pi install that can resolve @earendil-works/pi-tui");
	const lib = (await import(pathToFileURL(entry.tuiModule).href)) as TuiLib;
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
		title: `pi-annotation · ${basename(entry.cwd) || entry.cwd} · ${entry.sessionId.slice(-8)}`,
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
