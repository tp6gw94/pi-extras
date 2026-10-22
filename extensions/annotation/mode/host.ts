import { type Component, Container, ScrollView, type TUI } from "@earendil-works/pi-tui";
import type { BlockId, Viewport } from "./data.ts";
import { Transcript } from "./transcript.ts";

export interface BlockRegistry {
	readonly blocks: WeakMap<object, BlockId>;
	nextBlock: number;
}

export interface Refusal {
	readonly refused: string;
}

export interface Hooks {
	onCapture(doc: Transcript): void;
	paint(rows: string[], doc: Transcript): readonly string[];
	alive(frame: number): boolean;
	onEvicted(): void;
	onFullscreenLeft(): void;
}

export interface Attachment {
	readonly doc: Transcript;
	readonly frame: number;
	viewport(): Viewport;
	scrollTo(top: number): void;
	stillFullscreen(): boolean;
	detach(): void;
}

interface MouseLayout {
	width: number;
	children: { component: Component; height: number }[];
}

type RenderedContainer = Omit<Container, "mouseLayout"> & { mouseLayout: MouseLayout };
type Host = TUI & { getPrimaryScrollView(): unknown; resetTextSelection(): void };

export function attach(tui: unknown, registry: BlockRegistry, hooks: Hooks): Attachment | Refusal {
	const host = tui as Partial<Host> | undefined;
	if (host?.mode !== "fullscreen") return { refused: "needs fullscreen mode" };
	const container = host.children?.[0];
	const unsupported = { refused: "this pi version's transcript layout is not supported" };
	if (!(container instanceof Container) || !(container.children.at(-1) instanceof Container)) return unsupported;
	const document = container as unknown as RenderedContainer;
	const chat = container.children.at(-1) as unknown as RenderedContainer;
	if (!document.mouseLayout || typeof host.getPrimaryScrollView !== "function" || typeof host.resetTextSelection !== "function" || typeof host.requestRender !== "function") return unsupported;
	const scrollView = host.getPrimaryScrollView();
	if (!(scrollView instanceof ScrollView)) return unsupported;
	const t = host as Host;
	const original = chat.render;
	const ownRender = Object.getOwnPropertyDescriptor(chat, "render");
	let phase: "active" | "pending" | "detached" = "active";
	let frame = 0;
	const capture = (width: number, rows: string[]): Transcript => new Transcript({
		width,
		rows,
		blocks: chat.mouseLayout.children.map(({ component, height }) => {
			let id = registry.blocks.get(component);
			if (id === undefined) {
				id = registry.nextBlock++ as BlockId;
				registry.blocks.set(component, id);
			}
			return { id, height };
		}),
	});
	let latest = capture(document.mouseLayout.width, original.call(chat, document.mouseLayout.width));
	const chatStart = (): number => {
		let start = 0;
		for (const child of document.mouseLayout.children) {
			if (child.component === chat) break;
			start += child.height;
		}
		return start;
	};
	const detach = (): void => {
		if (phase === "detached") return;
		phase = "detached";
		if (chat.render === wrapper) {
			if (ownRender) Object.defineProperty(chat, "render", ownRender);
			else Reflect.deleteProperty(chat, "render");
		}
		scrollView.scrollTo(scrollView.scrollTop);
		t.requestRender();
	};
	const retire = (after: () => void): void => {
		phase = "pending";
		queueMicrotask(() => {
			if (phase !== "pending") return;
			detach();
			after();
		});
	};
	const wrapper = (width: number): string[] => {
		const rows = original.call(chat, width);
		if (phase !== "active") return rows;
		if (t.mode !== "fullscreen") {
			retire(hooks.onFullscreenLeft);
			return rows;
		}
		frame++;
		if (!hooks.alive(frame)) {
			retire(hooks.onEvicted);
			return rows;
		}
		latest = capture(width, rows);
		hooks.onCapture(latest);
		return hooks.paint(rows, latest) as string[];
	};
	t.resetTextSelection();
	scrollView.scrollTo(scrollView.scrollTop, { disableFollow: true });
	chat.render = wrapper;
	return {
		get doc() {
			const width = document.mouseLayout.width;
			if (latest.width !== width) latest = capture(width, original.call(chat, width));
			return latest;
		},
		get frame() { return frame; },
		viewport: () => ({ top: scrollView.scrollTop - chatStart(), height: scrollView.viewportHeight }),
		scrollTo: (top) => {
			scrollView.scrollTo(top + chatStart(), { disableFollow: true });
			t.requestRender();
		},
		stillFullscreen: () => t.mode === "fullscreen",
		detach,
	};
}

export function isRefusal(result: Attachment | Refusal): result is Refusal {
	return "refused" in result;
}
