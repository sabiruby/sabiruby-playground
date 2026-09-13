// Runs SabiRuby off the UI thread. The page sends the compiled WebAssembly.Module once
// ("init"), then "run" / "inspect" / "debug-*" requests. Stopping a run is the page's worker.terminate():
// it works even in the middle of a step, and the page starts a fresh worker from the same module.

import { Sabi, OK, PAUSED, FINISHED, STEP_CONTINUE } from "./sabi.js";

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

/** Milliseconds of real time, waited on the event loop (there is no thread here to block). */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The same program, with mruby-task's clock taken from the wall clock instead of from the
 * instruction count: `sleep 1` waits a second, and the task that is not sleeping runs meanwhile.
 *
 * Two things this loop has to get right, both of them lessons from FreeRTOS's own Emscripten
 * port (`doc/wasm/` of family-mruby), where the same two bugs cost a day each:
 *
 *   * the clock is caught up from a fixed origin (`due = elapsed / tick`), never by adding up
 *     deltas, so rounding does not accumulate and a slow turn is made up for on the next one;
 *   * the catch-up happens *before* the scheduler runs, above — a turn that woke a task and only
 *     then moved the clock would leave it waiting one more turn, which shows up as every sleep
 *     taking one loop period too long.
 *
 * The program itself is a task here (`startAsTask`), which is what makes a plain top-level
 * `sleep` the scheduler's business. `Task.current` answers that task rather than the "main"
 * wrapper: the one visible difference from a normal run.
 */
async function runRealtime(src) {
  const t0 = performance.now();
  if (sabi.reset() !== OK) return post({ type: "done", kind: "internal", text: sabi.text(), ms: 0 });
  if (sabi.compile(src) !== OK) {
    const text = sabi.text();
    sabi.takeConsole();
    return post({ type: "done", kind: "compile", text, ms: performance.now() - t0 });
  }
  if (sabi.startAsTask() !== OK) return post({ type: "done", kind: "internal", text: sabi.text(), ms: 0 });
  sabi.taskExternalClock(true);
  const unit = sabi.taskTickUnitMs();
  const origin = performance.now();
  let supplied = 0, last = t0, yielded = origin;
  for (;;) {
    const due = Math.floor((performance.now() - origin) / unit);
    sabi.taskAdvanceTicks(due - supplied);
    supplied = Math.max(supplied, due);

    const { status, spent } = sabi.taskRun(BUDGET);
    flush();
    if (status !== OK) {
      return post({ type: "done", kind: "error", text: sabi.text(), stats: sabi.stats(), ms: performance.now() - t0 });
    }
    const state = sabi.taskProgramState();
    if (state !== 0 && !sabi.taskPending()) {
      const kind = state === 2 ? "error" : "finished";
      return post({ type: "done", kind, text: kind === "error" ? sabi.text() : "", stats: sabi.stats(), ms: performance.now() - t0 });
    }
    const now = performance.now();
    if (now - last > 200) { post({ type: "progress", stats: sabi.stats(), ms: now - t0, realtime: true }); last = now; }

    if (spent === 0) {
      // nothing to run: wait out the earliest deadline (capped, so a long sleep still reports
      // progress and a stop is seen), or end where nothing can wake anything
      const wait = sabi.taskNextWakeupMs();
      if (wait < 0) {
        return post({ type: "done", kind: "finished", text: "", stats: sabi.stats(), ms: performance.now() - t0 });
      }
      await delay(Math.min(Math.max(wait, 1), 100));
      yielded = performance.now();
    } else if (now - yielded > 16) {
      await delay(0); // let messages through while a task is busy
      yielded = performance.now();
    }
  }
}

/** The AST and the bytecode of `src`, for the panes between the code and the result. */
function inspect(src, id) {
  const ast = sabi.ast(src);
  if (sabi.compile(src) !== OK) {
    const text = sabi.text();
    sabi.takeConsole();
    return post({ type: "inspect", id, ast, ok: false, dump: text });
  }
  // `dumpJson` is the same listing as data: the page draws the rows from it (opcode tooltips)
  post({ type: "inspect", id, ast, ok: true, dump: sabi.dump(), dumpJson: sabi.dumpJson() });
}

// ---- debugging: the page drives the VM one step at a time and reads its state

/** Compiles and prepares the program, with recording on. */
function debugStart(src) {
  if (sabi.reset() !== OK) return post({ type: "debug", phase: "error", text: sabi.text() });
  sabi.trace(true);
  if (sabi.compile(src) !== OK) {
    const text = sabi.text();
    sabi.takeConsole();
    return post({ type: "debug", phase: "compile_error", text });
  }
  if (sabi.start() !== OK) return post({ type: "debug", phase: "error", text: sabi.text() });
  sabi.takeTrace(); // events from loading mrblib are not interesting
  post({ type: "debug", phase: "started", dump: sabi.dumpJson(), state: sabi.state(), trace: [], stats: sabi.stats() });
}

/** One step of the chosen kind; `STEP_CONTINUE` runs on like the Run button. */
function debugStep(mode, budget) {
  const t0 = performance.now();
  let r;
  if (mode === STEP_CONTINUE) {
    let last = t0;
    while ((r = sabi.stepUntil(STEP_CONTINUE, budget || BUDGET)) === PAUSED) {
      flush();
      const now = performance.now();
      if (now - last > 200) { post({ type: "progress", stats: sabi.stats(), ms: now - t0 }); last = now; }
    }
  } else {
    r = sabi.stepUntil(mode, budget || BUDGET);
  }
  flush();
  const phase = r === PAUSED ? "paused" : r === FINISHED ? "finished" : "error";
  post({ type: "debug", phase, state: sabi.state(), trace: sabi.takeTrace(), stats: sabi.stats(),
         text: r === FINISHED || r === PAUSED ? "" : sabi.text(), ms: performance.now() - t0 });
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
      if (m.realtime) await runRealtime(m.src); else run(m.src);
    } else if (m.type === "inspect") {
      inspect(m.src, m.id);
    } else if (m.type === "debug-start") {
      debugStart(m.src);
    } else if (m.type === "debug-step") {
      debugStep(m.mode, m.budget);
    } else if (m.type === "debug-scope") {
      sabi.stepProgramOnly(m.programOnly);
    } else if (m.type === "debug-gc") {
      if (m.stress !== undefined) sabi.gcStress(m.stress);
      if (m.collect) sabi.gcCollect();
      post({ type: "debug", phase: "paused", state: sabi.state(), trace: sabi.takeTrace(), stats: sabi.stats(), text: "" });
    } else if (m.type === "debug-stop") {
      sabi.trace(false);
      sabi.reset();
      post({ type: "debug", phase: "stopped" });
    } else if (m.type === "op-counts") {
      post({ type: "op-counts", counts: sabi.opCounts() });
    }
  } catch (err) {
    // a trap (e.g. out of memory) leaves the instance unusable; the page restarts the worker
    post({ type: "crash", text: String(err && err.message || err) });
  }
};
