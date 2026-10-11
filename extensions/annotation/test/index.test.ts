import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, describe, it } from "node:test";
import annotation, { annotateNotice, browserCommand } from "../index.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function post(url: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
	const { port } = new URL(url);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port, method: "POST", path: "/api/send", headers: { "x-annotate-token": token, "content-type": "application/json" } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

const branch = [
	{ type: "message", id: "u1", message: { role: "user", content: "explain the cache" } },
	{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "The cache is LRU." }] } },
];

function setup(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; hasUI?: boolean; editor?: string } = {}) {
	const commands = new Map<string, Handler>();
	const events = new Map<string, (...args: unknown[]) => unknown>();
	const execs: { command: string; args: string[] }[] = [];
	const notices: string[] = [];
	const sets: string[] = [];
	let editorText = options.editor ?? "draft";
	const statuses: (string | undefined)[] = [];
	const userMessages: unknown[] = [];
	let stale = false;
	let sessionFile = "/tmp/session-a.jsonl";
	const guard = () => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	const pi = {
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
		on: (event: string, handler: (...args: unknown[]) => unknown) => events.set(event, handler),
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		sendUserMessage: (message: unknown) => userMessages.push(message),
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getBranch: () => {
				guard();
				return branch;
			},
			getSessionFile: () => {
				guard();
				return sessionFile;
			},
			getSessionId: () => "id",
		},
		ui: {
			notify: (message: string) => {
				guard();
				notices.push(message);
			},
			pasteToEditor: () => {
				throw new Error("pasteToEditor must not be used");
			},
			setEditorText: (text: string) => {
				guard();
				sets.push(text);
				editorText = text;
			},
			getEditorText: () => {
				guard();
				return editorText;
			},
			setStatus: (_key: string, text: string | undefined) => {
				guard();
				statuses.push(text);
			},
		},
	};
	annotation(pi as never, { platform: options.platform ?? "linux", env: options.env ?? {} });
	const run = () => commands.get("annotate")!("", ctx);
	const lastUrl = () => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(notices.at(-1) ?? "")![0];
	return {
		run,
		lastUrl,
		execs,
		notices,
		sets,
		editor: () => editorText,
		statuses,
		userMessages,
		shutdown: () => events.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
		makeStale: () => {
			stale = true;
		},
		switchSession: () => {
			sessionFile = "/tmp/session-b.jsonl";
		},
	};
}

const cleanups: (() => unknown)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

