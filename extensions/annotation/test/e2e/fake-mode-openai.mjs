import http from "node:http";

const port = Number(process.argv[2] || 0);
const fixture = [
	"日本語テキスト 🚀 完了",
	"",
	"The cache has **two layers** and uses [the docs](https://example.com/cache).",
	"",
	"```ts",
	"const limit = 3;",
	'const key = "a";',
	"```",
	"",
	"- item one",
	"- item two",
	"",
	"Done.",
].join("\n");
const streamLines = Array.from({ length: 60 }, (_, index) => `stream line ${String(index + 1).padStart(2, "0")} of the fullscreen test`);
streamLines.push("STREAM_DONE");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;
let lastUser = "";
let held;
const events = [];

function chunk(res, delta, finish = null) {
	res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

function finish(res) {
	chunk(res, {}, "stop");
	res.end("data: [DONE]\n\n");
}

function reply(res, text) {
	for (const piece of text.match(/[^\n]*\n|[^\n]+/g)) chunk(res, { content: piece });
	finish(res);
}

async function stream(res, lines) {
	for (const line of lines) {
		chunk(res, { content: line + "\n" });
		await sleep(90);
	}
	finish(res);
}

function hold(res) {
	chunk(res, { content: "Holding current work." });
	held = () => {
		chunk(res, { content: "\nThe held turn finished." });
		finish(res);
	};
}

http
	.createServer((req, res) => {
		if (req.url === "/count") {
			res.end(String(requests));
			return;
		}
		if (req.url === "/last-user") {
			res.end(lastUser);
			return;
		}
		if (req.url === "/events") {
			res.end(JSON.stringify(events));
			return;
		}
		if (req.url === "/held") {
			res.end(JSON.stringify(Boolean(held)));
			return;
		}
		if (req.url === "/release") {
			const release = held;
			held = undefined;
			release?.();
			res.end(JSON.stringify(Boolean(release)));
			return;
		}
		const chunks = [];
		req.on("data", (piece) => chunks.push(piece));
		req.on("end", () => {
			requests++;
			const requestId = requests;
			let lastRole = "";
			let lastText = "";
			try {
				const messages = JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? [];
				lastRole = messages.at(-1)?.role ?? "";
				lastText = JSON.stringify(messages.at(-1)?.content ?? "");
				if (lastRole === "user") lastUser = lastText;
			} catch {}
			events.push({ kind: "request", requestId, lastRole, lastUser });
			res.on("finish", () => events.push({ kind: "complete", requestId }));
			res.writeHead(200, { "content-type": "text/event-stream" });
			chunk(res, { role: "assistant", content: "" });
			if (lastRole === "user" && lastText.includes("followup note")) reply(res, "Note received.");
			else if (lastRole === "user" && lastText.includes("MODE_HOLD")) hold(res);
			else if (lastRole === "user" && lastText.includes("MODE_STREAM")) void stream(res, streamLines);
			else if (lastRole === "user" && lastText.includes("MODE_FIXTURE")) reply(res, fixture);
			else reply(res, `Reply for ${lastText.slice(0, 40)}`);
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`fake model on ${port}`));
