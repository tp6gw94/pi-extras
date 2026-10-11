export const CONFIG_FILE_NAME = "pi-ux.json";

/**
 * Shortcut actions and their default keys.
 *
 * pi (keybindings.ts @28dcce2) leaves alt+p free on macOS and Linux, where the previous model is
 * shift+ctrl+p. Only pi's Windows keybinding mode (native Windows, or WSL via WSL_DISTRO_NAME or
 * WSL_INTEROP) binds alt+p. pi-ux does no platform check itself: pi's extension runner compares each
 * shortcut with its active keys and skips one that hits a reserved key (alt+p there), with a startup
 * warning. The README tells Windows-mode users to change pi-ux.json.
 */
export const DEFAULT_KEYS = {
	togglePrompt: "alt+p",
} as const;

/** Actions pi-ux no longer has. A config that still sets one loads normally and gets one notice. */
export const OBSOLETE_KEY_ACTIONS = ["quoteClipboard"] as const;

export type KeyAction = keyof typeof DEFAULT_KEYS;
export const TOP_LEVEL_KEYS = ["keys"] as const;
export const KEY_ACTIONS = Object.keys(DEFAULT_KEYS) as KeyAction[];

export interface UxConfig {
	keys: Record<KeyAction, string | undefined>;
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

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

export function obsoleteKeyNotice(keys: readonly string[]): string {
	const list = keys.map((k) => `keys.${k}`).join(", ");
	return `pi-ux: ${list} in pi-ux.json is obsolete and ignored. The clipboard quote shortcut and /quote were removed; select text in fullscreen mode to quote it with the annotation extension. Delete the key to hide this notice.`;
}

export function parseConfig(text: string | undefined): { config: UxConfig; errors: string[]; obsolete: string[] } {
	const config: UxConfig = { keys: { ...DEFAULT_KEYS } };
	const errors: string[] = [];
	const obsolete: string[] = [];
	if (text === undefined) return { config, errors, obsolete };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { config, errors: [`invalid JSON: ${(err as Error).message}`], obsolete };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config, errors: ["top level must be an object"], obsolete };
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
				if ((OBSOLETE_KEY_ACTIONS as readonly string[]).includes(action)) {
					obsolete.push(action);
					continue;
				}
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
	return { config, errors, obsolete };
}
