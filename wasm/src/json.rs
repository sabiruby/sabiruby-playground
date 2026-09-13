//! A small JSON writer and the serialisers for what the page reads: the VM snapshot, the trace,
//! the structured instruction listing and the opcode counts. Hand-written on purpose: serde
//! would be the only reason to pull dependencies into the wasm module (see `docs/playground.md`,
//! the size table).

use sabiruby::inspect::{CatchHandlerInfo, DetachReason, SwitchKind, Snapshot, TraceEvent, UnwindBy, ValueView};
use sabiruby::Vm;

/// Builds JSON; the commas and the string escaping are its business.
pub struct Json {
    buf: String,
    /// True while the current object or array is still empty.
    first: Vec<bool>,
}

impl Json {
    pub fn new() -> Json {
        Json { buf: String::new(), first: vec![true] }
    }
    pub fn finish(self) -> String { self.buf }

    fn comma(&mut self) {
        match self.first.last_mut() {
            Some(f) if *f => *f = false,
            _ => self.buf.push(','),
        }
    }
    pub fn obj(&mut self, f: impl FnOnce(&mut Json)) {
        self.comma();
        self.buf.push('{');
        self.first.push(true);
        f(self);
        self.first.pop();
        self.buf.push('}');
    }
    pub fn arr(&mut self, f: impl FnOnce(&mut Json)) {
        self.comma();
        self.buf.push('[');
        self.first.push(true);
        f(self);
        self.first.pop();
        self.buf.push(']');
    }
    /// A key; the next value written belongs to it.
    fn key(&mut self, k: &str) {
        self.comma();
        self.put_string(k); // not `string`: the separator above is the only one this member gets
        self.buf.push(':');
        self.first.push(true); // the value is written without a comma of its own
    }
    fn end_key(&mut self) { self.first.pop(); }

    pub fn kv_str(&mut self, k: &str, v: &str) { self.key(k); self.string(v); self.end_key(); }
    pub fn kv_usize(&mut self, k: &str, v: usize) { self.key(k); self.usize_(v); self.end_key(); }
    pub fn kv_u64(&mut self, k: &str, v: u64) { self.key(k); self.usize_(v as usize); self.end_key(); }
    pub fn kv_bool(&mut self, k: &str, v: bool) { self.key(k); self.comma(); self.buf.push_str(if v { "true" } else { "false" }); self.end_key(); }
    pub fn kv_null(&mut self, k: &str) { self.key(k); self.comma(); self.buf.push_str("null"); self.end_key(); }
    pub fn kv_opt_str(&mut self, k: &str, v: Option<&str>) {
        match v { Some(s) => self.kv_str(k, s), None => self.kv_null(k) }
    }
    pub fn kv_opt_usize(&mut self, k: &str, v: Option<usize>) {
        match v { Some(n) => self.kv_usize(k, n), None => self.kv_null(k) }
    }
    pub fn kv_obj(&mut self, k: &str, f: impl FnOnce(&mut Json)) { self.key(k); self.obj(f); self.end_key(); }
    pub fn kv_arr(&mut self, k: &str, f: impl FnOnce(&mut Json)) { self.key(k); self.arr(f); self.end_key(); }

    pub fn string(&mut self, s: &str) {
        self.comma();
        self.put_string(s);
    }
    /// The quoted, escaped text on its own, without a separator.
    fn put_string(&mut self, s: &str) {
        self.buf.push('"');
        for c in s.chars() {
            match c {
                '"' => self.buf.push_str("\\\""),
                '\\' => self.buf.push_str("\\\\"),
                '\n' => self.buf.push_str("\\n"),
                '\r' => self.buf.push_str("\\r"),
                '\t' => self.buf.push_str("\\t"),
                c if (c as u32) < 0x20 => self.buf.push_str(&format!("\\u{:04x}", c as u32)),
                c => self.buf.push(c),
            }
        }
        self.buf.push('"');
    }
    pub fn usize_(&mut self, v: usize) {
        self.comma();
        self.buf.push_str(&v.to_string());
    }
}

