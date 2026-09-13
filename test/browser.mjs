// End-to-end test of the page in headless Chromium (Playwright): the real buttons, the Worker,
// the wasm module with Wasm exception handling, all fixtures through the page's compare button.
//   npm install && node test/browser.mjs            (CHROMIUM=/path/to/chrome to use a given binary)
//   URL=https://kishima.github.io/sabiruby-playground/ node test/browser.mjs   (a deployed site)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".rb": "text/plain; charset=utf-8", ".out": "text/plain; charset=utf-8" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(web, path.endsWith("/") ? path + "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const url = process.env.URL || `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

let bad = 0;
async function check(name, f) {
  try { await f(); console.log(`ok   ${name}`); } catch (e) { bad++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
}
const status = () => page.textContent("#status");
const waitDone = () => page.waitForFunction(() => /^(完了|例外で終了|コンパイルエラー)/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
async function setCode(text) {
  await page.click(".cm-content");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}
async function runCode(text) {
  if (text !== undefined) await setCode(text);
  await page.click("#run");
  await waitDone();
  return page.textContent("#output");
}

const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 30000 });
const readyMs = Date.now() - t0;
console.log(`page ready after ${readyMs} ms: ${await status()}`);
console.log(`version: ${await page.textContent("#version")}`);

await check("the default program runs", async () => {
  const out = await runCode();
  if (!out.includes("Hello, SabiRuby!\n[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\napple: ***")) throw new Error(JSON.stringify(out));
  if (!(await status()).startsWith("完了")) throw new Error(await status());
});

const fixtures = (await (await fetch(new URL("samples/index.json", url))).json()).fixtures;
await check(`all ${fixtures.length} fixtures match the reference through the compare button`, async () => {
  const failed = [];
  for (const f of fixtures) {
    await page.selectOption("#sample", `f:${f.name}`);
    await page.waitForFunction((n) => document.getElementById("sample-note").textContent.startsWith(n + ".rb"), f.name);
    await page.click("#run");
    await waitDone();
    await page.click("#compare");
    const chip = await page.waitForSelector("#compare-result:not([hidden])");
    const text = await chip.textContent();
    if (text !== "本家と一致") failed.push(`${f.name}: ${text}`);
  }
  if (failed.length) throw new Error(failed.join(", "));
});

await check("a book example loads and runs", async () => {
  await page.selectOption("#sample", "b:overview_hello");
  await page.waitForFunction(() => document.getElementById("sample-note").textContent.startsWith("overview_hello.rb"));
  await page.click("#run");
  await waitDone();
});

await check("an endless loop is stopped and the VM comes back", async () => {
  await setCode("i = 0\nloop { i += 1 }");
  await page.click("#run");
  await page.waitForFunction(() => /命令/.test(document.getElementById("status").textContent), null, { timeout: 10000 });
  await page.click("#stop");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 10000 });
  if (!(await page.textContent("#output")).includes("停止しました")) throw new Error("no stop note");
  const out = await runCode('puts "again"');
  if (out !== "again\n") throw new Error(JSON.stringify(out));
});

await check("a compile error is shown as mrbc prints it", async () => {
  await runCode("x = 1 +");
  const err = await page.textContent("#output .err");
  if (!err.startsWith("playground.rb:1:8: syntax error")) throw new Error(err);
});

await check("an uncaught exception is shown", async () => {
  await runCode('raise "boom"');
  const err = await page.textContent("#output .err");
  if (err !== "boom (RuntimeError)") throw new Error(err);
});

await check("a generator error (setjmp/longjmp through Wasm EH) in the browser", async () => {
  await runCode('alias :"a#{1}" :b');
  const err = await page.textContent("#output .err");
  if (!err.includes("dynamic symbol is not supported")) throw new Error(err);
  if ((await runCode("p :fine")) !== ":fine\n") throw new Error("module unusable after the error");
});

await check("the panes are in pipeline order: code, AST, bytecode, result (the VM pane last)", async () => {
  const order = await page.$$eval("#panes > section", (s) => s.map((e) => e.className.split(" ")[1]));
  if (order.join() !== "editor-pane,ast-pane,dump-pane,output-pane,vm-pane") throw new Error(order.join());
  if (!(await page.isHidden("#vm-pane"))) throw new Error("the VM pane shows outside a debug session");
});

await check("the AST pane is open by default, follows edits and can be hidden", async () => {
  if (await page.isHidden("#ast-pane")) throw new Error("hidden at start");
  await setCode("x = 1 + 2");
  await page.waitForFunction(() => /LocalVariableWriteNode/.test(document.getElementById("ast").textContent), null, { timeout: 5000 });
  if (!(await page.textContent("#ast")).startsWith("@ ProgramNode (location: (1,0)-(1,9))")) throw new Error("unexpected tree");
  await page.click("#toggle-ast");
  if (!(await page.isHidden("#ast-pane"))) throw new Error("not hidden after the toggle");
  await page.click("#toggle-ast");
});

