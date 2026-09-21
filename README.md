# SabiRuby Playground

Write Ruby in the browser and run it with **mruby 4.1's own compiler** and the
[SabiRuby](https://github.com/sabiruby/sabiruby) VM, both compiled to WebAssembly. No server:
the page is static (GitHub Pages) and everything runs in a Web Worker.

**https://sabiruby.github.io/sabiruby-playground/**

* The compiler is the reference one, not a port: mruby 4.1.0-rc's `mruby-compiler` (Prism
  1.9.0 + mruby's code generator), C built with wasi-sdk
  ([`sabiruby-compiler`](https://crates.io/crates/sabiruby-compiler)). Its bytecode is
  byte-identical to `mrbc`'s.
* The VM is [`sabiruby`](https://crates.io/crates/sabiruby), pure Rust, with its garbage
  collector; the program runs in steps of 1,000,000 instructions, so an endless loop does not
  freeze the page and **Stop** terminates the worker at once.
* Four panes in the order of the pipeline: **code → AST → bytecode → result**. The AST is
  Prism's syntax tree as `pm_prettyprint` prints it (the format of a debug `mrbc --verbose` and of
  the book's chapter 5), i.e. the tree mruby's code generator walks; the bytecode is
  `sabiruby dump` (modelled on `mrbc --verbose`). Both follow the editor and can be hidden.
* The samples are SabiRuby's reference fixtures, each with the reference mruby's stdout:
  **Compare with mruby** checks the playground's output against it, byte for byte. The book's
  example scripts (*Deep dive into mruby*, via the mruby porting kit) are there too.
* **デバッグ** steps the VM with the usual debugger buttons — step over, step into, step out and
  one instruction (F10 / F11 / Shift+F11 / Ctrl+F11) — and shows what is normally invisible: the call stack with named registers, the environments a closure leaves
  behind, the catch tables a `raise` walks, the fibers, the heap and the GC, and a histogram of
  the executed opcodes. Hovering an opcode shows its definition and summary. This is what the
  reference mruby on wasm cannot do without patching `vm.c`; see `docs/ideas.md`.
* **実時間** makes `sleep` wait on the browser's clock instead of costing nothing. mruby-task's
  tick is counted in instructions here, so a sleeping task is normally woken the moment the
  scheduler runs out of other work; with the toggle on, the program itself runs as a task, the
  worker moves the scheduler's clock from the wall clock, and waits out the rest on the event
  loop — so `sleep 1` is a second, and another task runs during it. No `SharedArrayBuffer` and no
  cross-origin isolation are involved: the VM returns to JS between two instructions, so nothing
  has to block. The one visible difference is that `Task.current` answers the program's own task.
  Off while debugging. The sample **vm_task_realtime** is written to show both: the same
  program, the same order, a millisecond with the toggle off and two thirds of a second with it
  on.
* **Share link** puts the code (up to 8 KB) into the URL.

## Numbers

| | |
|---|---|
| `sabiruby.wasm` | 2,445,509 bytes, 840,268 over gzip (GitHub Pages compresses it) — built here with wasi-sdk 34 and binaryen 132 against SabiRuby `7be7b86`; of those `sabi_highlight` costs 1,736 bytes (493 over gzip), the same tree measured with and without the export. The deployed module was 2,439,299 bytes on 2026-09-15 (SabiRuby `9fa5b0b`); earlier and smaller: 1,303,895 / 438,065, 1,233,982 / 421,485 before the debugger, 1,169,017 / 421,881 before the AST pane |
| page ready on the deployed site, fresh browser (navigation start to the Run button enabled: fonts, CodeMirror, the module, the worker, the VM) | 0.43–1.45 s (headless Chromium, two runs, 2026-09-12) |
| the same from a local server | about 0.37 s |
| instantiate the module and create the VM with mrblib | 15 ms (Node) |
| a fixture run | 1–70 ms (Node; `test/fixtures.mjs` prints each) |

The status line shows the time from opening the page to ready on each first visit.

## Browsers

Needs WebAssembly with **exception handling** (legacy encoding; the compiler's `setjmp`/`longjmp`
use it) and module workers: Chrome/Edge 95+, Firefox 114+, Safari 15.2+. Tested in CI with
headless Chromium only.

## How it is built

```
wasm/        crate sabiruby-wasm (cdylib, wasm32-wasip1): the C ABI below, over sabiruby + sabiruby-compiler
web/         the static site: index.html, main.js (UI), debug.js (the debugger's panes), worker.js (runs the VM), sabi.js (wrapper of the C ABI)
  opcodes.json  the opcode reference shown on hover (from the mruby porting kit's dataset)
  vendor/    browser_wasi_shim (WASI imports in the browser), CodeMirror 6 (one esbuild bundle)
  samples/   fixtures (with .out) and the book's examples; index.json
tools/       build.sh (wasm), samples.sh (copies the samples), opcodes.sh (web/opcodes.json), samples/ (this repository's own samples), codemirror/ (rebuilds the bundle)
test/        fixtures.mjs, api.mjs (Node), browser.mjs (Playwright + Chromium)
```

The module is a WASI reactor with a C ABI (no wasm-bindgen): `sabi_compile`, `sabi_load`,
`sabi_reset`, `sabi_start`, `sabi_step(budget)`, `sabi_take_output`, `sabi_take_text`,
`sabi_dump`, `sabi_ast`, `sabi_highlight`/`sabi_take_highlight` (one category byte per source
byte, for an editor elsewhere to colour with), `sabi_stats`, `sabi_alloc`/`sabi_free`,
`sabi_version`, and for the debugger `sabi_trace`, `sabi_step_until`, `sabi_state`,
`sabi_take_trace`, `sabi_gc_collect`, `sabi_gc_stress`, `sabi_op_counts`, `sabi_dump_json`.
It imports only
`wasi_snapshot_preview1` functions for stdio and the environment (the VM needs no clock and no
randomness); in the browser they come from browser_wasi_shim. The page compiles the module
once and hands the `WebAssembly.Module` to each new worker. Design notes:
[`docs/playground.md`](https://github.com/sabiruby/sabiruby/blob/main/docs/playground.md) in the
SabiRuby repository.

### Building locally

The `sabiruby` repository must be checked out next to this one (`../sabiruby`); `wasm/` depends
on it by path (CI does the same checkout, at the commit in `.github/workflows/pages.yml`).

```
rustup target add wasm32-wasip1
# wasi-sdk 34 (https://github.com/WebAssembly/wasi-sdk/releases), e.g. unpacked to /opt/wasi-sdk
# binaryen (wasm-opt) on PATH, optional
WASI_SDK_PATH=/opt/wasi-sdk tools/build.sh
python3 -m http.server -d web 8000         # then open http://localhost:8000/
npm ci && npm test                         # Node: all fixtures + API checks
npx playwright-core install chromium && npm run test:browser
```

## Pinned versions

| what | version |
|---|---|
| SabiRuby | commit `8d0fea2` of sabiruby/sabiruby (unreleased main past `sabiruby` 0.5.2 — it has `Vm::next_line`, which the stepper needs — + `sabiruby-compiler` 0.2.3 with the features `ast` and `host`), the `SABIRUBY_REF` of `.github/workflows/pages.yml` |
| mruby compiler | 4.1.0-rc (`3cf73ee`), Prism 1.9.0 |
| wasi-sdk | 34.0 (clang 23) |
| binaryen (`wasm-opt`) | version_132 |
| Rust | stable, target `wasm32-wasip1` |
| browser_wasi_shim | 0.4.2 (`web/vendor/browser_wasi_shim/VERSION`) |
| CodeMirror | codemirror 6.0.2, @codemirror/view 6.43.11, state 6.7.4, language 6.12.4, legacy-modes 6.5.4 (full list: `web/vendor/codemirror/VERSION`) |
| Playwright (tests) | playwright-core 1.63.0 |

## License

MIT. Vendored: browser_wasi_shim (MIT OR Apache-2.0), CodeMirror (MIT); the samples come from
SabiRuby (MIT) and the mruby porting kit (MIT); the opcode descriptions in `web/opcodes.json` are
the porting kit's `dataset/` (MIT); the embedded compiler and mrblib are mruby's (MIT) and
Prism's (MIT).
