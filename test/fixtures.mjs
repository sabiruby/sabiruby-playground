// Runs every web/samples/fixtures/*.rb through web/sabiruby.wasm (compiled by the wasm build of the
// reference compiler, run by the wasm build of SabiRuby) and compares stdout with the reference
// mruby's .out, byte for byte. Uses web/sabi.js and browser_wasi_shim, like the page.
//   node test/fixtures.mjs
// An uncaught error is appended as "<error: message>\n", as sabiruby's tests/fixtures.rs does.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sabi, OK, PAUSED, FINISHED, concat } from "../web/sabi.js";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const BUDGET = 2_000_000;

const t0 = performance.now();
const sabi = await Sabi.create(await readFile(web + "sabiruby.wasm"));
const tInit = performance.now() - t0;
console.log(sabi.version());
console.log(`instantiate: ${tInit.toFixed(1)} ms`);

/** Compiles and runs one program; returns its stdout (bytes) and status. */
export function run(sabi, src) {
  let st = sabi.reset();
  if (st !== OK) return { out: new TextEncoder().encode(`<error: ${sabi.text()}>\n`), status: st };
  st = sabi.compile(src);
  if (st !== OK) return { out: new TextEncoder().encode(`<compile error: ${sabi.text()}>\n`), status: st };
  sabi.start();
  const parts = [];
  let r;
  while ((r = sabi.step(BUDGET)) === PAUSED) parts.push(sabi.output());
  parts.push(sabi.output());
  if (r !== FINISHED) parts.push(new TextEncoder().encode(`<error: ${sabi.text()}>\n`));
  return { out: concat(parts), status: r };
}

const dir = web + "samples/fixtures/";
const names = (await readdir(dir)).filter((f) => f.endsWith(".rb")).map((f) => f.slice(0, -3)).sort();
let bad = 0;
for (const name of names) {
  const src = await readFile(dir + name + ".rb");
  const expected = await readFile(dir + name + ".out");
  const t = performance.now();
  const { out } = run(sabi, src);
  const ms = performance.now() - t;
  const same = Buffer.compare(Buffer.from(out), expected) === 0;
  if (!same) bad++;
  console.log(`${same ? "ok  " : "DIFF"} ${name.padEnd(12)} ${ms.toFixed(1).padStart(7)} ms`);
  if (!same) {
    const a = Buffer.from(out).toString(), b = expected.toString();
    const i = [...a].findIndex((c, k) => c !== b[k]);
    console.log(`     first difference at ${i}: got ${JSON.stringify(a.slice(i, i + 60))}, expected ${JSON.stringify(b.slice(i, i + 60))}`);
  }
}
console.log(`${names.length - bad}/${names.length} fixtures match the reference output`);
process.exit(bad ? 1 : 0);
