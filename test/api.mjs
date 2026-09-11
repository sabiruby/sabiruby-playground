// Checks of the wasm module beyond the fixtures: the paths the page depends on.
//   node test/api.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Sabi, OK, COMPILE_ERROR, RUNTIME_ERROR, PAUSED, FINISHED, STEP_INSN, STEP_LINE, STEP_FRAME, decoder } from "../web/sabi.js";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const sabi = await Sabi.create(await readFile(web + "sabiruby.wasm"));

function runAll(src, budget = 2_000_000) {
  assert.equal(sabi.reset(), OK);
  const c = sabi.compile(src);
  if (c !== OK) return { status: c, text: sabi.text(), out: "" };
  assert.equal(sabi.start(), OK);
  let r, out = "";
  while ((r = sabi.step(budget)) === PAUSED) out += decoder.decode(sabi.output());
  out += decoder.decode(sabi.output());
  return { status: r, text: r === FINISHED ? "" : sabi.text(), out };
}

/** Compiles with debug info and stops before the first instruction, recording events. */
function debugStart(src) {
  assert.equal(sabi.reset(), OK);
  sabi.trace(true);
  assert.equal(sabi.compile(src), OK, sabi.text());
  assert.equal(sabi.start(), OK);
  sabi.takeTrace(); // events from loading mrblib are not what these checks are about
}

