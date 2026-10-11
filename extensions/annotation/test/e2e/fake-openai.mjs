import http from "node:http";

const port = Number(process.argv[2] || 18734);
const answer = "The cache is LRU.\nIt evicts the oldest entry first.";
const followUp = "Eviction runs on every insert.\nOld keys leave in order.";
const toolCall = { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo cache-hit-ratio 0.93" }) } };
let requests = 0;

http
	.createServer((req, res) => {
		if (req.url === "/count") {
			res.end(String(requests));
			return;
		}
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			requests++;
			let lastRole = "";
			let lastText = "";
			try {
				const messages = JSON.parse(Buffer.concat(chunks).toString("utf8")).messages ?? [];
				lastRole = messages.at(-1)?.role ?? "";
				lastText = JSON.stringify(messages.at(-1)?.content ?? "");
			} catch {}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			chunk({ role: "assistant", content: "" });
			if (lastRole === "user" && lastText.includes("eviction")) {
				for (const piece of followUp.match(/[\s\S]{1,20}/g)) chunk({ content: piece });
				chunk({}, "stop");
			} else if (lastRole === "tool") {
				for (const piece of answer.match(/[\s\S]{1,20}/g)) chunk({ content: piece });
				chunk({}, "stop");
			} else {
				chunk({ content: "Checking the cache stats." });
				chunk({ tool_calls: [toolCall] });
				chunk({}, "tool_calls");
			}
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`fake model on ${port}`));
