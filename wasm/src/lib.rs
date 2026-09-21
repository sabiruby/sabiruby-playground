//! SabiRuby for the browser: the VM (crate `sabiruby`) and the reference mruby compiler
//! (crate `sabiruby-compiler`) in one `wasm32-wasip1` module with a C ABI, driven by
//! `web/worker.js` (no wasm-bindgen). One VM per module instance; wasm is single-threaded.
//!
//! Strings go through `sabi_take_*`: the returned pointer is valid until the next call that
//! returns one, so the caller copies it at once. Status codes: 0 ok, 1 compile error,
//! 2 runtime error, 3 internal error; the message of the last failure is `sabi_take_text`.

use std::cell::RefCell;

mod json;

use sabiruby::{Step, Vm};

const OK: u32 = 0;
const COMPILE_ERROR: u32 = 1;
const RUNTIME_ERROR: u32 = 2;
const INTERNAL_ERROR: u32 = 3;

/// File name the compiler reports in diagnostics and records in the debug info.
const FILENAME: &str = "playground.rb";

#[derive(Default)]
struct State {
    vm: Option<Vm>,
    /// The RITE binary compiled or loaded last.
    bin: Option<Vec<u8>>,
    /// Category byte per source byte from the last `sabi_highlight`.
    hl: Vec<u8>,
    /// Message of the last failure (diagnostics or the exception).
    text: Vec<u8>,
    /// Buffer behind the pointer the last `sabi_take_*` / `sabi_dump` returned.
    ret: Vec<u8>,
    /// What `Vm::load` added to the binary's irep indices (mrblib and the gems come first),
    /// so that a frame's irep can be found in the listing.
    offset: usize,
    version: Vec<u8>,
    /// Kept across `sabi_reset`, which builds a new VM.
    trace: bool,
    stress: bool,
    /// Stop only where the listing can show it: mrblib and the gems are stepped through without
    /// stopping (their ireps were loaded before the program, so they are below `offset`).
    program_only: bool,
    /// In real time (`sabi_start_as_task`): the task the program itself runs as, so that the
    /// scheduler's own clock — driven by the host, from the wall clock — carries its `sleep`.
    program_task: Option<sabiruby::value::ObjId>,
}

thread_local! {
    static ST: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    ST.with(|s| f(&mut s.borrow_mut()))
}

/// Hands `bytes` to JS: pointer returned, length written to `len_out`.
fn give(st: &mut State, bytes: Vec<u8>, len_out: *mut u32) -> *const u8 {
    st.ret = bytes;
    if !len_out.is_null() {
        // SAFETY: JS passes a pointer into this module's memory (from sabi_alloc) or null.
        unsafe { *len_out = st.ret.len() as u32 };
    }
    st.ret.as_ptr()
}

/// The time of day, for `Time.now` and for what `sleep` answers. WASI's realtime clock is the
/// browser's `Date.now()` through the shim (`web/vendor/browser_wasi_shim`).
fn wall_clock() -> (i64, i64) {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_nanos() as i64),
        Err(_) => (0, 0),
    }
}

/// A fresh VM with mrblib loaded (the state `sabiruby` starts a program in).
fn new_vm(st: &mut State) -> u32 {
    let (trace, stress) = (st.trace, st.stress);
    match Vm::with_mrblib() {
        Ok(mut vm) => {
            vm.set_trace(trace);
            vm.set_gc_stress(stress);
            // the opcode histogram (`sabi_op_counts`): the VM stopped counting by default,
            // since the read-modify-write per instruction costs the instruction loop 3 to 7%
            vm.set_op_counting(true);
            // the same compiler the page compiles the program with, as the VM's host: this is
            // what `eval`, `instance_eval` and `Binding#eval` ask for a compile (there are no
            // files behind `require` in a browser, so that one still raises LoadError)
            vm.set_host(Box::new(sabiruby_compiler::Compiler::new()));
            vm.wall_clock = Some(wall_clock);
            st.program_task = None;
            st.vm = Some(vm);
            OK
        }
        Err(e) => { st.text = format!("could not initialise the VM: {e}").into_bytes(); INTERNAL_ERROR }
    }
}

