/**
 * 自动通关全部章节：真实鼠标事件走完每一关，抓 JS 异常，校验评分与配乐联动
 * 用法：node playthrough.mjs <debugBase> <fileUrl> [outDir]
 */
import { writeFileSync, mkdirSync } from "node:fs";

const [base, url, outDir = "."] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const target = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));

let seq = 0; const pending = new Map(); const problems = [];
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    problems.push("EXCEPTION: " + (d.exception?.description || d.text));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    problems.push("CONSOLE: " + m.params.args.map(a => a.value ?? a.description).join(" "));
});
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async expr => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const d = r.result?.exceptionDetails;
  if (d) { problems.push("EVAL: " + (d.exception?.description || d.text)); return undefined; }
  return r.result?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function click(sel) {
  const box = await evalJs(`(async()=>{
    const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
    e.scrollIntoView({block:'center'});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const r=e.getBoundingClientRect();
    return {x:r.x+r.width/2, y:r.y+r.height/2};
  })()`);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  return true;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, "base64"));
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await wait(2600);

const PROBE = `(()=>{
  const app = window.__app; const st = app.state(); const p = st ? app.page() : null;
  const ch = st ? app.chapter() : null;
  const qs = ch ? ch.pages.filter(x => x.type === 'question') : [];
  const fb = document.querySelector('#feedbackSlot.show');
  return {
    resultVisible: !document.getElementById('result').classList.contains('hidden'),
    shelfVisible: !document.getElementById('shelf').classList.contains('hidden'),
    hasFeedback: !!fb, hasReveal: !!document.querySelector('#panelBody .reveal button'),
    hasAct: !!document.querySelector('#panelBody .acts button'),
    kind: p ? p.type : null, qid: p ? p.qid : null,
    qOrder: p && p.qid ? qs.findIndex(x => x.qid === p.qid) : -1,
    solved: p && p.type === 'question' ? !!(st.answers[p.qid] && st.answers[p.qid].solved) : null,
    correctIdx: p && p.type === 'question' ? p.options.findIndex(o => o.ok) : -1,
    wrongIdx: p && p.type === 'question' ? p.options.findIndex(o => !o.ok) : -1,
    pollDone: p && p.type === 'poll' ? (st.polls[p.pid] ? st.polls[p.pid].choice : -1) : -1,
    idx: st ? st.index : -1, clues: st ? st.clues.length : -1,
    mood: app.audio.mood()
  };
})()`;

function planFor(order) {
  if (order === 0) return ["wrong", "correct"];
  if (order === 1) return ["hint", "correct"];
  return ["correct"];
}

const chapterCount = await evalJs("window.__app.chapters().length");
const report = [];
let pollShot = false;

