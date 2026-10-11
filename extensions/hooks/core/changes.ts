import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExecFn } from "./run.ts";

const GIT_TIMEOUT_MS = 30_000;

/**
 * Write the whole working tree (tracked + untracked, respecting .gitignore) as a git
 * tree object, using a throwaway copy of the index so the user's index is untouched.
 */
const SNAPSHOT_SCRIPT = [
	'idx=$(mktemp "${TMPDIR:-/tmp}/pi-hooks-index.XXXXXX") || exit 1',
	'real=$(git rev-parse --git-path index) || { rm -f "$idx"; exit 1; }',
	'if [ -f "$real" ]; then cp "$real" "$idx"; else rm -f "$idx"; fi',
	'GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree',
	"rc=$?",
	'rm -f "$idx"',
	"exit $rc",
].join("\n");

export interface GitSnapshot {
	kind: "git";
	root: string;
	tree: string;
}

export async function gitRoot(exec: ExecFn, cwd: string): Promise<string | undefined> {
	try {
		const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: GIT_TIMEOUT_MS });
		if (r.code !== 0 || r.killed) return undefined;
		const root = r.stdout.trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

export async function snapshotGit(exec: ExecFn, cwd: string): Promise<GitSnapshot | undefined> {
	const root = await gitRoot(exec, cwd);
	if (!root) return undefined;
	const r = await exec("sh", ["-c", SNAPSHOT_SCRIPT], { cwd: root, timeout: GIT_TIMEOUT_MS });
	const tree = r.stdout.trim();
	if (r.code !== 0 || r.killed || !/^[0-9a-f]{40,64}$/.test(tree)) return undefined;
	return { kind: "git", root, tree };
}

/** Paths (relative to `cwd`) added or modified between two snapshots; deletions and paths outside cwd excluded. */
export async function changedSince(exec: ExecFn, cwd: string, start: GitSnapshot): Promise<string[] | undefined> {
	const end = await snapshotGit(exec, cwd);
	if (!end || end.root !== start.root) return undefined;
	if (end.tree === start.tree) return [];
	const r = await exec(
		"git",
		["diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=AMT", start.tree, end.tree],
		{ cwd: start.root, timeout: GIT_TIMEOUT_MS },
	);
	if (r.code !== 0 || r.killed) return undefined;
	const out: string[] = [];
	for (const p of r.stdout.split("\0")) {
		if (!p) continue;
		const rel = toProjectRelative(resolve(start.root, p), cwd);
		if (rel && isRegularFile(resolve(cwd, rel))) out.push(rel);
	}
	return out;
}

/** Project-relative POSIX path, or undefined when outside the project. */
export function toProjectRelative(absPath: string, cwd: string): string | undefined {
	const rel = relative(cwd, absPath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split("\\").join("/");
}

function isRegularFile(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Fallback when the project is not a git repo: paths reported by write/edit tool results. */
export class ToolChangeRecorder {
	private files = new Set<string>();
	reset(): void {
		this.files.clear();
	}
	record(rel: string): void {
		this.files.add(rel);
	}
	list(cwd: string): string[] {
		return [...this.files].filter((f) => isRegularFile(resolve(cwd, f)));
	}
}