/// `"SabiRuby 0.3.0 (1fe5f9d) / compiler: mruby 4.1.0-rc (...), Prism 1.9.0"`, NUL-terminated.
/// The VM and the commit it was built from, which is what a reader of the page wants; this
/// wrapper crate's own version says nothing about what is running.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_version() -> *const u8 {
    with(|st| {
        if st.version.is_empty() {
            let rev = &sabiruby::REVISION[..sabiruby::REVISION.len().min(7)];
            st.version = format!("SabiRuby {} ({rev}) / compiler: {}\0", sabiruby::VERSION, sabiruby_compiler::version()).into_bytes();
        }
        st.version.as_ptr()
    })
}

/// `len` bytes for JS to write into (source code, a .mrb file, out-parameters).
#[unsafe(no_mangle)]
pub extern "C" fn sabi_alloc(len: usize) -> *mut u8 {
    let mut b = vec![0u8; len.max(1)].into_boxed_slice();
    let p = b.as_mut_ptr();
    std::mem::forget(b);
    p
}

/// Releases a block from `sabi_alloc` (same `len`).
///
/// # Safety
/// `ptr` and `len` must come from one `sabi_alloc` call, released once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_free(ptr: *mut u8, len: usize) {
    // SAFETY: by the contract above this is the boxed slice sabi_alloc leaked.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len.max(1))) });
}

/// Compiles Ruby source (`debug` != 0: keep line numbers and local variable names, as
/// `mrbc -g`; the playground passes 1 so that `local_variables` works). On success the
/// binary is what `sabi_start` runs and `sabi_dump` lists.
///
/// # Safety
/// `src` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_compile(src: *const u8, len: usize, debug: u32) -> u32 {
    // SAFETY: by the contract above.
    let src = unsafe { std::slice::from_raw_parts(src, len) };
    let opts = sabiruby_compiler::Options { filename: FILENAME.into(), debug_info: debug != 0, ..Default::default() };
    let r = sabiruby_compiler::compile(src, &opts);
    with(|st| match r {
        Ok(bin) => { st.bin = Some(bin); OK }
        Err(e) => { st.bin = None; st.text = e.to_string().into_bytes(); COMPILE_ERROR }
    })
}

/// Takes a RITE binary (a `.mrb` file) instead of compiling.
///
/// # Safety
/// `bin` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_load(bin: *const u8, len: usize) -> u32 {
    // SAFETY: by the contract above.
    let bin = unsafe { std::slice::from_raw_parts(bin, len) }.to_vec();
    with(|st| match sabiruby::rite::parse(&bin) {
        Ok(_) => { st.bin = Some(bin); OK }
        Err(e) => { st.bin = None; st.text = format!("not a RITE binary: {e}").into_bytes(); COMPILE_ERROR }
    })
}

/// Replaces the VM with a fresh one (mrblib loaded). The compiled binary is kept.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_reset() -> u32 {
    with(new_vm)
}

/// Loads the compiled binary into the VM and prepares it for `sabi_step`.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_start() -> u32 {
    with(|st| {
        if st.vm.is_none() {
            let r = new_vm(st);
            if r != OK { return r; }
        }
        let Some(bin) = st.bin.clone() else { st.text = b"nothing compiled".to_vec(); return INTERNAL_ERROR };
        let root = sabiruby::rite::parse(&bin).map(|r| r.root).unwrap_or(0);
        let vm = st.vm.as_mut().unwrap();
        match vm.load(&bin) {
            Ok(irep) => { st.offset = irep - root; vm.start(irep); OK }
            Err(e) => { st.text = vm.describe_error(&e).into_bytes(); INTERNAL_ERROR }
        }
    })
}

/// Runs at most `budget` instructions: 0 paused (call again), 1 finished, 2 error (an
/// uncaught exception; the message is `sabi_take_text`), 3 no program started.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_step(budget: u32) -> u32 {
    with(|st| {
        let Some(vm) = st.vm.as_mut() else { st.text = b"no program started".to_vec(); return INTERNAL_ERROR };
        match vm.step(budget as u64) {
            Ok(Step::Paused) => 0,
            Ok(Step::Finished(_)) => 1,
            Err(e) => { st.text = vm.describe_error(&e).into_bytes(); RUNTIME_ERROR }
        }
    })
}

/// What `puts`/`p`/`print` wrote since the last call.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_take_output(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let out = st.vm.as_mut().map(|vm| vm.take_output()).unwrap_or_default();
        give(st, out, len_out)
    })
}