fn value(j: &mut Json, v: &ValueView) {
    j.obj(|j| {
        j.kv_str("text", &v.text);
        j.kv_str("class", &v.class);
        j.kv_opt_usize("id", v.id.map(|i| i.0 as usize));
    });
}

/// `Vm::snapshot` as JSON; the keys are the field names of `sabiruby::inspect`.
pub fn snapshot(s: &Snapshot) -> String {
    let mut j = Json::new();
    j.obj(|j| {
        j.kv_usize("cur", s.cur);
        j.kv_u64("instructions", s.instructions);
        match &s.pending_exc {
            Some(v) => j.kv_obj("pending_exc", |j| {
                j.kv_str("text", &v.text);
                j.kv_str("class", &v.class);
                j.kv_opt_usize("id", v.id.map(|i| i.0 as usize));
            }),
            None => j.kv_null("pending_exc"),
        }
        j.kv_obj("heap", |j| {
            j.kv_usize("len", s.heap.len);
            j.kv_usize("live", s.heap.live);
            j.kv_usize("free", s.heap.free);
            j.kv_usize("allocated_since_gc", s.heap.allocated_since_gc);
            j.kv_usize("alloc_threshold", s.heap.alloc_threshold);
            j.kv_u64("gc_count", s.heap.gc_count);
            j.kv_usize("live_after_gc", s.heap.live_after_gc);
            j.kv_bool("stress", s.heap.stress);
            j.kv_bool("disabled", s.heap.disabled);
        });
        j.kv_arr("contexts", |j| {
            for c in &s.contexts {
                j.obj(|j| {
                    j.kv_usize("index", c.index);
                    j.kv_str("status", &format!("{:?}", c.status));
                    j.kv_opt_usize("fiber", c.fiber.map(|f| f.0 as usize));
                    j.kv_bool("is_current", c.is_current);
                    j.kv_opt_usize("prev", c.prev);
                    j.kv_arr("frames", |j| {
                        for f in &c.frames {
                            j.obj(|j| {
                                j.kv_usize("index", f.index);
                                j.kv_usize("irep", f.irep);
                                j.kv_usize("pc", f.pc);
                                j.kv_opt_usize("line", f.line.map(|l| l as usize));
                                j.kv_opt_str("mid", f.mid.as_deref());
                                j.kv_str("target_class", &f.target_class);
                                j.kv_usize("base", f.base);
                                j.kv_usize("nregs", f.nregs);
                                j.kv_usize("nlocals", f.nlocals);
                                j.kv_bool("native_boundary", f.native_boundary);
                                j.kv_opt_usize("env", f.env.map(|e| e.0 as usize));
                                j.kv_obj("proc", |j| {
                                    j.kv_usize("id", f.proc_.id.0 as usize);
                                    j.kv_usize("irep", f.proc_.irep);
                                    j.kv_opt_usize("upper", f.proc_.upper.map(|u| u.0 as usize));
                                    j.kv_opt_usize("env", f.proc_.env.map(|e| e.0 as usize));
                                });
                                j.kv_arr("regs", |j| {
                                    for r in &f.regs {
                                        j.obj(|j| {
                                            j.kv_usize("index", r.index);
                                            j.kv_opt_str("name", r.name.as_deref());
                                            j.kv_str("text", &r.value.text);
                                            j.kv_str("class", &r.value.class);
                                            j.kv_opt_usize("id", r.value.id.map(|i| i.0 as usize));
                                        });
                                    }
                                });
                            });
                        }
                    });
                });
            }
        });
        j.kv_arr("envs", |j| {
            for e in &s.envs {
                j.obj(|j| {
                    j.kv_usize("id", e.id.0 as usize);
                    j.kv_bool("attached", e.attached);
                    j.kv_usize("len", e.len);
                    j.kv_usize("ctx", e.ctx);
                    j.kv_usize("base", e.base);
                    j.kv_opt_str("mid", e.mid.as_deref());
                    j.kv_arr("values", |j| { for v in &e.values { value(j, v); } });
                });
            }
        });
    });
    j.finish()
}

