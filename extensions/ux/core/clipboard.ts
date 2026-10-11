export type ExecFn = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface ClipboardTool {
	name: string;
	command: string;
	args: string[];
}

export const CLIPBOARD_TOOLS: readonly ClipboardTool[] = [
	{ name: "pbpaste", command: "pbpaste", args: [] },
	{ name: "wl-paste", command: "wl-paste", args: ["--no-newline"] },
	{ name: "xclip", command: "xclip", args: ["-selection", "clipboard", "-o"] },
	{ name: "xsel", command: "xsel", args: ["--clipboard", "--output"] },
];

export const CLIPBOARD_TIMEOUT_MS = 1500;

export type ClipboardResult =
	| { ok: true; text: string; tool: string }
	| { ok: false; reason: "empty"; tool: string; tried: string[] }
	| { ok: false; reason: "unavailable"; tried: string[] };

export async function readClipboard(
	exec: ExecFn,
	opts: { tools?: readonly ClipboardTool[]; timeoutMs?: number; cwd?: string } = {},
): Promise<ClipboardResult> {
	const tried: string[] = [];
	for (const tool of opts.tools ?? CLIPBOARD_TOOLS) {
		tried.push(tool.name);
		let r: Awaited<ReturnType<ExecFn>>;
		try {
			r = await exec(tool.command, tool.args, { timeout: opts.timeoutMs ?? CLIPBOARD_TIMEOUT_MS, cwd: opts.cwd });
		} catch {
			continue;
		}
		if (r.killed || r.code !== 0) continue;
		if (r.stdout.trim() === "") return { ok: false, reason: "empty", tool: tool.name, tried };
		return { ok: true, text: r.stdout, tool: tool.name };
	}
	return { ok: false, reason: "unavailable", tried };
}

export function clipboardFailureMessage(r: Exclude<ClipboardResult, { ok: true }>): string {
	if (r.reason === "empty") return `pi-ux: the clipboard is empty (read with ${r.tool}). Nothing inserted.`;
	return `pi-ux: could not read the clipboard (tried ${r.tried.join(", ")}). Nothing inserted.`;
}
