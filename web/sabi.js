// Thin wrapper over the C ABI of sabiruby.wasm (wasm/src/lib.rs). Used by worker.js in the
// browser and by test/fixtures.mjs in Node, so both drive the module the same way.
// The WASI imports come from browser_wasi_shim in both places.

import { WASI, File, OpenFile, ConsoleStdout } from "./vendor/browser_wasi_shim/index.js";

export const OK = 0, COMPILE_ERROR = 1, RUNTIME_ERROR = 2, INTERNAL_ERROR = 3;
export const PAUSED = 0, FINISHED = 1;
/** `stepUntil` modes, named as a debugger's step buttons are: one instruction; step over (the
 *  next line of this frame, calls running without stopping inside them); step into (the next
 *  line, or entering/leaving a frame); step out (until this frame returns); continue (a budget
 *  of instructions, what Run uses). */
export const STEP_INSTRUCTION = 0, STEP_OVER = 1, STEP_INTO = 2, STEP_OUT = 3, STEP_CONTINUE = 4;

const decoder = new TextDecoder("utf-8", { fatal: false }); // Ruby strings are bytes
const encoder = new TextEncoder();

export class Sabi {
  /** `source`: a compiled WebAssembly.Module, a Response (streaming compile), an ArrayBuffer
   *  or a Uint8Array. */
  static async create(source) {
    // stdout/stderr of the C side (the compiler writes a few diagnostics with fprintf)
    const console = [];
    const sink = new ConsoleStdout((bytes) => console.push(bytes.slice()));
    const wasi = new WASI([], [], [new OpenFile(new File([])), sink, sink]);
    const imports = { wasi_snapshot_preview1: wasi.wasiImport };
    const instance = source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (source instanceof Response
        ? await WebAssembly.instantiateStreaming(source, imports)
        : await WebAssembly.instantiate(source, imports)).instance;
    wasi.initialize(instance);
    return new Sabi(instance, console);
  }

  constructor(instance, console) {
    this.x = instance.exports;
    this.console = console;
    this.scratch = this.x.sabi_alloc(32); // u32 length at +0, u64 stats at +8/+16/+24
  }

  view() { return new DataView(this.x.memory.buffer); }
  bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len).slice(); }

  version() {
    const p = this.x.sabi_version();
    const mem = new Uint8Array(this.x.memory.buffer);
    let end = p;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.subarray(p, end));
  }

  /** Calls a `sabi_take_*`-style export and copies the bytes it returns. */
  take(fn) {
    const p = fn(this.scratch);
    return this.bytes(p, this.view().getUint32(this.scratch, true));
  }

  withBytes(data, fn) {
    const b = typeof data === "string" ? encoder.encode(data) : data;
    const p = this.x.sabi_alloc(b.length);
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    try { return fn(p, b.length); } finally { this.x.sabi_free(p, b.length); }
  }

  /** Ruby source to bytecode; `debug` keeps line numbers and local variable names (mrbc -g). */
  compile(src, debug = true) { return this.withBytes(src, (p, n) => this.x.sabi_compile(p, n, debug ? 1 : 0)); }
  load(mrb) { return this.withBytes(mrb, (p, n) => this.x.sabi_load(p, n)); }
  reset() { return this.x.sabi_reset(); }
  start() { return this.x.sabi_start(); }
  step(budget) { return this.x.sabi_step(budget); }
  output() { return this.take(this.x.sabi_take_output); }
  text() { return decoder.decode(this.take(this.x.sabi_take_text)); }
  dump() { return decoder.decode(this.take(this.x.sabi_dump)); }
  /** Prism's pretty-printed syntax tree of `src` (as the book's listings). */
  ast(src) { return this.withBytes(src, (p, n) => decoder.decode(this.take((lp) => this.x.sabi_ast(p, n, lp)))); }

  // ---- debugging (src/inspect.rs of the VM; see docs/playground.md)

  /** Records what the interpreter does until the next `takeTrace()`. */
  trace(on) { this.x.sabi_trace(on ? 1 : 0); }
  /** STEP_INSTRUCTION / STEP_OVER / STEP_INTO / STEP_OUT / STEP_CONTINUE; returns PAUSED,
   *  FINISHED or an error. */
  stepUntil(mode, budget = 1_000_000) { return this.x.sabi_step_until(mode, budget); }
  /** The VM as it stands: contexts, frames, registers, environments, heap. */
  state(regsFrames = 8) { return JSON.parse(decoder.decode(this.take((lp) => this.x.sabi_state(regsFrames, lp)))); }
  /** The events recorded since the last call. */
  takeTrace() { return JSON.parse(decoder.decode(this.take(this.x.sabi_take_trace))); }
  /** Stop only in the program's own ireps: mrblib and the gems run without stopping inside. */
  stepProgramOnly(on) { this.x.sabi_step_program_only(on ? 1 : 0); }
  gcCollect() { return this.x.sabi_gc_collect(); }
  gcStress(on) { this.x.sabi_gc_stress(on ? 1 : 0); }
  /** `[{op, count}, ..]` for the instructions executed so far. */
  opCounts() { return JSON.parse(decoder.decode(this.take(this.x.sabi_op_counts))); }
  /** The instruction listing as data: `{offset, root, ireps:[{index, insns:[{pc, line, op, text}]}]}`. */
  dumpJson() { return JSON.parse(decoder.decode(this.take(this.x.sabi_dump_json))); }
  /** Bytes the C side wrote to stdout/stderr since the last call. */
  takeConsole() {
    const parts = this.console.splice(0);
    return parts.length ? decoder.decode(concat(parts)) : "";
  }
  stats() {
    const s = this.scratch;
    this.x.sabi_stats(s + 8, s + 16, s + 24);
    const v = this.view();
    return { instructions: Number(v.getBigUint64(s + 8, true)), live: Number(v.getBigUint64(s + 16, true)), gc: Number(v.getBigUint64(s + 24, true)) };
  }
}

export function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { decoder };
