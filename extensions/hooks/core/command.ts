import { matchAny } from "./glob.ts";
import type { HookRule } from "./config.ts";

export function shellQuote(word: string): string {
	if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Make a file path safe to pass as a command argument: a relative path starting with
 * `-` (e.g. `--fix.ts`) would be parsed as an option by eslint/ruff/etc., so prefix `./`.
 */
export function safeFileArg(file: string): string {
	return file.startsWith("-") ? `./${file}` : file;
}

export function substituteFiles(command: string, files: readonly string[]): string {
	if (!command.includes("{files}")) return command;
	const list = files.map((f) => shellQuote(safeFileArg(f))).join(" ");
	return command.split("{files}").join(list);
}

export function filesForRule(rule: HookRule, files: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of files) {
		if (!seen.has(f) && matchAny(rule.globs, f)) {
			seen.add(f);
			out.push(f);
		}
	}
	return out;
}

export function routeFiles(rules: readonly HookRule[], files: readonly string[]): { rule: HookRule; files: string[] }[] {
	const out: { rule: HookRule; files: string[] }[] = [];
	for (const rule of rules) {
		const matched = filesForRule(rule, files);
		if (matched.length > 0) out.push({ rule, files: matched });
	}
	return out;
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

export function truncateOutput(text: string, maxChars: number): string {
	const t = stripAnsi(text).replace(/\r\n/g, "\n").trimEnd();
	if (t.length <= maxChars) return t;
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	const cut = t.length - head - tail;
	return `${t.slice(0, head)}\n… [${cut} chars truncated] …\n${t.slice(t.length - tail)}`;
}
