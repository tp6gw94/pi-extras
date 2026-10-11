import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

export const COLUMNS = 80;
export const ROWS = 24;

export function fakeTerminal(columns = COLUMNS, rows = ROWS) {
	let onInput: (data: string) => void = () => {};
	const terminal = {
		start(input: (data: string) => void) {
			onInput = input;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		get kittyProtocolActive() {
			return false;
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	return { terminal, send: (data: string) => onInput(data) };
}

/** pi's own proxy around the active renderer, from the installed pi-coding-agent. */
export async function piTuiReference(): Promise<(get: () => unknown) => unknown> {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const file = join(dirname(entry), "modes", "interactive", "tui-renderer.js");
	const mod = await import(pathToFileURL(file).href);
	return mod.createInteractiveTuiReference;
}

export function startAltScreen(opts: { copyOnSelect: boolean; lines?: string[] }) {
	const term = fakeTerminal();
	const copied: string[] = [];
	const screen = new TuiAltScreen(term.terminal as never, false, undefined, {
		copyOnSelect: opts.copyOnSelect,
		copySelection: async (text: string) => {
			copied.push(text);
			return true;
		},
	});
	screen.addChild(new Text((opts.lines ?? ["alpha beta gamma delta", "second line of text", "third line"]).join("\n"), 0, 0));
	screen.start();
	return { screen, send: term.send, copied, stop: () => screen.stop() };
}

export function startMainScreen() {
	const term = fakeTerminal();
	const screen = new TuiMainScreen(term.terminal as never, false);
	return { screen, stop: () => screen.stop() };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** SGR mouse drag with 0-based cells, as a terminal sends it. */
export function drag(send: (data: string) => void, from: [number, number], to: [number, number]) {
	send(`\x1b[<0;${from[0] + 1};${from[1] + 1}M`);
	send(`\x1b[<32;${to[0] + 1};${to[1] + 1}M`);
	send(`\x1b[<0;${to[0] + 1};${to[1] + 1}m`);
}