/// The trace as a JSON array; every event has a `kind`.
pub fn trace(events: &[TraceEvent]) -> String {
    let mut j = Json::new();
    j.arr(|j| {
        for e in events {
            j.obj(|j| match e {
                TraceEvent::EnvCreate { env, ctx, frame, base, len, mid: _ } => {
                    j.kv_str("kind", "env_create");
                    j.kv_usize("env", env.0 as usize);
                    j.kv_usize("ctx", *ctx);
                    j.kv_usize("frame", *frame);
                    j.kv_usize("base", *base);
                    j.kv_usize("len", *len);
                }
                TraceEvent::EnvDetach { env, len, reason } => {
                    j.kv_str("kind", "env_detach");
                    j.kv_usize("env", env.0 as usize);
                    j.kv_usize("len", *len);
                    j.kv_str("reason", match reason { DetachReason::FrameReturn => "frame_return", DetachReason::ContextSwept => "context_swept" });
                }
                TraceEvent::Raise { exc, class, frame, irep, pc, line } => {
                    j.kv_str("kind", "raise");
                    j.kv_opt_usize("exc", exc.map(|e| e.0 as usize));
                    j.kv_str("class", class);
                    j.kv_usize("frame", *frame);
                    j.kv_usize("irep", *irep);
                    j.kv_usize("pc", *pc);
                    j.kv_opt_usize("line", line.map(|l| l as usize));
                }
                TraceEvent::CatchLook { frame, irep, pc, line, matched } => {
                    j.kv_str("kind", "catch_look");
                    j.kv_usize("frame", *frame);
                    j.kv_usize("irep", *irep);
                    j.kv_usize("pc", *pc);
                    j.kv_opt_usize("line", line.map(|l| l as usize));
                    match matched {
                        Some(CatchHandlerInfo { ensure, begin, end, target }) => j.kv_obj("matched", |j| {
                            j.kv_str("type", if *ensure { "ensure" } else { "rescue" });
                            j.kv_usize("begin", *begin as usize);
                            j.kv_usize("end", *end as usize);
                            j.kv_usize("target", *target as usize);
                        }),
                        None => j.kv_null("matched"),
                    }
                }
                TraceEvent::FrameUnwound { frame, mid: _, by } => {
                    j.kv_str("kind", "frame_unwound");
                    j.kv_usize("frame", *frame);
                    j.kv_str("by", match by { UnwindBy::Raise => "raise", UnwindBy::Break => "break", UnwindBy::Return => "return" });
                }
                TraceEvent::FiberSwitch { from, to, kind } => {
                    j.kv_str("kind", "fiber_switch");
                    j.kv_usize("from", *from);
                    j.kv_usize("to", *to);
                    j.kv_str("switch", match kind {
                        SwitchKind::Resume => "resume", SwitchKind::Yield => "yield", SwitchKind::Transfer => "transfer",
                        SwitchKind::Terminate => "terminate", SwitchKind::Reset => "reset" });
                }
                TraceEvent::GcCollect { before_live, after_live, swept, allocated_since } => {
                    j.kv_str("kind", "gc_collect");
                    j.kv_usize("before_live", *before_live);
                    j.kv_usize("after_live", *after_live);
                    j.kv_usize("swept", *swept);
                    j.kv_usize("allocated_since", *allocated_since);
                }
            });
        }
    });
    j.finish()
}

