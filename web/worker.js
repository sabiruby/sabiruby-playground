// Runs SabiRuby off the UI thread. The page sends the compiled WebAssembly.Module once
// ("init"), then "run" / "dump" requests. Stopping a run is the page's worker.terminate():
// it works even in the middle of a step, and the page starts a fresh worker from the same module.

import { Sabi, OK, PAUSED, FINISHED } from "./sabi.js";

const BUDGET = 1_000_000; // instructions per step; output and progress go out between steps
let sabi;

const post = (m, transfer) => self.postMessage(m, transfer || []);

function flush() {
  const out = sabi.output();
  if (out.length) post({ type: "output", bytes: out }, [out.buffer]);
}

function run(src) {
  const t0 = performance.now();
  if (sabi.reset() !== OK) return post({ type: "done", kind: "internal", text: sabi.text(), ms: 0 });
  if (sabi.compile(src) !== OK) {
    const text = sabi.text();
    sabi.takeConsole(); // the compiler's own stderr repeats the diagnostics
    return post({ type: "done", kind: "compile", text, ms: performance.now() - t0 });
  }
  if (sabi.start() !== OK) return post({ type: "done", kind: "internal", text: sabi.text(), ms: 0 });
  let r, last = t0;
  while ((r = sabi.step(BUDGET)) === PAUSED) {
    flush();
    const now = performance.now();
    if (now - last > 200) { post({ type: "progress", stats: sabi.stats(), ms: now - t0 }); last = now; }
  }
  flush();
  const kind = r === FINISHED ? "finished" : r === 2 ? "error" : "internal";
  post({ type: "done", kind, text: r === FINISHED ? "" : sabi.text(), stats: sabi.stats(), ms: performance.now() - t0 });
}

function dump(src) {
  if (sabi.compile(src) !== OK) { const text = sabi.text(); sabi.takeConsole(); return post({ type: "dump", ok: false, text }); }
  post({ type: "dump", ok: true, text: sabi.dump() });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      sabi = await Sabi.create(m.module);
      if (sabi.reset() !== OK) throw new Error(sabi.text());
      post({ type: "ready", version: sabi.version(), ms: performance.now() - t0 });
    } else if (m.type === "run") {
      run(m.src);
    } else if (m.type === "dump") {
      dump(m.src);
    }
  } catch (err) {
    // a trap (e.g. out of memory) leaves the instance unusable; the page restarts the worker
    post({ type: "crash", text: String(err && err.message || err) });
  }
};
