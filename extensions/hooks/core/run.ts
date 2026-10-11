export type ExecFn = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface RunOutcome {
	command: string;
	ok: boolean;
	timedOut: boolean;
	aborted: boolean;
	code: number;
	output: string;
	durationMs: number;
}

/**
 * `sh -c` wrapper that runs the hook command in its own process group (via `setsid`
 * when available) and, when pi sends SIGTERM on timeout/abort, kills the whole group
 * so compound commands (`a && sleep 100`) and their children do not linger.
 * `$1` is the user's command.
 */
export const GROUP_WRAPPER = [
	'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$1" & else sh -c "$1" & fi',
	"pid=$!",
	`trap 'kill -s TERM -- "-$pid" 2>/dev/null || kill -s TERM "$pid" 2>/dev/null; (sleep 2; kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null) >/dev/null 2>&1 & exit 143' TERM INT HUP`,
	'wait "$pid"',
].join("\n");

export const HARD_GUARD_GRACE_MS = 7_000;

/**
 * Run `command` through `sh -c` with a timeout. Never resolves later than
 * timeoutMs + HARD_GUARD_GRACE_MS, even if the child ignores SIGTERM/SIGKILL handling
 * or a descendant holds the pipes open.
 */
export async function runShell(
	exec: ExecFn,
	command: string,
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; graceMs?: number },
): Promise<RunOutcome> {
	const started = Date.now();
	let guardTimer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<"guard">((resolve) => {
		guardTimer = setTimeout(() => resolve("guard"), opts.timeoutMs + (opts.graceMs ?? HARD_GUARD_GRACE_MS));
	});
	try {
		const result = await Promise.race([
			exec("sh", ["-c", GROUP_WRAPPER, "pi-hooks", command], { cwd: opts.cwd, timeout: opts.timeoutMs, signal: opts.signal }).catch(
				(err: unknown) => ({ stdout: "", stderr: String((err as Error)?.message ?? err), code: 127, killed: false }),
			),
			guard,
		]);
		const durationMs = Date.now() - started;
		if (result === "guard") {
			return { command, ok: false, timedOut: true, aborted: false, code: -1, output: "", durationMs };
		}
		const aborted = result.killed && opts.signal?.aborted === true;
		const timedOut = result.killed && !aborted;
		const output = [result.stdout, result.stderr].filter((s) => s.trim() !== "").join("\n");
		return {
			command,
			ok: !result.killed && result.code === 0,
			timedOut,
			aborted,
			code: result.code,
			output,
			durationMs,
		};
	} finally {
		if (guardTimer) clearTimeout(guardTimer);
	}
}