await check("the bytecode pane is open by default, follows edits and can be hidden", async () => {
  if (await page.isHidden("#dump-pane")) throw new Error("hidden at start");
  await setCode("puts 'hello'");
  await page.waitForFunction(() => /SSEND.*:puts/.test(document.getElementById("dump").textContent), null, { timeout: 5000 });
  const d = await page.textContent("#dump");
  if (!/^irep 0 nregs=/.test(d)) throw new Error(d.slice(0, 80));
  await page.click("#toggle-dump");
  if (!(await page.isHidden("#dump-pane"))) throw new Error("not hidden after the toggle");
  await page.click("#toggle-dump");
});

await check("a share link restores the code", async () => {
  await setCode('puts "shared #{1 + 1}"');
  await page.click("#share");
  await page.waitForFunction(() => location.hash.startsWith("#code="));
  const shared = page.url();
  const p2 = await browser.newPage();
  await p2.goto(shared);
  await p2.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 30000 });
  await p2.click("#run");
  await p2.waitForFunction(() => document.getElementById("status").textContent.startsWith("完了"));
  const out = await p2.textContent("#output");
  await p2.close();
  if (out !== "shared 2\n") throw new Error(JSON.stringify(out));
});

// ---- real time (docs/playground.md): sleep waits on the browser's clock

await check("実時間: sleep waits for real, and another task runs meanwhile", async () => {
  await page.click("#realtime");
  try {
    const t0 = Date.now();
    const out = await runCode('t = Time.now\nTask.new { 4.times { |i| puts "  tick #{i}"; sleep 0.05 } }\n3.times { sleep 0.1 }\nputs "slept #{((Time.now - t) * 1000).round} ms"\n');
    const ms = Date.now() - t0;
    // 3 x 100 ms of real waiting: a loop period may be added to each, never a multiple of it
    if (ms < 280 || ms > 900) throw new Error(`wall clock ${ms} ms`);
    const said = Number(/slept (\d+) ms/.exec(out)?.[1]);
    if (!(said >= 290 && said <= 600)) throw new Error(`Ruby's own clock says ${said}: ${JSON.stringify(out)}`);
    // the sleeping program leaves the CPU to the other task, which wakes twice as often
    if ((out.match(/tick/g) || []).length < 4) throw new Error(`the other task did not run: ${JSON.stringify(out)}`);
    if (!(await status()).startsWith("完了")) throw new Error(await status());
  } finally {
    await page.click("#realtime"); // back to the instruction-counted clock for the checks below
  }
});

await check("the 実時間 sample runs in both modes, and takes real time in one", async () => {
  const src = await (await fetch(new URL("samples/book/vm_task_realtime.rb", url))).text();
  const t0 = Date.now();
  const fast = await runCode(src);
  const fastMs = Date.now() - t0;
  if (!/結果 \[:blink_done, :beep_done\]/.test(fast)) throw new Error(JSON.stringify(fast));
  if (fastMs > 400) throw new Error(`the instruction-counted clock took ${fastMs} ms`);

  await page.click("#realtime");
  try {
    const t1 = Date.now();
    const slow = await runCode(src);
    const slowMs = Date.now() - t1;
    if (!/結果 \[:blink_done, :beep_done\]/.test(slow)) throw new Error(JSON.stringify(slow));
    // blink every 100 ms and beep every 200 ms while main sleeps 650 ms
    if (slowMs < 600 || slowMs > 2000) throw new Error(`wall clock ${slowMs} ms`);
    const stamps = [...slow.matchAll(/^\s*(\d+) ms/gm)].map((m) => Number(m[1]));
    if (Math.max(...stamps) < 600) throw new Error(`the sample's own clock stopped at ${Math.max(...stamps)}`);
  } finally {
    await page.click("#realtime");
  }
});

await check("the same program without 実時間 does not wait", async () => {
  const t0 = Date.now();
  await runCode('3.times { sleep 0.1 }\nputs "done"\n');
  const ms = Date.now() - t0;
  if (ms > 250) throw new Error(`took ${ms} ms with the instruction-counted clock`);
});

// ---- the debugger (docs/playground.md, the VM's src/inspect.rs)

await check("the step buttons are out of the way until the debug button is pressed", async () => {
  // `hidden` on a `.controls` element is not enough on its own (`.controls { display: flex }`
  // wins), and a page nobody had asked to debug showed a highlighted ステップオーバー
  const visible = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().height > 0);
  if (await visible("#debug-controls")) throw new Error("the step buttons show before デバッグ");
  if (!(await visible("#debug"))) throw new Error("the デバッグ button is not shown");
  await page.click("#debug");
  await page.waitForSelector("#dump .insn.current", { timeout: 20000 });
  if (!(await visible("#debug-controls"))) throw new Error("デバッグ did not open the step buttons");
  if (await page.getAttribute("#debug", "aria-pressed") !== "true") throw new Error("デバッグ does not read as pressed");
  await page.click("#debug-quit");
  if (await visible("#debug-controls")) throw new Error("the step buttons stayed after デバッグ終了");
});

