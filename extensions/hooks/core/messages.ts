import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { truncateOutput } from "./command.ts";

export interface CheckFailure {
	name: string;
	files: string[];
	code: number;
	output: string;
}

function sections(failures: readonly CheckFailure[], maxChars: number): string {
	const perRule = Math.max(500, Math.floor(maxChars / Math.max(1, failures.length)));
	return failures
		.map(
			(f) =>
				`### \`${f.name}\` (exit ${f.code}) on ${f.files.join(", ")}\n\`\`\`\n${truncateOutput(f.output || "(no output)", perRule)}\n\`\`\``,
		)
		.join("\n\n");
}

export function fixRequestMessage(failures: readonly CheckFailure[], attempt: number, limit: number, maxChars: number): string {
	return [
		`[pi-hooks] Checks failed on files you changed (automatic fix attempt ${attempt} of ${limit}). Fix the code so these checks pass, then finish your reply.`,
		`Do not edit ${CONFIG_RELATIVE_PATH} or otherwise disable, skip or weaken the checks; config changes only apply from the next user prompt anyway. If an error cannot be fixed in code, say so in your reply.`,
		"",
		sections(failures, maxChars),
	].join("\n");
}

export function giveUpMessage(failures: readonly CheckFailure[], limit: number, maxChars: number): string {
	return `[pi-hooks] Checks still fail after ${limit} automatic fix attempt(s); stopped. Remaining errors:\n\n${sections(failures, maxChars)}`;
}
