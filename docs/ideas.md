# What the playground can show because the VM is SabiRuby

Notes from 2026-09-12 (author: "as it stands it is not much different from running
mruby's wasm; is there a way of showing it that only SabiRuby makes possible?").

**1–6 are implemented (2026-09-12)**, from [`plans/visualizer-plan.md`](plans/visualizer-plan.md): the
"デバッグ" button steps the VM by instruction, by line or by call/return, and the "VM の状態"
pane has the six tabs below. The VM side is `sabiruby`'s `src/inspect.rs` and the DBG reader in
`src/rite.rs` (`docs/inspect.md` there); this side is `wasm/src/json.rs`, `web/debug.js` and the
new worker messages. What was done differently from the plan is listed in `docs/playground.md`
of the SabiRuby repository, "Departures from the plan". 7 and 8 are not implemented.

The reference `mruby` on wasm can run code and print. What it cannot do without patching
`vm.c` is expose its state at an instruction boundary: `mrb_value` is boxed, calls use the
C stack, exceptions are `longjmp`, and there is no API to read registers or callinfo. In
SabiRuby every piece of VM state is plain data (`Value` enum, `Vec<Slot>` registers,
`Vec<CallInfo>`, `Context` per fiber, heap objects, catch tables) and `Vm::step(budget)`
already stops at any instruction. So the unique thing is a **VM visualizer that shows what
the book explains**, not a faster or smaller Ruby.

## 1. Step debugger (first; the others build on it)

**実装済み** (2026-09-12): `sabi_step_until(mode, budget)`, `sabi_state`, the highlight in the listing and the current line in the editor.

* `sabi_step(1)` per click, or run to the next source line / next `SEND` / next return.
* New C ABI `sabi_state()` → JSON: current context, callinfo stack (method name, target
  class, pc, base), the registers of the top frame with local-variable names from `lv`
  (`R2:a = 11`), the block slot, `self`, and the pending exception if any.
* The bytecode pane highlights the instruction at `pc`; the code pane highlights the line
  (debug info is compiled in already, `-g`).
* Register values are rendered with `inspect` semantics done on the Rust side (no Ruby
  call, so it cannot disturb the program).

## 2. Environments and closures (book: vm.re "環境とクロージャ")

**実装済み**: the 環境 tab, from `EnvCreate`/`EnvDetach` and the snapshot's `envs`. The `upper` walk is a hint shown on `GETUPVAR`/`SETUPVAR`, not an animation.

* When a `BLOCK`/`LAMBDA` runs, show the `REnv` created on the frame (attached: points at
  the registers); when the frame returns, show it detaching (values copied to the heap).
  `GETUPVAR`/`SETUPVAR` animate the `upper` walk and the register they reach.

## 3. Exceptions without longjmp (book: vm.re "大域脱出の二つの流儀")

**実装済み**: the 例外 tab, from `Raise`/`CatchLook`/`FrameUnwound` (break and return too).

* On `raise`, show the walk: for each frame the catch table entries and which one matched
  (`begin < pc <= end`), the ensure handlers run, the frames popped. `break` from a block
  and `return` from a proc the same way (`RBreak` equivalent).

## 4. Fibers (book: vm.re Fiber)

**実装済み**: the Fiber tab, one card per context, moved by `FiberSwitch`.

* One column per `Context`: its stack and callinfo, its state (Created/Running/…);
  `resume`/`yield`/`transfer` move the highlight between columns. The host boundary rule
  (`FiberError` across a native) becomes visible.

## 5. GC (book: gc.re, docs/gc.md)

**実装済み**: the GC tab: the heap counters, collect now, stress, and the history of collections. The roots are described in words, not listed.

* Heap pane: object count, free-list length, last collection's marked/swept counts;
  a "collect now" button and the stress-mode toggle; roots listed (registers, globals,
  constants, the arena of natives). Shows an object turning unreachable and being swept.

## 6. Opcode reference at hand (book + porting kit)

**実装済み**: hover an opcode in the listing or in the histogram (`web/opcodes.json`, `tools/opcodes.sh`).

* Hover or click an opcode in the bytecode pane → its record from the kit's
  `dataset/opcodes.jsonl` (definition, operand format, summary, VM excerpt); a link to
  the book's article. The playground becomes the interactive index of the reference.
* `sabi_stats` already counts instructions: a per-opcode histogram for the run.

## 7. Same bytecode as the reference, checked

* The compiler is the reference compiler, so the bytecode pane is byte-identical to
  `mrbc`; say so, and for the kit's samples show "output matches the reference `mruby`"
  from the kit's `.out` files (and the recorded deviations where it does not).

## 8. Later

* Time travel: snapshot the VM every N instructions (all state is data; `Vm` would need
  `Clone`) and scrub backwards.
* Redefine a method while paused (needs eval / the compiler hook in the VM;
  `docs/eval-require-plan.md` in sabiruby).
* Two engines side by side: SabiRuby and the reference `mruby` wasm running the same
  program, outputs diffed live (a mruby wasm build is not in this repo).

## Cost

1 is a `sabi_state` export (Rust, ~200 lines: walk `ci`, `stack`, `ireps[].lv`, render
values) plus two panes and the highlight in JS. 2–5 are the same JSON with more fields
(env objects, catch tables, contexts, gc counters) and UI on top, each a day or so.
6 needs the kit's dataset copied in (MIT) and a lookup by opcode name.