/// The message of the last failure: compile diagnostics (`FILE:LINE:COL: message`, as mrbc)
/// or the uncaught exception (`message (Class)`).
#[unsafe(no_mangle)]
pub extern "C" fn sabi_take_text(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let t = std::mem::take(&mut st.text);
        give(st, t, len_out)
    })
}

/// The compiled binary itself (a `.mrb` file's bytes), for a host that runs it in a VM of its
/// own — a game in the browser that has the VM but not the C compiler. Empty before a compile
/// has succeeded. The binary stays: `sabi_start` and `sabi_dump` still see it.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_take_binary(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let bin = st.bin.clone().unwrap_or_default();
        give(st, bin, len_out)
    })
}

/// The instruction listing of the compiled binary (`sabiruby dump`, in the style of
/// `mrbc --verbose`).
#[unsafe(no_mangle)]
pub extern "C" fn sabi_dump(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let text = match st.bin.as_deref().map(sabiruby::rite::parse) {
            Some(Ok(rite)) => sabiruby::vm::dump(&rite),
            Some(Err(e)) => format!("{e}"),
            None => String::new(),
        };
        give(st, text.into_bytes(), len_out)
    })
}

/// Prism's syntax tree of `src`, pretty-printed (the format of a debug `mrbc --verbose` and of
/// the book's listings): the tree the code generator walks. Parsed as `sabi_compile` parses.
///
/// # Safety
/// `src` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_ast(src: *const u8, len: usize, len_out: *mut u32) -> *const u8 {
    // SAFETY: by the contract above.
    let src = unsafe { std::slice::from_raw_parts(src, len) };
    let text = sabiruby_compiler::ast(src, FILENAME).unwrap_or_default();
    with(|st| give(st, text.into_bytes(), len_out))
}

/// Classifies `src` for an editor's colours, one category byte per source byte, and keeps the
/// map for `sabi_take_highlight` (`sabiruby_compiler::highlight`, i.e. Prism's own lexer and a
/// pass over its tree): 0 default, 1 keyword, 2 string, 3 comment, 4 number, 5 symbol,
/// 6 constant, 7 variable, 8 method name. For a host that colours Ruby it does not compile
/// here — the game in rubevy_games. Always 0: a source that does not parse still gets a map,
/// which is what an editor needs, and the map is as long as the source.
///
/// # Safety
/// `src` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_highlight(src: *const u8, len: usize) -> u32 {
    // SAFETY: by the contract above.
    let src = unsafe { std::slice::from_raw_parts(src, len) };
    let map = sabiruby_compiler::highlight(src);
    with(|st| { st.hl = map; OK })
}

/// The map the last `sabi_highlight` made. Empty before one has run. The map stays, as the
/// binary stays behind `sabi_take_binary`.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_take_highlight(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let hl = st.hl.clone();
        give(st, hl, len_out)
    })
}

/// Records what the interpreter does (environments, unwinding, fibers, collections) until the
/// next `sabi_take_trace`. Off by default; `sabi_reset` keeps the setting.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_trace(on: u32) {
    with(|st| { st.trace = on != 0; if let Some(vm) = st.vm.as_mut() { vm.set_trace(on != 0); } });
}

/// Stepping stops only in the program's own ireps when `on`: mrblib and the gems (`Integer#times`
/// and the like) run to their end instead of stopping inside them, where the listing has no row.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_step_program_only(on: u32) {
    with(|st| st.program_only = on != 0);
}