/// The instruction listing as data: the same lines `sabiruby dump` prints, but per irep and per
/// instruction, so the page can highlight `(irep, pc)` and show an opcode's description.
/// `offset` is what `Vm::load` added to the binary's irep indices.
pub fn dump(bin: &[u8], offset: usize) -> String {
    let mut j = Json::new();
    let rite = match sabiruby::rite::parse(bin) {
        Ok(r) => r,
        Err(e) => {
            j.obj(|j| { j.kv_str("error", &format!("{e}")); });
            return j.finish();
        }
    };
    j.obj(|j| {
        j.kv_usize("offset", offset);
        j.kv_usize("root", rite.root);
        j.kv_arr("ireps", |j| {
            for (i, ir) in rite.ireps.iter().enumerate() {
                j.obj(|j| {
                    j.kv_usize("index", i);
                    j.kv_usize("nregs", ir.nregs as usize);
                    j.kv_usize("nlocals", ir.nlocals as usize);
                    j.kv_opt_str("filename", ir.filename.as_ref().map(|f| core::str::from_utf8(f).unwrap_or("?")));
                    j.kv_arr("lv", |j| {
                        for n in &ir.lv {
                            match n { Some(b) => j.string(core::str::from_utf8(b).unwrap_or("?")), None => { j.usize_(0); } }
                        }
                    });
                    j.kv_arr("catch", |j| {
                        for h in &ir.catch {
                            j.obj(|j| {
                                j.kv_str("type", if h.kind == sabiruby::rite::CatchType::Ensure { "ensure" } else { "rescue" });
                                j.kv_usize("begin", h.begin as usize);
                                j.kv_usize("end", h.end as usize);
                                j.kv_usize("target", h.target as usize);
                            });
                        }
                    });
                    j.kv_arr("insns", |j| {
                        let mut pc = 0usize;
                        while pc < ir.iseq.len() {
                            match ir.decode(pc) {
                                Some((op, a, b, c, next)) => {
                                    j.obj(|j| {
                                        j.kv_usize("pc", pc);
                                        j.kv_opt_usize("line", ir.line_of(pc).map(|l| l as usize));
                                        j.kv_str("op", op.name());
                                        j.kv_usize("a", a as usize);
                                        j.kv_usize("b", b as usize);
                                        j.kv_usize("c", c as usize);
                                        j.kv_str("text", &operands_text(ir, op, a, b, c));
                                    });
                                    pc = next;
                                }
                                None => {
                                    j.obj(|j| {
                                        j.kv_usize("pc", pc);
                                        j.kv_null("line");
                                        j.kv_str("op", "???");
                                        j.kv_usize("a", 0);
                                        j.kv_usize("b", 0);
                                        j.kv_usize("c", 0);
                                        j.kv_str("text", "");
                                    });
                                    pc += 1;
                                }
                            }
                        }
                    });
                });
            }
        });
    });
    j.finish()
}

/// The operand columns and the comment of one instruction, as in the text listing.
fn operands_text(ir: &sabiruby::rite::Irep, op: sabiruby::opcode::Op, a: u32, b: u32, c: u32) -> String {
    use sabiruby::opcode::{Op, Operands};
    let mut s = match op.operands() {
        Operands::Z => String::new(),
        Operands::B | Operands::S | Operands::W => format!("{a}"),
        Operands::BB | Operands::BS => format!("{a}\t{b}"),
        Operands::BBB | Operands::BSS => format!("{a}\t{b}\t{c}"),
    };
    match op {
        Op::Loadsym | Op::Getgv | Op::Setgv | Op::Getiv | Op::Setiv | Op::Getcv | Op::Setcv | Op::Getconst | Op::Setconst
        | Op::Getmcnst | Op::Setmcnst | Op::Send | Op::Sendb | Op::Send0 | Op::Ssend | Op::Ssendb | Op::Ssend0
        | Op::Def | Op::Tdef | Op::Sdef | Op::Class | Op::Module => {
            if let Some(Some(sym)) = ir.syms.get(b as usize) {
                s.push_str(&format!("\t; :{}", core::str::from_utf8(sym).unwrap_or("?")));
            }
        }
        Op::String | Op::Loadl | Op::Symbol => {
            if let Some(p) = ir.pool.get(b as usize) {
                s.push_str(&format!("\t; {}", pool_text(p)));
            }
        }
        _ => {}
    }
    s
}

fn pool_text(p: &sabiruby::rite::Pool) -> String {
    use sabiruby::rite::Pool;
    match p {
        Pool::Str(b) => format!("{:?}", core::str::from_utf8(b).unwrap_or("?")),
        Pool::Int(i) => format!("{i}"),
        Pool::Float(f) => format!("{f}"),
        Pool::BigInt { .. } => "bigint".into(),
    }
}

/// `[{"op":"MOVE","count":n}, ..]` for the instruction histogram.
pub fn op_counts(vm: &Vm) -> String {
    let mut j = Json::new();
    j.arr(|j| {
        for (op, n) in vm.op_histogram() {
            j.obj(|j| { j.kv_str("op", op); j.kv_u64("count", n); });
        }
    });
    j.finish()
}
