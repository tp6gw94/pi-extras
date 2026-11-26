import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RpcClient, buildSessionProjection, getPackageDir, parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureBranch, writeChildSession } from "../rpc-subagents/snapshot.mjs";
import { ReviewError, type ChildPublicationAttempt, type Model, type ThreadPrompt } from "./review.ts";

const TURN_TIMEOUT_MS = 600000;
const unpublishedLinkErrors = new Set(["ENOENT", "EACCES", "EPERM", "EROFS"]);

async function failedWithoutPublishing(file: string, error: NodeJS.ErrnoException) {
	if (!error.code || !unpublishedLinkErrors.has(error.code)) return false;
	try {
		await lstat(file);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function hasOriginalPrompt(file: string, original: string) {
	const [header, ...entries] = parseSessionEntries(readFileSync(file, "utf8"));
	return header?.type === "session" && entries.some((entry) => {
		if (entry.type !== "message" || entry.timestamp <= header.timestamp || entry.message.role !== "user") return false;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
		return text === original || text.startsWith(`${original}\n\n`);
	});
}

export async function childTurn(ctx: ExtensionContext, file: string, model: Model, create: boolean, prompt: ThreadPrompt, signal: AbortSignal, publication: ChildPublicationAttempt) {
	signal.throwIfAborted();
	if (create) {
		const template = captureBranch(ctx.sessionManager, model, buildSessionProjection);
		const staged = `${file}.${randomUUID()}.tmp`;
		try {
			await writeChildSession(staged, { cwd: ctx.cwd, template });
			signal.throwIfAborted();
			publication.recordIntent();
			try {
				await link(staged, file);
			} catch (error) {
				if (await failedWithoutPublishing(file, error as NodeJS.ErrnoException)) publication.clearUnpublishedIntent();
				throw error;
			}
		} finally {
			await rm(staged, { force: true });
		}
	}
	if (!existsSync(file)) throw new ReviewError("The original child session is unavailable.");
	signal.throwIfAborted();

	const client = new RpcClient({
		cliPath: join(getPackageDir(), "dist/cli.js"),
		cwd: ctx.cwd,
		provider: model.provider,
		model: model.id,
		args: ["--session", file, "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--tools", "read,grep,find,ls"],
	});
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
	const liveness = new AbortController();
	const checkLiveness = async () => {
		while (!liveness.signal.aborted) {
			await delay(1000, undefined, { signal: liveness.signal });
			await client.getState();
		}
	};
	let reply: string | undefined;
	let failure = "Background Pi returned no reply.";
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const unsubscribe = client.onEvent((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			if (message.stopReason === "stop" || message.stopReason === "length") {
				reply = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
			} else {
				reply = undefined;
			}
			if (message.stopReason === "error") {
				const text = message.errorMessage ?? "";
				if (/api key|authenticat|unauthorized|401/i.test(text)) failure = "The model rejected or lacks credentials.";
				else if (/rate limit|429/i.test(text)) failure = "The model rate limit was reached.";
				else failure = "The model reported an error.";
			}
		}
		if (event.type === "agent_settled") {
			if (event.aborted) {
				reply = undefined;
				failure = "The turn was aborted.";
			}
			finish();
		}
	});

	const run = async () => {
		const state = await client.getState();
		deadline.throwIfAborted();
		if (state.sessionFile !== file || state.model?.provider !== model.provider || state.model.id !== model.id) {
			throw new ReviewError("The selected session or model is unavailable.");
		}
		await client.setAutoRetry(false);
		deadline.throwIfAborted();

		let text = prompt.original;
		if (prompt.reply !== undefined) {
			text = !create && hasOriginalPrompt(file, prompt.original) ? prompt.reply : `${prompt.original}\n\n${prompt.reply}`;
		}
		const disposition = await client.prompt(text);
		deadline.throwIfAborted();
		if (disposition !== "started") throw new ReviewError("Background Pi did not start a turn.");
		await Promise.race([settled, checkLiveness()]);

		if (!reply?.trim()) throw new ReviewError(failure);
		return reply;
	};

	let cancel!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		cancel = () => {
			reject(deadline.reason);
			finish();
		};
	});
	try {
		await client.start();
		deadline.throwIfAborted();
		deadline.addEventListener("abort", cancel, { once: true });
		return await Promise.race([run(), cancelled]);
	} catch (error) {
		if (deadline.aborted && !signal.aborted) throw new ReviewError("The background turn timed out.");
		throw error;
	} finally {
		liveness.abort();
		deadline.removeEventListener("abort", cancel);
		unsubscribe();
		await client.stop();
	}
}

type Space = { id: string; tabs: { id: string; terminals?: { terminal: string }[] }[] };

export async function launchTab(pi: ExtensionAPI, sessionId: string, connectionFile: string, signal: AbortSignal, terminal?: string, tab?: string) {
	const command = async (...args: string[]): Promise<Record<string, unknown>> => {
		signal.throwIfAborted();
		const result = await pi.exec("herdr-app", args, { timeout: 15000, signal });
		signal.throwIfAborted();
		if (result.code !== 0) throw new Error("Herdr command failed.");
		const malformed = new Error(`Herdr ${args.slice(0, 2).join(" ")} returned malformed JSON output.`);
		let value;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			throw malformed;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed;
		if (value.error) throw new Error("Herdr rejected the command.");
		return value;
	};

	const listed = (await command("ls")).spaces;
	if (!Array.isArray(listed) || listed.some((space) => !space || typeof space.id !== "string" || (!space.id.includes("/") && !Array.isArray(space.tabs)))) {
		throw new Error("Herdr ls returned malformed space data.");
	}
	const spaces: Space[] = listed.filter((space) => !space.id.includes("/"));
	const existing = tab && spaces.find((space) => space.tabs.some((entry) => entry.id === tab));
	if (existing && tab) {
		await command("do", "space.select", JSON.stringify({ id: existing.id }));
		await command("do", "tab.select", JSON.stringify({ id: tab }));
		return tab;
	}

	const holdsTerminal = (space: Space) => space.tabs.some((entry) => entry.terminals?.some((slot) => slot.terminal === terminal));
	const space = terminal && spaces.find(holdsTerminal)?.id;
	if (terminal && !space) throw new Error("Herdr cannot locate the source terminal.");
	const opened = await command("do", "tab.new", JSON.stringify({ space, mod: "pi-annotate", props: { sessionId, connectionFile }, focus: true }));
	if (typeof opened.tab !== "string" || !opened.tab.trim()) throw new Error("Herdr tab.new response contains no tab ID.");
	return opened.tab;
}
