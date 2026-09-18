/**
 * 无头浏览器检查器（CDP）
 * 用法：node cdp-check.mjs <debugBase> <url> <js表达式> [等待毫秒] [输出png]
 * 用途：加载页面 → 真实等待 → 收集 JS 异常/console → 求值 → 截图
 */
import { writeFileSync } from "node:fs";

const [base, url, expr = "document.body.innerText", waitMs = "6000", shotPath = ""] = process.argv.slice(2);
if (!base || !url) { console.error("usage: node cdp-check.mjs <debugBase> <url> [expr] [waitMs] [png]"); process.exit(2); }

const target = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let seq = 0;
const pending = new Map();
const problems = [];
const logs = [];

ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    problems.push("EXCEPTION: " + (d.exception?.description || d.text));
  }
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map(a => a.value ?? a.description ?? a.type).join(" ");
    logs.push(`[${m.params.type}] ${text}`);
    if (m.params.type === "error") problems.push("CONSOLE ERROR: " + text);
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    problems.push("LOG: " + m.params.entry.text);
  }
});

const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, Number(waitMs)));

const evalRes = await send("Runtime.evaluate", {
  expression: expr, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false
});

console.log("=== 异常/错误 ===");
console.log(problems.length ? problems.join("\n") : "(无)");
console.log("=== console ===");
console.log(logs.length ? logs.slice(-20).join("\n") : "(无)");
console.log("=== 求值结果 ===");
const r = evalRes.result?.result;
console.log(r?.value !== undefined ? JSON.stringify(r.value, null, 2) : JSON.stringify(evalRes.result, null, 2));

if (shotPath) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  console.log("=== 截图 ===\n" + shotPath);
}

await fetch(`${base}/json/close/${target.id}`).catch(() => {});
ws.close();
process.exit(problems.length ? 1 : 0);
