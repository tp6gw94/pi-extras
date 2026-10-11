(() => {
	"use strict";
	let started = false;
	const report = (width, height) => window.parent.postMessage({ width, height }, "*");
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	window.addEventListener("message", async (event) => {
		if (started || event.source !== window.parent) return;
		const source = event.data && typeof event.data.source === "string" ? event.data.source : null;
		if (source === null) return;
		started = true;
		try {
			if (typeof mermaid === "undefined") throw new Error("mermaid is not loaded");
			const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, theme: dark ? "dark" : "default" });
			const holder = document.createElement("pre");
			holder.className = "mermaid";
			holder.textContent = source;
			document.body.replaceChildren(holder);
			await mermaid.run({ nodes: [holder], suppressErrors: false });
			const svg = holder.querySelector("svg");
			if (!svg) throw new Error("no diagram");
			await settle();
			const box = svg.getBoundingClientRect();
			report(Math.ceil(box.width), Math.ceil(holder.getBoundingClientRect().height));
		} catch {
			document.body.replaceChildren();
			report(0, 0);
		}
	});
})();