const checks = {
  "puts and p": () => assert.equal(runAll('puts "hi"; p [1, :a, "b", nil, 2.5]').out, 'hi\n[1, :a, "b", nil, 2.5]\n'),
  "syntax error as mrbc prints it": () => {
    const r = runAll("x = 1 +");
    assert.equal(r.status, COMPILE_ERROR);
    assert.match(r.text, /^playground\.rb:1:8: syntax error, unexpected end-of-input/);
  },
  "generator error (the compiler's setjmp/longjmp, Wasm EH) and the module still works": () => {
    const r = runAll('alias :"a#{1}" :b');
    assert.equal(r.status, COMPILE_ERROR);
    assert.match(r.text, /dynamic symbol is not supported by alias\/undef/);
    assert.match(sabi.takeConsole(), /dynamic symbol/); // the compiler's own fprintf(stderr)
    assert.equal(runAll("p 1 + 1").out, "2\n");
  },
  "uncaught exception": () => {
    const r = runAll('raise ArgumentError, "bad"');
    assert.equal(r.status, RUNTIME_ERROR);
    assert.equal(r.text, "bad (ArgumentError)");
  },
  "local_variables (debug info kept)": () => assert.equal(runAll("a = 1; b = 2; p local_variables").out, "[:a, :b]\n"),
  "fibers across step budgets": () => assert.equal(runAll("f = Fiber.new { 3.times { |i| Fiber.yield i } ; :done }; 4.times { p f.resume }", 7).out, "0\n1\n2\n:done\n"),
  "an endless loop pauses at every budget": () => {
    assert.equal(sabi.reset(), OK);
    assert.equal(sabi.compile("i = 0; loop { i += 1 }"), OK);
    sabi.start();
    for (let k = 0; k < 5; k++) assert.equal(sabi.step(100_000), PAUSED);
    assert.ok(sabi.stats().instructions >= 500_000);
  },
  "deep Ruby recursion ends in SystemStackError": () => {
    const r = runAll("def f(n) = f(n + 1); begin; f(0); rescue SystemStackError => e; p e.class; end");
    assert.equal(r.out, "SystemStackError\n");
  },
  "deep native re-entry (Class#new -> initialize) stays on the 4 MB stack": () => {
    const r = runAll("class A; def initialize(n) = (A.new(n + 1) if n < 10_000); end; begin; A.new(0); rescue SystemStackError => e; p e.class; end");
    assert.equal(r.out, "SystemStackError\n");
  },
  "deeply nested source is a parser error, not a crash": () => {
    const r = runAll("p " + "[".repeat(1000) + "]".repeat(1000));
    assert.equal(r.status, COMPILE_ERROR);
  },
  "GC keeps memory bounded": () => {
    const r = runAll("200_000.times { |i| [i, 'x' * 10, {k: i}] }; GC.start; p GC.stat[:live] < 5000");
    assert.equal(r.out, "true\n");
    assert.ok(sabi.stats().gc > 10);
  },
  "ast is Prism's pretty-printed tree (the book's format)": () => {
    const t = sabi.ast("x = 1 + 2");
    assert.match(t, /^@ ProgramNode \(location: \(1,0\)-\(1,9\)\)\n\+-- locals: \[:x\]\n/);
    assert.match(t, /@ LocalVariableWriteNode/);
    assert.match(sabi.ast("def f("), /^@ ProgramNode/); // a tree even with a syntax error
  },
  "dump lists the instructions": () => {
    assert.equal(sabi.compile("puts 'hello'"), OK);
    assert.match(sabi.dump(), /^irep 0 nregs=\d+ nlocals=1 [\s\S]*SSEND\t\d+\t\d+\t1\t; :puts/);
  },
  "a file that is not RITE is rejected by sabi_load": () => {
    assert.equal(sabi.load(new Uint8Array([1, 2, 3])), COMPILE_ERROR);
    assert.match(sabi.text(), /not a RITE binary/);
  },
  // ---- the debugger's paths (wasm/src/json.rs, src/inspect.rs of the VM)
  "state() describes the frames and names the registers": () => {
    debugStart("x = 1\ny = x + 1\np y\n");
    assert.equal(sabi.stepUntil(STEP_LINE), PAUSED);
    const s = sabi.state();
    const f = s.contexts[s.cur].frames[0];
    assert.equal(f.regs[0].text, "main", JSON.stringify(f.regs)); // regs carry the value inline
    assert.equal(f.regs[0].class, "Object");
    assert.equal(f.regs[1].name, "x");
    assert.equal(f.nregs, f.regs.length);
    assert.ok(s.heap.live > 0 && s.heap.free === s.heap.len - s.heap.live);
    assert.equal(s.pending_exc, null);
  },
  "stepUntil(STEP_LINE) moves to the next line, STEP_INSN one instruction": () => {
    debugStart("a = 1\nb = 2\nc = 3\n");
    const line = () => sabi.state(1).contexts[0].frames[0].line;
    const first = line();
    assert.equal(sabi.stepUntil(STEP_LINE), PAUSED);
    assert.ok(line() > first, `${first} -> ${line()}`);
    const before = sabi.stats().instructions;
    assert.equal(sabi.stepUntil(STEP_INSN), PAUSED);
    assert.equal(sabi.stats().instructions, before + 1);
  },
  "stepUntil(STEP_FRAME) stops where a method is entered": () => {
    debugStart("def f(n) = n + 1\np f(1)\n");
    let depth = 1;
    for (let k = 0; k < 40 && depth < 2; k++) {
      if (sabi.stepUntil(STEP_FRAME) !== PAUSED) break;
      depth = sabi.state(1).contexts[0].frames.length;
    }
    assert.equal(depth, 2, "never entered f");
    assert.equal(sabi.state(2).contexts[0].frames[1].mid, "f");
  },
  "a closure's trace has EnvCreate and EnvDetach": () => {
    debugStart("def mk\n  n = 0\n  -> { n += 1 }\nend\nc = mk\np c.call\n");
    let r;
    while ((r = sabi.stepUntil(STEP_LINE)) === PAUSED) { /* to the end */ }
    assert.equal(r, FINISHED, sabi.text());
    const t = sabi.takeTrace();
    const kinds = t.map((e) => e.kind);
    assert.ok(kinds.includes("env_create"), JSON.stringify(kinds));
    const detach = t.find((e) => e.kind === "env_detach");
    assert.ok(detach && detach.reason === "frame_return", JSON.stringify(t.filter((e) => e.kind === "env_detach")));
    assert.ok(t.some((e) => e.kind === "env_create" && e.env === detach.env), "detached an environment that was never created");
  },
  "a raise records the catch table lookups": () => {
    debugStart("begin\n  raise 'boom'\nrescue => e\n  p e.message\nend\n");
    while (sabi.stepUntil(STEP_LINE) === PAUSED) { /* to the end */ }
    const t = sabi.takeTrace();
    const raise = t.findIndex((e) => e.kind === "raise");
    assert.ok(raise >= 0, JSON.stringify(t.map((e) => e.kind)));
    assert.equal(t[raise].class, "RuntimeError");
    assert.ok(t.slice(raise).some((e) => e.kind === "catch_look" && e.matched), "nothing matched");
  },
  "gcCollect and gcStress report through the heap view": () => {
    debugStart("1000.times { [1, 2, 3] }\n");
    sabi.gcStress(false);
    while (sabi.stepUntil(3, 100_000) === PAUSED) { /* to the end */ }
    sabi.takeTrace();
    const before = sabi.state().heap.live;
    sabi.gcCollect();
    const after = sabi.state().heap;
    assert.ok(after.live <= before, `${before} -> ${after.live}`);
    assert.ok(after.gc_count >= 1);
  },
  "dumpJson gives the instructions as rows with line numbers": () => {
    assert.equal(sabi.reset(), OK);
    assert.equal(sabi.compile("puts 'hello'\np 1\n"), OK);
    assert.equal(sabi.start(), OK);
    const d = sabi.dumpJson();
    const irep = d.ireps[0];
    assert.equal(irep.insns[0].line, 1);
    assert.ok(irep.insns.some((i) => i.op === "SSEND" && /:puts/.test(i.text)), JSON.stringify(irep.insns.slice(0, 4)));
    assert.ok(irep.insns.some((i) => i.line === 2), "the second line is missing");
    assert.equal(typeof d.offset, "number");
    assert.ok(d.ireps.length >= 1 && typeof irep.nregs === "number");
  },
  "opCounts names the instructions that ran": () => {
    assert.equal(runAll("a = 1; b = a; p b").out, "1\n");
    const counts = sabi.opCounts();
    const move = counts.find((c) => c.op === "MOVE");
    assert.ok(move && move.count > 0, JSON.stringify(counts.slice(0, 8)));
    assert.ok(counts.every((c) => c.count > 0), "instructions that never ran must be left out");
  },
  "invalid UTF-8 in output does not throw": () => assert.equal(runAll('print "\\xff\\n"').out, "�\n"),
};

let bad = 0;
for (const [name, f] of Object.entries(checks)) {
  try { f(); console.log(`ok   ${name}`); } catch (e) { bad++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}
console.log(`${Object.keys(checks).length - bad}/${Object.keys(checks).length} checks`);
process.exit(bad ? 1 : 0);
