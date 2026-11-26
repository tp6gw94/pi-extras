import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";

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

const OUTPUT_LIMIT = 64 * 1024;
const TERM_GRACE_MS = 2000;
const OUTPUT_IDLE_MS = 500;

export async function runShell(
	command: string,
	{ cwd, timeoutMs, signal }: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutcome> {
	const started = Date.now();
	if (signal?.aborted) return { command, ok: false, timedOut: false, aborted: true, code: -1, output: "", durationMs: 0 };
	return new Promise((resolve) => {
		const launch = () => spawn("sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let child: ReturnType<typeof launch>;
		try {
			child = launch();
		} catch (error) {
			resolve({ command, ok: false, timedOut: false, aborted: false, code: 127, output: String(error), durationMs: Date.now() - started });
			return;
		}
		let reason: "timeout" | "abort" | undefined;
		let remaining = OUTPUT_LIMIT;
		let truncated = false;
		let escalation: NodeJS.Timeout | undefined;
		let drain: NodeJS.Timeout | undefined;
		let status: number | undefined;
		let done = false;
		const stdout = capture(child.stdout);
		const stderr = capture(child.stderr);
		const abort = () => stop("abort");
		const deadline = setTimeout(() => {
			if (status === undefined) stop("timeout");
			else if (!reason) finish(status);
		}, timeoutMs);
		signal?.addEventListener("abort", abort);

		function capture(stream: typeof child.stdout) {
			const decoder = new StringDecoder("utf8");
			let text = "";
			stream.on("data", (chunk: Buffer) => {
				if (status !== undefined && !reason) drainOutput(status);
				const bytes = chunk.subarray(0, remaining);
				text += decoder.write(bytes);
				remaining -= bytes.length;
				if (bytes.length < chunk.length) truncated = true;
			});
			return () => text + (truncated ? "" : decoder.end());
		}

		function drainOutput(code: number) {
			clearTimeout(drain);
			drain = setTimeout(() => finish(code), OUTPUT_IDLE_MS);
		}

		function group(sig: NodeJS.Signals | 0) {
			if (!child.pid) return false;
			try {
				return process.kill(-child.pid, sig);
			} catch {
				return false;
			}
		}

		function stop(cause: NonNullable<typeof reason>) {
			if (reason || done) return;
			reason = cause;
			clearTimeout(drain);
			if (!group("SIGTERM")) return finish(status);
			escalation = setTimeout(() => {
				group("SIGKILL");
				finish(status);
			}, TERM_GRACE_MS);
		}

		function finish(code = -1, error?: string) {
			if (done) return;
			done = true;
			clearTimeout(deadline);
			clearTimeout(escalation);
			clearTimeout(drain);
			signal?.removeEventListener("abort", abort);
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			const output = [truncated ? "[Hook output truncated after 64 KiB]" : undefined, stdout(), stderr(), error].filter((s) => s?.trim()).join("\n");
			resolve({ command, ok: !reason && code === 0, timedOut: reason === "timeout", aborted: reason === "abort", code: reason && code === 0 ? -1 : code, output, durationMs: Date.now() - started });
		}

		child.once("error", (error) => finish(127, error.message));
		child.once("exit", (code, sig) => {
			status = code ?? (sig ? 128 + constants.signals[sig] : -1);
			if (!reason) drainOutput(status);
		});
		child.once("close", () => {
			if (!done && (!reason || !group(0))) finish(status);
		});
	});
}
