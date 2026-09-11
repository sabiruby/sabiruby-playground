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

// ---- the debugger (docs/playground.md, the VM's src/inspect.rs)

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
