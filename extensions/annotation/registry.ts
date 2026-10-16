import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionEntry {
	sessionId: string;
	port: number;
	token: string;
	pid: number;
	cwd: string;
	startedAt: string;
	tuiModule?: string;
}

export function agentDirFromEnv(env: NodeJS.ProcessEnv, home = homedir()): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return join(home, ".pi", "agent");
	if (dir === "~") return home;
	if (dir.startsWith("~/")) return join(home, dir.slice(2));
	return dir;
}

export function registryDir(agentDir: string): string {
	return join(agentDir, "annotation", "sessions");
}

function entryFile(dir: string, pid: number): string {
	return join(dir, `${pid}.json`);
}

export function writeEntry(dir: string, entry: SessionEntry): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = entryFile(dir, entry.pid);
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entry, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

function readEntry(file: string): SessionEntry | undefined {
	try {
		const entry = JSON.parse(readFileSync(file, "utf8")) as SessionEntry;
		const known = typeof entry.sessionId === "string" && typeof entry.token === "string" && Number.isInteger(entry.port) && Number.isInteger(entry.pid);
		return known ? entry : undefined;
	} catch {
		return undefined;
	}
}

export function removeEntry(dir: string, pid: number, token: string): void {
	const file = entryFile(dir, pid);
	if (readEntry(file)?.token === token) rmSync(file, { force: true });
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function listEntries(dir: string, alive: (pid: number) => boolean = pidAlive): SessionEntry[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const name of names) {
		const file = join(dir, name);
		const entry = readEntry(file);
		if (entry && alive(entry.pid)) entries.push(entry);
		else rmSync(file, { force: true });
	}
	return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function pickEntry(entries: readonly SessionEntry[], query: string | undefined, cwd: string): SessionEntry | string {
	if (query) {
		const matches = entries.filter((entry) => entry.sessionId.includes(query));
		if (matches.length === 1) return matches[0]!;
		return matches.length === 0 ? `no live annotate session matches "${query}"` : `"${query}" matches ${matches.length} sessions; use a longer part of the id`;
	}
	if (entries.length === 1) return entries[0]!;
	if (entries.length === 0) return "no live annotate session; run /annotate in pi first";
	const here = entries.filter((entry) => entry.cwd === cwd);
	if (here.length === 1) return here[0]!;
	return "several annotate sessions are live; pass part of a session id";
}
