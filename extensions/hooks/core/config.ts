export const CONFIG_RELATIVE_PATH = ".pi/hooks.json";
export const DEFAULT_AFTER_WRITE_TIMEOUT_MS = 30_000;
export const DEFAULT_BEFORE_SETTLE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_FIX_ATTEMPTS = 3;
export const DEFAULT_MAX_OUTPUT_CHARS = 4_000;

export const TOP_LEVEL_KEYS = ["afterWrite", "beforeSettle", "maxFixAttempts", "maxOutputChars"] as const;
export const RULE_KEYS = ["glob", "command", "timeoutMs", "name"] as const;

export interface HookRule {
	globs: string[];
	command: string;
	timeoutMs: number;
	name: string;
}

export interface HooksConfig {
	afterWrite: HookRule[];
	beforeSettle: HookRule[];
	maxFixAttempts: number;
	maxOutputChars: number;
}

export interface ParseResult {
	config: HooksConfig;
	errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function parseRules(raw: unknown, section: string, defaultTimeout: number, errors: string[]): HookRule[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		errors.push(`${section}: expected an array of rules`);
		return [];
	}
	const rules: HookRule[] = [];
	raw.forEach((item, i) => {
		const where = `${section}[${i}]`;
		if (!isRecord(item)) {
			errors.push(`${where}: expected an object`);
			return;
		}
		for (const key of Object.keys(item)) {
			if (!(RULE_KEYS as readonly string[]).includes(key)) errors.push(`${where}: unknown key "${key}" ignored`);
		}
		const globRaw = item.glob;
		const globs =
			typeof globRaw === "string"
				? [globRaw]
				: Array.isArray(globRaw) && globRaw.every((g) => typeof g === "string")
					? (globRaw as string[])
					: undefined;
		if (!globs || globs.length === 0 || globs.some((g) => g.trim() === "")) {
			errors.push(`${where}: "glob" must be a non-empty string or array of strings`);
			return;
		}
		if (typeof item.command !== "string" || item.command.trim() === "") {
			errors.push(`${where}: "command" must be a non-empty string`);
			return;
		}
		let timeoutMs = defaultTimeout;
		if (item.timeoutMs !== undefined) {
			const t = positiveInt(item.timeoutMs);
			if (t === undefined) errors.push(`${where}: "timeoutMs" must be a positive number; using ${defaultTimeout}`);
			else timeoutMs = t;
		}
		const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.command.trim();
		rules.push({ globs, command: item.command, timeoutMs, name });
	});
	return rules;
}

export function parseConfig(text: string): ParseResult {
	const errors: string[] = [];
	const empty: HooksConfig = {
		afterWrite: [],
		beforeSettle: [],
		maxFixAttempts: DEFAULT_MAX_FIX_ATTEMPTS,
		maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
	};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		errors.push(`invalid JSON: ${(err as Error).message}`);
		return { config: empty, errors };
	}
	if (!isRecord(raw)) {
		errors.push("top level must be an object");
		return { config: empty, errors };
	}
	const known = new Set<string>(["$schema", ...TOP_LEVEL_KEYS]);
	for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`unknown key "${key}" ignored`);

	const config: HooksConfig = {
		afterWrite: parseRules(raw.afterWrite, "afterWrite", DEFAULT_AFTER_WRITE_TIMEOUT_MS, errors),
		beforeSettle: parseRules(raw.beforeSettle, "beforeSettle", DEFAULT_BEFORE_SETTLE_TIMEOUT_MS, errors),
		maxFixAttempts: DEFAULT_MAX_FIX_ATTEMPTS,
		maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
	};
	if (raw.maxFixAttempts !== undefined) {
		const v = raw.maxFixAttempts;
		if (typeof v === "number" && Number.isInteger(v) && v >= 0) config.maxFixAttempts = v;
		else errors.push(`"maxFixAttempts" must be a non-negative integer; using ${DEFAULT_MAX_FIX_ATTEMPTS}`);
	}
	if (raw.maxOutputChars !== undefined) {
		const v = positiveInt(raw.maxOutputChars);
		if (v === undefined) errors.push(`"maxOutputChars" must be a positive number; using ${DEFAULT_MAX_OUTPUT_CHARS}`);
		else config.maxOutputChars = v;
	}
	return { config, errors };
}