for (let ci = 0; ci < chapterCount; ci++) {
  // 回到书架
  if (!(await evalJs("!document.getElementById('shelf').classList.contains('hidden')"))) {
    await evalJs("(()=>{const b=[...document.querySelectorAll('#resultBody button')].find(x=>x.textContent.indexOf('返回书架')>=0); if(b) b.click();})()");
    await wait(700);
  }
  const title = await evalJs(`window.__app.chapters()[${ci}].title`);
  if (!(await click(`#shelfGrid .chapter:nth-child(${ci + 1})`))) problems.push(`第 ${ci + 1} 关卡片点不到`);
  await wait(1500);
  const entered = await evalJs("!!window.__app.state()");
  if (!entered) { problems.push(`第 ${ci + 1} 关没能进入`); continue; }
  const baseStart = await evalJs("JSON.parse(JSON.stringify(window.__app.base()))");

  const done = new Set();
  const trace = [];

  for (let step = 0; step < 120; step++) {
    const pr = await evalJs(PROBE);
    if (!pr) { problems.push(`探针空 @${title} step ${step}`); break; }
    if (pr.resultVisible) { trace.push("结算"); break; }

    if (pr.hasFeedback) { await click("#feedbackSlot button"); await wait(430); continue; }

    if (pr.kind === "poll") {
      if (pr.pollDone < 0) {
        await click(`.opts .opt:nth-child(${(step % 3) + 1})`);
        await wait(420);
        trace.push("留下倾向");
        if (!pollShot) { await shot("10-poll"); pollShot = true; }
      } else { await click("#panelBody .acts button"); await wait(500); trace.push("poll 继续"); }
      continue;
    }

    if (pr.kind === "question" && !pr.solved) {
      const plan = planFor(pr.qOrder);
      const next = plan.filter(x => !done.has(pr.qid + ":" + x))[0] || "correct";
      if (next === "hint") {
        await click("#panelBody .acts button.ghost");
        await wait(340);
        done.add(pr.qid + ":hint");
        trace.push(pr.qid + " 看提示");
        continue;
      }
      await click(`.opts .opt:nth-child(${(next === "wrong" ? pr.wrongIdx : pr.correctIdx) + 1})`);
      await wait(520);
      done.add(pr.qid + ":" + next);
      trace.push(pr.qid + (next === "wrong" ? " 错答" : " 答对"));
      continue;
    }

    if (pr.hasReveal) { await click("#panelBody .reveal button"); await wait(340); trace.push("翻开记录"); continue; }
    if (pr.hasAct) { await click("#panelBody .acts button"); await wait(540); continue; }
    problems.push(`卡住 @${title} step ${step} ` + JSON.stringify(pr));
    break;
  }

  const fin = await evalJs(`(()=>{const st=window.__app.state();const ch=window.__app.chapter();
    return { title: ch.title, score: st.score, done: st.done, clues: st.clues.length,
             polls: Object.keys(st.polls||{}).length,
             answers: Object.fromEntries(Object.entries(st.answers).map(([k,v])=>[k,v.points])),
             mood: window.__app.audio.mood(), base: JSON.parse(JSON.stringify(window.__app.base())) };})()`);
  await shot(`2${ci}-result-${ci + 1}`);
  report.push({ ci, title, trace: trace.join(" → "), ...fin, baseStart });
  // 通关后清理本关存档，避免影响后续关卡的书架点击
  await evalJs(`(()=>{try{localStorage.removeItem('mists-evidence-v1')}catch(e){}})()`);
}

console.log("=== 逐关结果 ===");
for (const r of report) {
  console.log(`\n[${r.ci + 1}] ${r.title}`);
  console.log("  " + r.trace);
  console.log(`  得分 ${r.score}（期望 78）· 通关 ${r.done} · 线索 ${r.clues} · 倾向 ${r.polls} 条`);
  console.log(`  联动目标 明度 ${r.baseStart.brightness.toFixed(2)} → ${r.base.brightness.toFixed(2)} · 张力 ${r.baseStart.tension.toFixed(2)} → ${r.base.tension.toFixed(2)}（期望 0.26→0.66 / 0.62→0.36）`);
  console.log("  " + JSON.stringify(r.answers));
}
const scores = report.map(r => r.score);
console.log("\n=== 汇总 ===");
console.log(`关卡数 ${report.length}/${chapterCount} · 得分 ${scores.join(", ")} · 全部为 78：${scores.every(s => s === 78)}`);
console.log(`通关标记全部为真：${report.every(r => r.done === true)}`);
console.log(`每关都有倾向记录：${report.every(r => r.polls >= 1)}`);
console.log(`每关起点联动目标一致：${report.every(r => Math.abs(r.baseStart.brightness - 0.26) < 0.001 && Math.abs(r.baseStart.tension - 0.62) < 0.001)}`);
console.log(`每关终点联动目标一致：${report.every(r => Math.abs(r.base.brightness - 0.66) < 0.001 && Math.abs(r.base.tension - 0.36) < 0.001)}`);
console.log("=== JS 异常/错误 ===");
console.log(problems.length ? problems.join("\n") : "(无)");

await fetch(`${base}/json/close/${target.id}`).catch(() => {});
ws.close();
process.exit(problems.length ? 1 : 0);

