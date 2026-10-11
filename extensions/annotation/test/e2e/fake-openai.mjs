import http from "node:http";

const port = Number(process.argv[2] || 18733);
const reply = "Here is the helper:\n\n```js\nconst x = 1;\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nIt adds two numbers.";
let requests = 0;

http
	.createServer((req, res) => {
		if (req.url === "/count") {
			res.end(String(requests));
			return;
		}
		req.resume();
		req.on("end", () => {
			requests++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			chunk({ role: "assistant", content: "" });
			for (const piece of reply.match(/[\s\S]{1,20}/g)) chunk({ content: piece });
			chunk({}, "stop");
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`fake model on ${port}`));
