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

/// A fresh VM with mrblib loaded (the state `sabiruby` starts a program in).
fn new_vm(st: &mut State) -> u32 {
    let (trace, stress) = (st.trace, st.stress);
    match Vm::with_mrblib() {
        Ok(mut vm) => { vm.set_trace(trace); vm.set_gc_stress(stress); st.vm = Some(vm); OK }
        Err(e) => { st.text = format!("could not initialise the VM: {e}").into_bytes(); INTERNAL_ERROR }
    }
}

/// `"sabiruby-wasm 0.1.0 / compiler: mruby 4.1.0-rc (...), Prism 1.9.0"`, NUL-terminated.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_version() -> *const u8 {
    with(|st| {
        if st.version.is_empty() {
            st.version = format!("sabiruby-wasm {} / compiler: {}\0", env!("CARGO_PKG_VERSION"), sabiruby_compiler::version()).into_bytes();
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

/// Records what the interpreter does (environments, unwinding, fibers, collections) until the
/// next `sabi_take_trace`. Off by default; `sabi_reset` keeps the setting.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_trace(on: u32) {
    with(|st| { st.trace = on != 0; if let Some(vm) = st.vm.as_mut() { vm.set_trace(on != 0); } });
}

/// Runs until something happens, as a debugger's step buttons do: `mode` 0 one instruction,
/// 1 step over (the next line of this frame; calls run without stopping inside them), 2 step into
/// (the next line, or the moment a frame is entered or left), 3 step out (this frame returns),
/// 4 `budget` instructions (Continue). `budget` bounds every mode. Same result as `sabi_step`.
#[unsafe(no_mangle)]
pub extern "C" fn sabi_step_until(mode: u32, budget: u32) -> u32 {
    with(|st| {
        let Some(vm) = st.vm.as_mut() else { st.text = b"no program started".to_vec(); return INTERNAL_ERROR };
        if mode == 4 {
            return match vm.step(budget as u64) {
                Ok(Step::Paused) => 0,
                Ok(Step::Finished(_)) => 1,
                Err(e) => { st.text = vm.describe_error(&e).into_bytes(); RUNTIME_ERROR }
            };
        }
        let (line0, depth0) = (vm.current_line(), vm.ci.len());
        for _ in 0..budget.max(1) {
            match vm.step(1) {
                Ok(Step::Paused) => {}
                Ok(Step::Finished(_)) => return 1,
                Err(e) => { st.text = vm.describe_error(&e).into_bytes(); return RUNTIME_ERROR }
            }
            let depth = vm.ci.len();
            let line = vm.current_line();
            let line_changed = line.is_some() && line != line0;
            let stop = match mode {
                0 => true,                                            // one instruction
                1 => depth < depth0 || (depth == depth0 && line_changed), // step over: deeper frames run on
                3 => depth < depth0,                                  // step out: until this frame returns
                _ => depth != depth0 || line_changed,                 // step into
            };
            if stop { return 0; }
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
