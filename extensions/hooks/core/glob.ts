/**
 * Minimal glob matcher (no dependencies).
 *
 * Supported: `*` (any chars except `/`), `**` (any number of path segments),
 * `?`, `[...]` / `[!...]`, and `{a,b}` alternation (nestable).
 *
 * A glob without `/` is matched against the file's basename at any depth
 * (`*.ts` matches `src/a/b.ts`), like .gitignore. A glob with `/` is matched
 * against the path relative to the project root (leading `./` or `/` ignored).
 */

const cache = new Map<string, RegExp>();

function escapeRe(ch: string): string {
	return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function translate(glob: string): string {
	let re = "";
	let i = 0;
	let braceDepth = 0;
	while (i < glob.length) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const atSegStart = i === 0 || glob[i - 1] === "/";
				let j = i + 2;
				while (glob[j] === "*") j++;
				if (atSegStart && glob[j] === "/") {
					re += "(?:[^/]*/)*";
					i = j + 1;
					continue;
				}
				if (atSegStart && j === glob.length) {
					re += ".*";
					i = j;
					continue;
				}
				re += "[^/]*";
				i = j;
				continue;
			}
			re += "[^/]*";
			i++;
		} else if (ch === "?") {
			re += "[^/]";
			i++;
		} else if (ch === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close === -1) {
				re += "\\[";
				i++;
				continue;
			}
			let body = glob.slice(i + 1, close);
			let negate = false;
			if (body[0] === "!" || body[0] === "^") {
				negate = true;
				body = body.slice(1);
			}
			body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
			re += negate ? `[^/${body}]` : `[${body}]`;
			i = close + 1;
		} else if (ch === "{") {
			braceDepth++;
			re += "(?:";
			i++;
		} else if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			re += ")";
			i++;
		} else if (ch === "," && braceDepth > 0) {
			re += "|";
			i++;
		} else if (ch === "\\" && i + 1 < glob.length) {
			re += escapeRe(glob[i + 1]!);
			i += 2;
		} else {
			re += escapeRe(ch);
			i++;
		}
	}
	while (braceDepth-- > 0) re += ")";
	return re;
}

export function globToRegExp(glob: string): RegExp {
	let re = cache.get(glob);
	if (!re) {
		re = new RegExp(`^${translate(glob)}$`);
		cache.set(glob, re);
	}
	return re;
}

function normalizeRel(p: string): string {
	let s = p.replace(/\\/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	return s.replace(/^\/+/, "");
}

/** Match one glob against a project-relative path. */
export function matchGlob(glob: string, relPath: string): boolean {
	const rel = normalizeRel(relPath);
	const g = normalizeRel(glob);
	if (!g.includes("/")) {
		const base = rel.slice(rel.lastIndexOf("/") + 1);
		return globToRegExp(g).test(base);
	}
	return globToRegExp(g).test(rel);
}

/** True when any glob in the list matches. Globs starting with `!` exclude. */
export function matchAny(globs: readonly string[], relPath: string): boolean {
	let matched = false;
	for (const g of globs) {
		if (g.startsWith("!")) {
			if (matched && matchGlob(g.slice(1), relPath)) matched = false;
		} else if (!matched && matchGlob(g, relPath)) {
			matched = true;
		}
	}
	return matched;
}
