export const CONFIG_FILE_NAME = "pi-ux.json";

/**
 * Shortcut actions and their default keys.
 *
 * pi (keybindings.ts @28dcce2) leaves alt+p and alt+q free on macOS and Linux, where the previous
 * model is shift+ctrl+p and restoring queued messages is alt+up. Only pi's Windows keybinding mode
 * (native Windows, or WSL via WSL_DISTRO_NAME or WSL_INTEROP) binds alt+p and alt+q. pi-ux does no
 * platform check itself: pi's extension runner compares each shortcut with its active keys, skips
 * one that hits a reserved key (alt+p there) and lets pi-ux override the rest (alt+q there), with a
 * startup warning either way. The README tells Windows-mode users to change pi-ux.json.
 */
export const DEFAULT_KEYS = {
	togglePrompt: "alt+p",
	quoteClipboard: "alt+q",
} as const;

export type KeyAction = keyof typeof DEFAULT_KEYS;
/** Every top-level key the loader reads. README tests check each one is documented. */
export const TOP_LEVEL_KEYS = ["keys"] as const;
export const KEY_ACTIONS = Object.keys(DEFAULT_KEYS) as KeyAction[];

export interface UxConfig {
	/** `undefined` disables the shortcut. */
	keys: Record<KeyAction, string | undefined>;
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Loose check of pi's key syntax: zero or more modifiers, then one key. */
export function isValidKey(key: string): boolean {
	const k = key.toLowerCase();
	if (k === "" || k === "+") return k === "+";
	let mods: string[];
	if (k.endsWith("++")) mods = k.slice(0, -2).split("+");
	else {
		const parts = k.split("+");
		const last = parts.pop()!;
		if (last === "") return false;
		mods = parts;
	}
	if (mods.length === 1 && mods[0] === "") mods = [];
	return mods.every((m) => MODIFIERS.has(m)) && new Set(mods).size === mods.length;
}

export function parseConfig(text: string | undefined): { config: UxConfig; errors: string[] } {
	const config: UxConfig = { keys: { ...DEFAULT_KEYS } };
	const errors: string[] = [];
	if (text === undefined) return { config, errors };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { config, errors: [`invalid JSON: ${(err as Error).message}`] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config, errors: ["top level must be an object"] };
	}
	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!(TOP_LEVEL_KEYS as readonly string[]).includes(k) && k !== "$schema") errors.push(`unknown key "${k}" ignored`);
	}
	if (obj.keys !== undefined) {
		if (typeof obj.keys !== "object" || obj.keys === null || Array.isArray(obj.keys)) {
			errors.push('"keys" must be an object');
		} else {
			for (const [action, value] of Object.entries(obj.keys as Record<string, unknown>)) {
				if (!(KEY_ACTIONS as string[]).includes(action)) {
					errors.push(`keys.${action}: unknown action ignored`);
					continue;
				}
				const a = action as KeyAction;
				if (value === null || value === "" || value === false) config.keys[a] = undefined;
				else if (typeof value === "string" && isValidKey(value)) config.keys[a] = value.toLowerCase();
				else errors.push(`keys.${action}: "${String(value)}" is not a valid key; using ${DEFAULT_KEYS[a]}`);
			}
		}
	}
	return { config, errors };
}
