import { stripControls } from "../ux/core/strip-controls.ts";

export type SnapshotKind = "user" | "assistant" | "tool";

export interface SnapshotItem {
	id: string;
	kind: SnapshotKind;
	label: string;
	text: string;
}

export interface Snapshot {
	takenAt: string;
	items: SnapshotItem[];
}

interface EntryLike {
	type?: string;
	id?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

type Part = { type?: string; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

function parts(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content.filter((p) => p && typeof p === "object") as Part[]) : [];
}

function textOf(content: unknown): string {
	return parts(content)
		.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : p.type === "image" ? "[image]" : ""))
		.filter((t) => t !== "")
		.join("\n");
}

function argumentSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "url", "query"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return oneLine(value);
	}
	return "";
}

function oneLine(text: string, max = 80): string {
	const line = stripControls(text).replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function lineCount(text: string): string {
	const lines = text.split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

export function buildSnapshot(branch: readonly unknown[], now = new Date()): Snapshot {
	const calls = new Map<string, Part>();
	const items: SnapshotItem[] = [];
	branch.forEach((raw, index) => {
		const entry = raw as EntryLike;
		if (entry?.type !== "message" || !entry.message) return;
		const message = entry.message;
		const id = typeof entry.id === "string" ? entry.id : String(index);
		if (message.role === "assistant") {
			for (const part of parts(message.content)) {
				if (part.type === "toolCall" && typeof part.id === "string") calls.set(part.id, part);
			}
		}
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
		const text = stripControls(textOf(message.content)).replace(/\s+$/, "");
		if (text.trim() === "") return;
		if (message.role === "user") items.push({ id, kind: "user", label: "You", text });
		else if (message.role === "assistant") items.push({ id, kind: "assistant", label: "Assistant", text });
		else {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			const name = oneLine(String(message.toolName ?? call?.name ?? "tool"), 40);
			const summary = argumentSummary(call?.arguments);
			const label = `Tool ${name}${summary ? ` ${summary}` : ""}${message.isError ? " (error)" : ""} · ${lineCount(text)}`;
			items.push({ id, kind: "tool", label, text });
		}
	});
	return { takenAt: now.toISOString(), items };
}
