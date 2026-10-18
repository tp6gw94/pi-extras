import type { Api, Model, TranscriptContext, AssistantMessage, Provider, StreamOptions } from "@earendil-works/pi-ai";

type Quota = { resetAt?: number; receivedAt: number };
type Wire = Record<string, unknown>;

function object(value: unknown): Wire {
	if (typeof value !== "object" || value === null) return {};
	return value as Wire;
}

function epoch(value: unknown): number | undefined {
	let seconds: number;
	if (typeof value === "number") seconds = value;
	else if (typeof value === "string" && value.trim() !== "") seconds = Number(value);
	else return undefined;

	if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 8.64e15) return undefined;
	return seconds * 1000;
}

const parsers: Record<string, (body: Wire, headers: Headers, now: number) => Quota | undefined> = {
	"openai-codex": (body, headers, now) => {
		const error = object(body.error ?? object(body.response).error ?? body);
		if (error.type !== "usage_limit_reached" && error.code !== "usage_limit_reached") return;
		const remainingSeconds = error.resets_in_seconds;
		const hasValidRemainingSeconds = typeof remainingSeconds === "number"
			&& Number.isFinite(remainingSeconds)
			&& remainingSeconds >= 0;
		const remaining = hasValidRemainingSeconds ? epoch(now / 1000 + remainingSeconds) : undefined;
		const resetAt = epoch(error.resets_at)
			?? epoch(headers.get("x-codex-primary-reset-at"))
			?? remaining;
		return { resetAt, receivedAt: now };
	},
	anthropic: (body, headers, now) => {
		if (object(body.error).type !== "rate_limit_error") return;
		const windows = ["", "-5h", "-7d"];
		const denied = windows.filter(window => {
			const status = headers.get(`anthropic-ratelimit-unified${window}-status`) ?? "";
			return ["rejected", "rate_limited"].includes(status);
		});
		if (denied.length === 0) return;

		const resetHeaders = denied.map(window => headers.get(`anthropic-ratelimit-unified${window}-reset`));
		const resets = resetHeaders.map(epoch).filter((value): value is number => value !== undefined);
		const resetAt = resets.length > 0 ? Math.max(...resets) : undefined;
		return { resetAt, receivedAt: now };
	},
	"opencode-go": (body, headers, now) => {
		if (object(body.error).type !== "GoUsageLimitError") return;
		const retry = headers.get("retry-after");
		const isSeconds = retry !== null && /^\d+(\.\d+)?$/.test(retry);
		const seconds = isSeconds ? Number(retry) : NaN;
		let resetAt: number | undefined;
		if (Number.isFinite(seconds)) resetAt = now + seconds * 1000;
		else if (retry !== null) resetAt = Date.parse(retry);

		if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt > 8.64e15)) resetAt = undefined;
		return { resetAt, receivedAt: now };
	},
};

export class QuotaCapture {
	readonly evidence = new WeakMap<AssistantMessage, Quota>();

	decorate(provider: Provider): Provider {
		const parser = parsers[provider.id];
		for (const method of ["stream", "streamSimple"] as const) {
			const original = provider[method].bind(provider);
			provider[method] = ((model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
				let quota: Quota | undefined;
				const fetch = options.fetch ?? globalThis.fetch;
				const stream = original(model, context, {
					...options,
					fetch: async (input, init) => {
						quota = undefined;
						const response = await fetch(input, init);
						if (response.status === 429) {
							const body: unknown = await response.clone().json().catch(() => undefined);
							quota = parser(object(body), response.headers, Date.now());
						}
						return response;
					},
					onResponse: async (response, eventModel) => {
						try {
							await options.onResponse?.(response, eventModel);
						} catch (error) {
							quota = undefined;
							throw error;
						}
					},
					onProviderStreamEvent: async (data, eventModel) => {
						const event = object(data);
						if (event.type === "error" || event.type === "response.failed") quota = parser(event, new Headers(), Date.now());
						else quota = undefined;
						try {
							await options.onProviderStreamEvent?.(data, eventModel);
						} catch (error) {
							quota = undefined;
							throw error;
						}
					},
				});
				const bind = (message: AssistantMessage) => {
					if (message.stopReason !== "error" || !quota) {
						this.evidence.delete(message);
						return message;
					}

					this.evidence.set(message, quota);
					return message;
				};
				const result = stream.result.bind(stream);
				stream.result = async () => bind(await result());
				const iterator = stream[Symbol.asyncIterator].bind(stream);
				stream[Symbol.asyncIterator] = async function* () {
					for await (const event of { [Symbol.asyncIterator]: iterator }) {
						if (event.type === "done") bind(event.message);
						if (event.type === "error") bind(event.error);
						yield event;
					}
				};
				return stream;
			}) as Provider["stream"] & Provider["streamSimple"];
		}
		return provider;
	}
}