/// Runs until something happens, as a debugger's step buttons do: `mode` 0 one instruction,
/// 1 step over (the next line of this frame; calls run without stopping inside them), 2 step into
/// (the next line, or the moment a frame is entered or left), 3 step out (this frame returns),
/// 4 `budget` instructions (Continue). `budget` bounds every mode. Same result as `sabi_step`.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_step_until(mode: u32, budget: u32) -> u32 {
    with(|st| {
        let (offset, program_only) = (st.offset, st.program_only);
        let Some(vm) = st.vm.as_mut() else { st.text = b"no program started".to_vec(); return INTERNAL_ERROR };
        if mode == 4 {
            return match vm.step(budget as u64) {
                Ok(Step::Paused) => 0,
                Ok(Step::Finished(_)) => 1,
                Err(e) => { st.text = vm.describe_error(&e).into_bytes(); RUNTIME_ERROR }
            };
        }
        let (line0, depth0) = (vm.next_line(), vm.ci.len());
        for _ in 0..budget.max(1) {
            match vm.step(1) {
                Ok(Step::Paused) => {}
                Ok(Step::Finished(_)) => return 1,
                Err(e) => { st.text = vm.describe_error(&e).into_bytes(); return RUNTIME_ERROR }
            }
            let depth = vm.ci.len();
            let line = vm.next_line();
            let line_changed = line.is_some() && line != line0;
            let stop = match mode {
                0 => true,                                            // one instruction
                1 => depth < depth0 || (depth == depth0 && line_changed), // step over: deeper frames run on
                3 => depth < depth0,                                  // step out: until this frame returns
                _ => depth != depth0 || line_changed,                 // step into
            };
            // inside mrblib or a gem there is no row to highlight, so `program_only` runs on
            let showable = !program_only || vm.ci.last().is_none_or(|c| c.irep >= offset);
            if stop && showable { return 0; }
        }
        0
    })
}

/// The VM as it stands, as JSON (`Vm::snapshot`): contexts, frames, registers, environments,
/// heap. `regs_frames` is how many innermost frames of each context carry their registers.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_state(regs_frames: u32, len_out: *mut u32) -> *const u8 {
    with(|st| {
        let text = match st.vm.as_ref() {
            Some(vm) => json::snapshot(&vm.snapshot(regs_frames as usize)),
            None => "{}".into(),
        };
        give(st, text.into_bytes(), len_out)
    })
}

/// What was recorded since the last call, as a JSON array.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_take_trace(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let events = st.vm.as_mut().map(|vm| vm.take_trace()).unwrap_or_default();
        let text = json::trace(&events);
        give(st, text.into_bytes(), len_out)
    })
}

/// Collects now (`GC.start`).
#[unsafe(no_mangle)]
pub extern "C" fn sabi_gc_collect() -> u32 {
    with(|st| match st.vm.as_mut() { Some(vm) => { vm.gc_collect(); OK } None => INTERNAL_ERROR })
}

/// Collect after every allocation (`SABIRUBY_GC_STRESS`).
#[unsafe(no_mangle)]
pub extern "C" fn sabi_gc_stress(on: u32) {
    with(|st| { st.stress = on != 0; if let Some(vm) = st.vm.as_mut() { vm.set_gc_stress(on != 0); } });
}

/// `[{"op":"MOVE","count":n}, ..]` for the executed opcodes.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_op_counts(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let text = match st.vm.as_ref() { Some(vm) => json::op_counts(vm), None => "[]".into() };
        give(st, text.into_bytes(), len_out)
    })
}

/// The instruction listing as data (irep, pc, line, opcode, operands), for the bytecode pane.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_dump_json(len_out: *mut u32) -> *const u8 {
    with(|st| {
        let text = match st.bin.clone() {
            Some(bin) => json::dump(&bin, st.offset),
            None => "{}".into(),
        };
        give(st, text.into_bytes(), len_out)
    })
}

/// Instructions executed, objects alive and collections run, for the status line.
///
/// # Safety
/// Each pointer is null or points to 8 writable bytes (u64, little-endian).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sabi_stats(insns_out: *mut u64, live_out: *mut u64, gc_out: *mut u64) {
    with(|st| {
        let (i, l, g) = st.vm.as_ref().map(|vm| (vm.instructions, vm.heap.live_count() as u64, vm.gc_count)).unwrap_or((0, 0, 0));
        // SAFETY: by the contract above.
        unsafe {
            if !insns_out.is_null() { *insns_out = i; }
            if !live_out.is_null() { *live_out = l; }
            if !gc_out.is_null() { *gc_out = g; }
        }
    })
}

// ---- real time: the scheduler driven by the host's clock (docs/playground.md, "実時間")
//
// Without a host the tick is counted in instructions and the scheduler jumps the clock when
// every task is asleep, so `sleep 1` costs nothing and answers at once. The page can do better:
// the VM returns to JS between instructions, so the worker waits on the event loop (no thread to
// block, no SharedArrayBuffer) and moves the clock from the wall clock it can read.

/// Says the host moves mruby-task's clock itself (`sabi_task_advance_ticks`); the instruction
/// count then only ends timeslices, and an idle scheduler no longer jumps the clock.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_external_clock(on: u32) {
    with(|st| { if let Some(vm) = st.vm.as_mut() { vm.task_external_clock(on != 0); } });
}

