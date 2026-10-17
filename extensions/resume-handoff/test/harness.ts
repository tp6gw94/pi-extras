import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, initTheme, serializeConversation } from "@earendil-works/pi-coding-agent";
import resumeHandoff from "../index.ts";

initTheme();

type Notification = { message: string; level: string };
type PromptCall = { text: string; options: { expandPromptTemplates?: boolean } | undefined };

type HarnessOptions = {
	complete?: (context: any, call: number) => any;
	select?: (options: string[]) => string | undefined;
	mode?: string;
	idle?: boolean;
	pendingMessages?: boolean;
	cancelNewSession?: boolean;
	branch?: unknown[];
	cwd?: string;
	promptResult?: () => Promise<void>;
	model?: any;
	waitForIdle?: () => Promise<void>;
};

export function makeDir(): string {
	return mkdtempSync(join(realpathSync(tmpdir()), "resume-handoff-"));
}

export function messageEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

export function discoveryText(evidence: string, paths: string[]): string {
	return JSON.stringify({ candidates: paths.map((path) => ({ path, evidence })) });
}

export function createHarness(options: HarnessOptions = {}) {
	let finishRun: (() => void) | undefined;
	let idlePromise: Promise<void> | undefined;
	let started!: () => void;
	const generationStarted = new Promise<void>((resolve) => { started = resolve; });
	const state = {
		sessionId: "session-1",
		sessionFile: "/sessions/session-1.jsonl",
		leafId: null as string | null,
		branch: options.branch ?? [messageEntry("entry-1", "start")],
		replaced: false,
		generationMessages: [] as any[],
		completeCalls: [] as any[],
		notifications: [] as Notification[],
		prompts: [] as PromptCall[],
		newSessions: [] as any[],
		selectCalls: [] as { title: string; options: string[] }[],
		handlers: new Map<string, ((event: any, ctx: any) => void)[]>(),
		components: [] as any[],
		command: undefined as { handler: (args: string, ctx: any) => Promise<void> } | undefined,
	};
	const guard = () => assert.equal(state.replaced, false, "stale context used");
	const ui = {
		notify(message: string, level: string = "info") {
			guard();
			state.notifications.push({ message, level });
		},
		async select(title: string, choices: string[]) {
			guard();
			state.selectCalls.push({ title, options: choices });
			return options.select?.(choices);
		},
		custom<T>(factory: any): Promise<T> {
			guard();
			return new Promise<T>((done) => {
				state.components.push(
					factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, done),
				);
			});
		},
	};
	const ctx: any = {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		ui,
		model: options.model === undefined ? { id: "test-model" } : options.model,
		modelRegistry: {
			async complete(model: any, context: any, requestOptions: any) {
				guard();
				const call = state.completeCalls.length;
				state.completeCalls.push({ model, context, requestOptions });
				if (options.complete) {
					return options.complete(context, call);
				}
				return { stopReason: "stop", content: [{ type: "text", text: "{}" }] };
			},
		},
		sessionManager: {
			getSessionId: () => {
				guard();
				return state.sessionId;
			},
			getSessionFile: () => {
				guard();
				return state.sessionFile;
			},
			getLeafId: () => {
				guard();
				return state.leafId;
			},
			getBranch: () => {
				guard();
				return state.branch;
			},
		},
		isIdle: () => {
			guard();
			return idlePromise === undefined && (options.idle ?? true);
		},
		hasPendingMessages: () => {
			guard();
			return options.pendingMessages ?? false;
		},
		async waitForIdle() {
			guard();
			await (idlePromise ?? options.waitForIdle?.());
		},
		async newSession(sessionOptions: any) {
			guard();
			state.newSessions.push(sessionOptions);
			if (options.cancelNewSession) {
				return { cancelled: true };
			}
			state.replaced = true;
			state.sessionId = "session-2";
			state.sessionFile = "/sessions/session-2.jsonl";
			state.leafId = "leaf-2";
			if (sessionOptions.withSession) {
				await sessionOptions.withSession({
					async sendUserMessage(text: string, promptOptions: any) {
						state.prompts.push({ text, options: promptOptions });
						if (options.promptResult) {
							await options.promptResult();
						}
					},
				});
			}
			return { cancelled: false };
		},
	};
	const pi: any = {
		sendMessage(message: any, sendOptions: any) {
			guard();
			state.generationMessages.push({ message, options: sendOptions });
			idlePromise = new Promise<void>((resolve) => { finishRun = resolve; });
			started();
		},
		registerCommand(_name: string, definition: any) {
			state.command = definition;
		},
		on(event: string, handler: any) {
			const list = state.handlers.get(event) ?? [];
			list.push(handler);
			state.handlers.set(event, list);
			return () => {
				const current = state.handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) {
					current.splice(index, 1);
				}
			};
		},
	};
	resumeHandoff(pi);
	const cleanup = () => {
		for (const component of state.components) {
			component.dispose?.();
		}
	};
	return {
		state,
		ctx,
		generationStarted,
		finishGeneration: () => {
			idlePromise = undefined;
			finishRun?.();
		},
		run: async (args: string) => {
			try {
				return await state.command!.handler(args, ctx);
			} finally {
				cleanup();
			}
		},
		fire: (event: string, payload: any = {}) => {
			for (const handler of [...(state.handlers.get(event) ?? [])]) {
				handler(payload, ctx);
			}
		},
		handlerCount: () => [...state.handlers.values()].reduce((total, list) => total + list.length, 0),
	};
}

export function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function conversationFor(text: string): string {
	return serializeConversation(convertToLlm([messageEntry("entry-1", text).message as any]));
}

export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("command timed out")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
