import { spawn } from "node:child_process";
import type { ExecFn } from "../core/run.ts";

export const nodeExec: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options?.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const kill = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
			}
		};
		const timer = options?.timeout ? setTimeout(kill, options.timeout) : undefined;
		options?.signal?.addEventListener("abort", kill, { once: true });
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 0, killed });
		});
		proc.on("error", (err) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr: String(err), code: 1, killed });
		});
	});
