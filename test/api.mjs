// Checks of the wasm module beyond the fixtures: the paths the page depends on.
//   node test/api.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Sabi, OK, COMPILE_ERROR, RUNTIME_ERROR, PAUSED, FINISHED, decoder } from "../web/sabi.js";

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
  "invalid UTF-8 in output does not throw": () => assert.equal(runAll('print "\\xff\\n"').out, "�\n"),
};

let bad = 0;
for (const [name, f] of Object.entries(checks)) {
  try { f(); console.log(`ok   ${name}`); } catch (e) { bad++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}
console.log(`${Object.keys(checks).length - bad}/${Object.keys(checks).length} checks`);
process.exit(bad ? 1 : 0);