describe("/annotate command", () => {
	it("opens the browser with an argument array, notifies the URL and returns", async () => {
		const t = setup();
		cleanups.push(t.shutdown);
		await t.run();
		const url = t.lastUrl();
		assert.deepEqual(t.execs, [{ command: "xdg-open", args: [url] }]);
		assert.equal(t.statuses.at(-1), "annotate: page open");
	});

	it("re-opens the same URL while the page is open", async () => {
		const t = setup();
		cleanups.push(t.shutdown);
		await t.run();
		const first = t.lastUrl();
		await t.run();
		assert.equal(t.lastUrl(), first);
		assert.equal(t.execs.length, 2);
		assert.equal(t.execs[1]!.args[0], first);
	});

	it("does not open a browser over SSH and shows ssh -L usage", async () => {
		const t = setup({ env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } });
		cleanups.push(t.shutdown);
		await t.run();
		assert.equal(t.execs.length, 0);
		const port = new URL(t.lastUrl()).port;
		assert.ok(t.notices.at(-1)!.includes(`ssh -L ${port}:127.0.0.1:${port} <host>`));
	});

	it("uses open on macOS and nothing elsewhere", () => {
		assert.equal(browserCommand("darwin", {}), "open");
		assert.equal(browserCommand("linux", {}), "xdg-open");
		assert.equal(browserCommand("win32", {}), undefined);
		assert.equal(browserCommand("darwin", { SSH_CONNECTION: "x" }), undefined);
		assert.ok(!annotateNotice("u", 1, {}).includes("ssh"));
	});

	it("does nothing without a UI", async () => {
		const t = setup({ hasUI: false });
		await t.run();
		assert.equal(t.notices.length, 0);
		assert.equal(t.execs.length, 0);
	});

	it("appends all annotations to the end of the editor in one set and never messages the agent", async () => {
		const t = setup();
		cleanups.push(t.shutdown);
		await t.run();
		const url = new URL(t.lastUrl());
		const reply = await post(url.href, url.searchParams.get("token")!, {
			items: [
				{ quote: "The cache is LRU.", note: "why LRU?" },
				{ quote: "explain\nthe cache", note: "" },
			],
		});
		assert.equal(reply.status, 200);
		assert.deepEqual(t.sets, ["draft\n> The cache is LRU.\n\nwhy LRU?\n\n> explain\n> the cache\n\n"]);
		assert.equal(t.userMessages.length, 0);
		assert.equal(t.statuses.at(-1), undefined);
		assert.match(t.notices.at(-1)!, /inserted 2 annotations/);
		const again = await post(url.href, url.searchParams.get("token")!, { items: [{ quote: "x", note: "" }] });
		assert.equal(again.status, 410);
		assert.equal(t.sets.length, 1);
	});

	for (const [editor, expected] of [
		["", "> quote\n\nnote\n\n"],
		["draft", "draft\n> quote\n\nnote\n\n"],
		["draft\n", "draft\n> quote\n\nnote\n\n"],
		["a\n\n", "a\n\n> quote\n\nnote\n\n"],
	] as const) {
		it(`appends after ${JSON.stringify(editor)} with one newline only when needed`, async () => {
			const t = setup({ editor });
			cleanups.push(t.shutdown);
			await t.run();
			const url = new URL(t.lastUrl());
			assert.equal((await post(url.href, url.searchParams.get("token")!, { items: [{ quote: "quote", note: "note" }] })).status, 200);
			assert.equal(t.editor(), expected);
		});
	}

	it("strips control sequences before appending", async () => {
		const t = setup({ editor: "" });
		cleanups.push(t.shutdown);
		await t.run();
		const url = new URL(t.lastUrl());
		await post(url.href, url.searchParams.get("token")!, { items: [{ quote: "\x1b[31mred\x1b[0m", note: "n\x1b]0;x\x07\x1b[201~" }] });
		assert.equal(t.editor(), "> red\n\nn\n\n");
	});

	it("rejects the send when the session switched and inserts nothing", async () => {
		const t = setup();
		cleanups.push(t.shutdown);
		await t.run();
		const url = new URL(t.lastUrl());
		t.switchSession();
		const reply = await post(url.href, url.searchParams.get("token")!, { items: [{ quote: "x", note: "" }] });
		assert.equal(reply.status, 409);
		assert.match(reply.body, /Session switched, run \/annotate again/);
		assert.equal(t.sets.length, 0);
	});

	it("rejects the send when the ctx went stale and inserts nothing", async () => {
		const t = setup();
		await t.run();
		const url = new URL(t.lastUrl());
		t.makeStale();
		const reply = await post(url.href, url.searchParams.get("token")!, { items: [{ quote: "x", note: "" }] });
		assert.equal(reply.status, 409);
		assert.equal(t.sets.length, 0);
		t.shutdown();
	});

	it("closes the server on session_shutdown", async () => {
		const t = setup();
		await t.run();
		const url = new URL(t.lastUrl());
		t.shutdown();
		await assert.rejects(post(url.href, url.searchParams.get("token")!, { items: [{ quote: "x", note: "" }] }));
		assert.equal(t.sets.length, 0);
	});

	it("keeps only one server across extension instances", async () => {
		const a = setup();
		const b = setup();
		cleanups.push(a.shutdown, b.shutdown);
		await a.run();
		const first = new URL(a.lastUrl());
		await b.run();
		await assert.rejects(post(first.href, first.searchParams.get("token")!, { items: [{ quote: "x", note: "" }] }));
		assert.notEqual(b.lastUrl(), first.href);
	});
});
