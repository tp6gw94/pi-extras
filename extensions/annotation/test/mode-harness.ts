import { type Component, Container, ScrollView, type Terminal, TuiAltScreen, type TuiMode, VStack } from "@earendil-works/pi-tui";
import { createInteractiveTuiReference } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { getScrollViewBox, renderLayoutFrame } from "../../../node_modules/@earendil-works/pi-tui/dist/layout.js";

export function linesComponent(lines: string[]): Component {
	return { render: (width) => lines.map((line) => line.padEnd(width)), invalidate: () => {} };
}

export function hostHarness(options: { rows?: number; columns?: number; messages?: Component[] } = {}) {
	const header = new Container();
	const resources = new Container();
	const chat = new Container();
	const document = new Container();
	const editor = new Container();
	const dockSibling = new Container();
	const core = linesComponent(["Editor"]);
	editor.addChild(core);
	header.addChild(linesComponent(["Header"]));
	resources.addChild(linesComponent(["Resources"]));
	for (const component of options.messages ?? [linesComponent(["alpha 中文 👨‍👩‍👧", "beta gamma", "last row"])]) chat.addChild(component);
	for (const component of [header, resources, chat]) document.addChild(component);
	const view = new ScrollView(document, { follow: "end", primary: true });
	const root = new VStack([
		{ component: view, basis: 0, grow: 1, minSize: 1 },
		{ component: editor, basis: "auto", minSize: 3 },
		{ component: dockSibling, basis: "auto" },
	]);
	let rendering = false;
	const requests: { duringRender: boolean }[] = [];
	let resets = 0;
	const children: Component[] = [document, new Container(), new Container(), new Container(), editor, new Container(), new Container()];
	const tui = {
		mode: "fullscreen" as TuiMode,
		children,
		terminal: { rows: options.rows ?? 24, columns: options.columns ?? 120 },
		getPrimaryScrollView: (): unknown => view,
		getFocusedComponent: (): Component | null => core,
		resetTextSelection: () => { resets++; },
		requestRender: () => { requests.push({ duringRender: rendering }); },
	};
	const draw = () => {
		rendering = true;
		try {
			return renderLayoutFrame(root, tui.terminal.columns, tui.terminal.rows, tui.requestRender);
		} finally {
			rendering = false;
		}
	};
	const content = () => getScrollViewBox(draw(), view)!.scrollContentLines!;
	draw();
	return { tui, header, resources, chat, document, editor, dockSibling, view, root, draw, content, requests, resets: () => resets };
}

export function fullscreenHarness(options: Parameters<typeof hostHarness>[0] = {}) {
	const host = hostHarness(options);
	let input!: (data: string) => void;
	const terminal: Terminal = {
		...host.tui.terminal,
		kittyProtocolActive: false,
		start: (onInput) => { input = onInput; },
		stop: () => {},
		drainInput: async () => {},
		write: () => {},
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
	};
	const renderer = new TuiAltScreen(terminal, false, undefined, { scrollToEndIndicator: () => " ↓ Jump to latest message " });
	let current = renderer;
	const tui = createInteractiveTuiReference(() => current);
	for (const child of host.tui.children) renderer.addChild(child);
	renderer.setLayoutRoot(host.root);
	renderer.setFocus(host.editor.children[0]);
	renderer.start();
	renderer.renderNow();
	return { ...host, tui, renderer, terminal, input: (data: string) => input(data), switchRenderer: (next: typeof renderer) => { current = next; } };
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
