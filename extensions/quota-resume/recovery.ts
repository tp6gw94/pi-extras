import { matchesKey } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { QuotaCapture } from "./capture.ts";

type Identity = { id: string; sessionId: string; origin: string; provider: string; model: string; resetAt: number };
type Recovery = Identity & ({ state: "pending" } | { state: "cancelled" } | { state: "consumed" });
type Candidate = { message: AssistantMessage; origin: string };
const entryType = "quota-resume";

function record(value: unknown): Recovery | undefined {
	if (typeof value !== "object" || value === null) return;

	const data = value as Record<string, unknown>;
	const hasValidState = ["pending", "cancelled", "consumed"].includes(String(data.state));
	if (!hasValidState) return;

	const identityKeys = ["id", "sessionId", "origin", "provider", "model"];
	if (!identityKeys.every(key => typeof data[key] === "string" && data[key] !== "")) return;

	const resetAt = data.resetAt;
	if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return;
	if (resetAt <= 0 || resetAt > 8.64e15) return;

	return data as Recovery;
}

export class RecoveryActor {
	private ctx?: ExtensionContext;
	private pending?: Recovery & { state: "pending" };
	private candidate?: Candidate;
	private records = new Map<string, Recovery>();
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private terminalInput?: () => void;
	private readonly pi: ExtensionAPI;
	private readonly capture: QuotaCapture;

	constructor(pi: ExtensionAPI, capture: QuotaCapture) {
		this.pi = pi;
		this.capture = capture;
	}

	open(ctx: ExtensionContext, cancelInherited = false): void {
		this.release();
		this.ctx = ctx;
		this.records.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== entryType) continue;
			const data = record(entry.data);
			if (!data) continue;

			const previous = this.records.get(data.id);
			if (previous?.state === "cancelled" || previous?.state === "consumed") continue;
			this.records.set(data.id, data);
		}
		for (const data of this.records.values()) {
			if (data.state === "pending" && data.sessionId === ctx.sessionManager.getSessionId()) this.pending = data;
		}
		if (ctx.mode === "tui") this.terminalInput = ctx.ui.onTerminalInput(data => {
			if (matchesKey(data, "escape")) this.cancel();
			return undefined;
		});
		if (cancelInherited) this.cancel();
		else this.schedule();
	}

	turn(event: TurnEndEvent): void {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error" || !this.capture.evidence.has(message)) {
			this.candidate = undefined;
			return;
		}

		this.candidate = { message, origin: event.messageEntryId };
	}

	settled(aborted: boolean, ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (aborted) return this.cancel();
		const candidate = this.candidate;
		this.candidate = undefined;
		if (candidate) {
			const quota = this.capture.evidence.get(candidate.message)!;
			const resetAt = quota.resetAt;
			if (resetAt === undefined || resetAt <= quota.receivedAt) {
				ctx.ui.notify(
					"配額已用盡，但伺服器未提供可用的未來重設時間；不會自動續跑。",
					"warning",
				);
			} else {
				const sessionId = ctx.sessionManager.getSessionId();
				const { provider, model } = candidate.message;
				const id = JSON.stringify([sessionId, candidate.origin, provider, model, resetAt]);
				if (!this.records.has(id)) {
					this.cancel();
					this.pending = { state: "pending", id, sessionId, origin: candidate.origin, provider, model, resetAt };
					this.persist(this.pending);
					ctx.ui.notify(
						`配額重設後將自動續跑：${new Date(resetAt).toLocaleString()}。可用 /quota-resume cancel 取消。`,
						"info",
					);
				}
			}
		}
		this.schedule();
	}

	compacted(): void {
		if (!this.pending || !this.ctx) return;
		this.clearTimer();
		const generation = this.generation;
		let delay = 100;
		const resume = () => {
			if (generation !== this.generation) return;
			if (this.ctx!.isIdle()) return this.schedule();
			this.timer = setTimeout(resume, delay);
			delay = Math.min(delay * 2, 1000);
		};
		this.timer = setTimeout(resume, 0);
	}

	cancel(): void {
		this.clearTimer();
		this.candidate = undefined;
		if (this.pending) this.persist({ ...this.pending, state: "cancelled" });
		this.pending = undefined;
		this.ctx?.ui.setStatus(entryType, undefined);
	}

	release(): void {
		this.clearTimer();
		this.terminalInput?.();
		this.terminalInput = undefined;
		this.pending = undefined;
		this.candidate = undefined;
		this.ctx = undefined;
	}

	private persist(data: Recovery): void {
		this.pi.appendEntry(entryType, data);
		this.records.set(data.id, data);
	}

	private clearTimer(): void {
		this.generation++;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private schedule(): void {
		this.clearTimer();
		const pending = this.pending;
		const ctx = this.ctx;
		if (!pending || !ctx) return;
		if (!this.hasCurrentContext(ctx, pending)) return this.cancel();

		ctx.ui.setStatus(entryType, `配額等待至 ${new Date(pending.resetAt).toLocaleString()}`);
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const generation = this.generation;
		const delay = Math.min(Math.max(0, pending.resetAt - Date.now()), 2_147_483_647);
		this.timer = setTimeout(() => {
			if (generation !== this.generation) return;
			if (Date.now() < pending.resetAt) return this.schedule();
			if (!ctx.isIdle()) return this.schedule();
			if (ctx.hasPendingMessages()) return this.schedule();
			if (!this.hasCurrentContext(ctx, pending)) return this.cancel();

			this.persist({ ...pending, state: "consumed" });
			this.pending = undefined;
			this.clearTimer();
			ctx.ui.setStatus(entryType, undefined);
			this.pi.sendUserMessage("Continue the unfinished task.");
		}, delay);
	}

	private hasCurrentContext(ctx: ExtensionContext, pending: Recovery): boolean {
		if (ctx.sessionManager.getSessionId() !== pending.sessionId) return false;
		if (!ctx.sessionManager.getBranch().some(entry => entry.id === pending.origin)) return false;
		if (ctx.model?.provider !== pending.provider) return false;
		return ctx.model.id === pending.model;
	}
}