await check("step over moves the current instruction", async () => {
  await setCode("a = 1\nb = a + 1\nc = b * 2\nd = c - 1\ne = d + a\np e\n"); // more lines than the steps below
  await page.click("#debug");
  await page.waitForSelector("#dump .insn.current", { timeout: 20000 });
  const at = () => page.$eval("#dump .insn.current", (e) => `${e.dataset.irep}:${e.dataset.pc}`);
  const seen = [await at()];
  for (let i = 0; i < 3; i++) {
    await page.click("#step-over");
    await page.waitForFunction(
      (prev) => { const c = document.querySelector("#dump .insn.current"); return c && `${c.dataset.irep}:${c.dataset.pc}` !== prev; },
      seen[seen.length - 1], { timeout: 20000 });
    seen.push(await at());
  }
  if (new Set(seen).size !== seen.length) throw new Error(`did not move: ${seen.join(" -> ")}`);
});

await check("stepping into mrblib says so, and the toggle keeps stepping in the program", async () => {
  await page.click("#debug"); // leave the session above
  await setCode("3.times { |i| i }\n");
  await page.click("#debug");
  await page.waitForSelector("#dump .insn.current", { timeout: 20000 });
  for (let i = 0; i < 8 && (await page.isHidden("#dump-banner")); i++) await page.click("#step-insn");
  if (await page.isHidden("#dump-banner")) throw new Error("no banner after stepping into 3.times");
  const text = await page.textContent("#dump-banner");
  if (!text.includes("Integer#times")) throw new Error(text);
  if (!(await page.$("#dump .insn.calling"))) throw new Error("the call being run is not marked");

  // the toggle: from the next step on, mrblib runs without stopping
  await page.click("#step-scope");
  await page.click("#step-insn");
  await page.waitForFunction(() => document.getElementById("dump-banner").hidden, null, { timeout: 20000 });
  if (!(await page.$("#dump .insn.current"))) throw new Error("no current instruction after leaving mrblib");
  await page.click("#step-scope"); // back to the default for the checks below
});

await check("the frame table shows main and its registers", async () => {
  const text = await page.textContent("#vm-body");
  if (!text.includes("(main)")) throw new Error(text.slice(0, 160));
  if (!/R0\s*self\s*main/.test(text.replace(/\s+/g, " "))) throw new Error(`no self register: ${text.slice(0, 200)}`);
});

await check("an opcode's description pops up in the listing", async () => {
  await page.hover("#dump .insn.current .op");
  const tip = await page.waitForSelector("#opcode-tip:not([hidden])", { timeout: 10000 });
  const op = await page.textContent("#dump .insn.current .op");
  const text = await tip.textContent();
  if (!text.startsWith(op.trim())) throw new Error(`${op}: ${text.slice(0, 120)}`);
  if (text.length < 20) throw new Error(`too short: ${text}`);
});

await check("running a closure to the end detaches its environment", async () => {
  await page.click("#debug"); // leave the session above
  await page.selectOption("#sample", "b:vm_closure");
  await page.waitForFunction(() => document.getElementById("sample-note").textContent.startsWith("vm_closure.rb"));
  await page.click("#debug");
  await page.waitForSelector("#dump .insn.current", { timeout: 20000 });
  await page.click("#continue");
  await page.waitForFunction(() => /^(完了|例外で終了)/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
  await page.click('#vm-tabs button[data-tab="envs"]');
  const text = await page.textContent("#vm-body");
  if (!/detached|外された/.test(text)) throw new Error(text.slice(0, 300));
});

await check("the GC tab counts the objects and can collect", async () => {
  await page.click('#vm-tabs button[data-tab="gc"]');
  const before = await page.textContent("#vm-body");
  if (!before.includes("生きている")) throw new Error(before.slice(0, 160));
  await page.click("#vm-body .gc-buttons button");
  await page.waitForFunction(() => !/^$/.test(document.getElementById("vm-body").textContent), null, { timeout: 10000 });
  await page.click('#vm-tabs button[data-tab="ops"]');
  const ops = await page.textContent("#vm-body");
  if (!/命令、/.test(ops)) throw new Error(ops.slice(0, 160));
  await page.click("#debug"); // back to the normal mode for the checks below
  await page.waitForFunction(() => document.getElementById("vm-pane").hidden);
});

if (process.env.SCREENSHOT) {
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById("run").disabled);
  await page.click("#run");
  await waitDone();
  await page.screenshot({ path: process.env.SCREENSHOT });
}

await check("no errors in the console", async () => { if (problems.length) throw new Error(problems.join(" | ")); });

console.log(`${bad ? "FAILED" : "all passed"}; page ready in ${readyMs} ms`);
await browser.close();
server.close();
process.exit(bad ? 1 : 0);
