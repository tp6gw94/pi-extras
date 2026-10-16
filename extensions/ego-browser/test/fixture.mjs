import { createServer } from "node:http";

const maxDelayMs = 30000;
let received = 0;
let delayMs = 0;
let orders = [];
const html = `<!doctype html><html><head><title>Ego local checkout</title></head><body>
<h1>Local checkout</h1><form id="checkout"><label>Email <input id="email" type="email" required></label><label>Plan <select id="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label><button id="submit" type="submit">Place order</button></form>
<button id="dialog" onclick="alert('Manual user action required')">Dialog</button><button id="disabled" disabled>Disabled</button><div contenteditable id="custom">Unsupported editor</div>
<script>
document.querySelector('#checkout').onsubmit = async event => {
 event.preventDefault();
 const response = await fetch('/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.querySelector('#email').value,plan:document.querySelector('#plan').value})});
 if(response.ok) { const result=document.createElement('p'); result.id='confirmation'; result.textContent='Order confirmed'; document.body.append(result); }
};
</script></body></html>`;
const json = (response, value) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/state") return json(response, { received, mutations: orders.length, delayMs, orders });
  if (url.pathname === "/reset" && request.method === "POST") { received = 0; delayMs = 0; orders = []; response.end("reset"); return; }
  if (url.pathname === "/delay" && request.method === "POST") { delayMs = Math.min(maxDelayMs, Math.max(0, Number(url.searchParams.get("ms")) || 0)); return json(response, { delayMs }); }
  if (url.pathname === "/order" && request.method === "POST") {
    const seq = ++received;
    let data = "";
    for await (const chunk of request) data += chunk;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    orders.push({ seq, acceptedAt: new Date().toISOString(), ...JSON.parse(data) });
    response.end("ok");
    return;
  }
  response.setHeader("content-type", "text/html");
  const hiddenText = url.searchParams.has("hidden-text") ? '<div id="confirmation">Pending<span hidden>Order confirmed</span><span style="display:none">Order confirmed</span><span style="visibility:hidden">Order confirmed</span></div>' : "";
  response.end(html.replace("<script>", `${hiddenText}<script>`));
});
server.listen(Number(process.env.PORT ?? 4317), "127.0.0.1", () => console.log(`Fixture http://127.0.0.1:${server.address().port}`));
