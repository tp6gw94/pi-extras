import { type Component, Container, ScrollView, type TuiMode, VStack } from "@earendil-works/pi-tui";
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
	header.addChild(linesComponent(["Header"]));
	resources.addChild(linesComponent(["Resources"]));
	for (const component of options.messages ?? [linesComponent(["alpha 中文 👨‍👩‍👧", "beta gamma", "last row"])]) chat.addChild(component);
	for (const component of [header, resources, chat]) document.addChild(component);
	const view = new ScrollView(document, { follow: "end", primary: true });
	const root = new VStack([
		{ component: view, basis: 0, grow: 1, minSize: 1 },
		{ component: editor, basis: "auto", minSize: 3 },
	]);
	let rendering = false;
	const requests: { duringRender: boolean }[] = [];
	let resets = 0;
	const tui = {
		mode: "fullscreen" as TuiMode,
		children: [document, editor],
		terminal: { rows: options.rows ?? 24, columns: options.columns ?? 120 },
		getPrimaryScrollView: (): unknown => view,
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
	return { tui, header, resources, chat, document, editor, view, root, draw, content, requests, resets: () => resets };
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