/// Milliseconds one tick stands for (`MRB_TICK_UNIT`), which is what the host divides its
/// elapsed time by.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_tick_unit_ms() -> u32 {
    with(|st| st.vm.as_ref().map(|vm| vm.task_tick_unit_ms()).unwrap_or(4))
}

/// Moves the clock on by `n` ticks and wakes what was sleeping until then.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_advance_ticks(n: u32) {
    with(|st| { if let Some(vm) = st.vm.as_mut() { vm.task_advance_ticks(n); } });
}

/// One turn of the host loop: ready tasks, one timeslice each, until `budget` instructions are
/// spent or nothing is ready. Writes what it spent to `spent_out`. 0 ok, 2 the scheduler itself
/// raised (`sabi_take_text`) — a task's own exception is its result, not an error here.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_run(budget: u32, spent_out: *mut u32) -> u32 {
    with(|st| {
        let Some(vm) = st.vm.as_mut() else { st.text = b"no program started".to_vec(); return INTERNAL_ERROR };
        match vm.task_run_budget(budget as u64) {
            Ok(spent) => {
                // SAFETY: JS passes a pointer into this module's memory, or null.
                unsafe { if !spent_out.is_null() { *spent_out = spent as u32; } }
                OK
            }
            Err(e) => { st.text = vm.describe_error(&e).into_bytes(); RUNTIME_ERROR }
        }
    })
}

/// Milliseconds until the earliest sleeping task is due, or -1 where nothing is waiting on a
/// deadline: how long the host may wait before calling the scheduler again.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_next_wakeup_ms() -> i32 {
    with(|st| {
        let Some(vm) = st.vm.as_ref() else { return -1 };
        match vm.task_next_wakeup_ticks() {
            Some(t) => (t.saturating_mul(vm.task_tick_unit_ms())).min(i32::MAX as u32) as i32,
            None => -1,
        }
    })
}

/// Whether the scheduler still has something that can run: a ready task, or one sleeping until a
/// deadline. 0 means the host loop is done.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_pending() -> u32 {
    with(|st| u32::from(st.vm.as_ref().map(|vm| vm.task_pending()).unwrap_or(false)))
}

/// Loads the compiled binary and makes the program itself a task, instead of running it on the
/// root context (`sabi_start`). Its `sleep` is then the scheduler's, which the host's clock
/// drives — which is what makes a plain `sleep 1` at the top level wait a second. `Task.current`
/// answers that task rather than the "main" wrapper, which is the visible difference.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_start_as_task() -> u32 {
    with(|st| {
        if st.vm.is_none() {
            let r = new_vm(st);
            if r != OK { return r; }
        }
        let Some(bin) = st.bin.clone() else { st.text = b"nothing compiled".to_vec(); return INTERNAL_ERROR };
        let root = sabiruby::rite::parse(&bin).map(|r| r.root).unwrap_or(0);
        let vm = st.vm.as_mut().unwrap();
        let irep = match vm.load(&bin) {
            Ok(i) => i,
            Err(e) => { st.text = vm.describe_error(&e).into_bytes(); return INTERNAL_ERROR }
        };
        st.offset = irep - root;
        match vm.task_spawn(irep, 128, Some("main")) {
            Ok(task) => { vm.gc_register(task); st.program_task = Some(task); OK }
            Err(e) => { st.text = vm.describe_error(&e).into_bytes(); INTERNAL_ERROR }
        }
    })
}

/// How the program's own task stands: 0 still running, 1 finished, 2 ended with an exception it
/// did not handle (the message is `sabi_take_text`, in the form `sabi_step` reports), 3 no task.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_task_program_state() -> u32 {
    with(|st| {
        let Some(task) = st.program_task else { return INTERNAL_ERROR };
        let Some(vm) = st.vm.as_mut() else { return INTERNAL_ERROR };
        if !vm.task_finished(task) { return 0; }
        let value = vm.task_value(task);
        if value.obj().map(|o| matches!(vm.heap.get(o).kind, sabiruby::object::ObjKind::Exception)).unwrap_or(false) {
            st.text = {
                let vm = st.vm.as_mut().unwrap();
                vm.describe_error(&sabiruby::VmError::Raise(value)).into_bytes()
            };
            return RUNTIME_ERROR;
        }
        1
    })
}
