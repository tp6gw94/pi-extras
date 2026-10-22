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
	readonly dock: Component;
	onCapture(doc: Transcript): void;
	paint(rows: string[], doc: Transcript): readonly string[];
	onEvicted(): void;
	onFullscreenLeft(): void;
}

export interface Attachment {
	readonly doc: Transcript;
	activate(): boolean;
	ownsEditor(): boolean;
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
type Host = TUI & { getPrimaryScrollView(): unknown; getFocusedComponent(): Component | null; resetTextSelection(): void };

export function attach(tui: unknown, registry: BlockRegistry, hooks: Hooks): Attachment | Refusal {
	const host = tui as Partial<Host> | undefined;
	if (host?.mode !== "fullscreen") return { refused: "needs fullscreen mode" };
	const container = host.children?.[0];
	const unsupported = { refused: "this pi version's transcript layout is not supported" };
	if (!(container instanceof Container) || !(container.children.at(-1) instanceof Container) || typeof host.getFocusedComponent !== "function") return unsupported;
	const focused = host.getFocusedComponent();
	const slots = host.children!.filter((child): child is Container => child instanceof Container && child !== container && child.children.length === 1 && child.children[0] === focused);
	if (slots.length !== 1) return unsupported;
	const editor = slots[0];
	const document = container as unknown as RenderedContainer;
	const chat = container.children.at(-1) as unknown as RenderedContainer;
	if (!document.mouseLayout || typeof host.getPrimaryScrollView !== "function" || typeof host.resetTextSelection !== "function" || typeof host.requestRender !== "function") return unsupported;
	const scrollView = host.getPrimaryScrollView();
	if (!(scrollView instanceof ScrollView)) return unsupported;
	const t = host as Host;
	const original = chat.render;
	const ownRender = Object.getOwnPropertyDescriptor(chat, "render");
	let phase: "prepared" | "active" | "pending" | "detached" = "prepared";
	const follow: { followEnd: boolean } = scrollView;
	const originalFollow = follow.followEnd;
	const ownsEditor = (): boolean => editor.children.length === 1 && editor.children[0] === hooks.dock;
	const idOf = (component: Component): BlockId => {
		let id = registry.blocks.get(component);
		if (id === undefined) {
			id = registry.nextBlock++ as BlockId;
			registry.blocks.set(component, id);
		}
		return id;
	};
	const capture = (width: number, rows: string[]): Transcript => new Transcript({
		width,
		rows,
		blocks: chat.mouseLayout.children.map(({ component, height }) => ({ id: idOf(component), height })),
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
		if (phase !== "prepared") {
			follow.followEnd = originalFollow;
			scrollView.scrollTo(scrollView.scrollTop);
		}
		phase = "detached";
		if (chat.render === wrapper) {
			if (ownRender) Object.defineProperty(chat, "render", ownRender);
			else Reflect.deleteProperty(chat, "render");
		}
		t.requestRender();
	};
	const retire = (after: () => void): void => {
		phase = "pending";
		queueMicrotask(() => {
			if (phase !== "pending") return;
			const complete = ownsEditor() ? after : hooks.onEvicted;
			detach();
			complete();
		});
	};
	const wrapper = (width: number): string[] => {
		const rows = original.call(chat, width);
		if (phase !== "active") return rows;
		if (!ownsEditor()) {
			retire(hooks.onEvicted);
			return rows;
		}
		if (t.mode !== "fullscreen") {
			retire(hooks.onFullscreenLeft);
			return rows;
		}
		latest = capture(width, rows);
		hooks.onCapture(latest);
		return hooks.paint(rows, latest) as string[];
	};
	chat.render = wrapper;
	return {
		get doc() {
			const width = document.mouseLayout.width;
			if (latest.width !== width) latest = capture(width, original.call(chat, width));
			return latest;
		},
		activate: () => {
			if (phase !== "prepared" || !ownsEditor() || t.mode !== "fullscreen") return false;
			phase = "active";
			t.resetTextSelection();
			follow.followEnd = false;
			scrollView.scrollTo(scrollView.scrollTop, { disableFollow: true });
			return true;
		},
		ownsEditor,
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
