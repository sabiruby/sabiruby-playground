// The debugger's views: the structured bytecode listing, the "VM の状態" tabs and the opcode
// tooltip. Everything here draws from the JSON the VM hands out (wasm/src/json.rs): `state`
// (Vm::snapshot), `trace` (Vm::take_trace), `dump` (the instruction listing) and `opCounts`.
// main.js owns the worker and the editor; this file only turns those objects into DOM.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const pad3 = (n) => String(n).padStart(3, "0");
const num = (n) => (n === null || n === undefined ? "—" : n.toLocaleString());

// ---------------------------------------------------------------- bytecode listing

/** Rebuilds `#dump` from `dumpJson()`. The text stays what `sabiruby dump` prints; the rows are
 *  elements so the current instruction can be highlighted and an opcode can be looked up. */
export function renderDump(root, dump) {
  root.textContent = "";
  if (!dump || dump.error) {
    root.textContent = dump ? dump.error : "";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ir of dump.ireps) {
    frag.append(el("span", "irep-head", `irep ${ir.index} nregs=${ir.nregs} nlocals=${ir.nlocals}\n`));
    const names = (ir.lv || []).map((n, i) => (n && n !== 0 ? `R${i + 1}=${n}` : null)).filter(Boolean);
    if (names.length) frag.append(el("span", "irep-note", `  locals: ${names.join(" ")}\n`));
    for (const c of ir.catch || []) {
      frag.append(el("span", "irep-note", `  catch ${c.type} ${pad3(c.begin)}..${pad3(c.end)} -> ${pad3(c.target)}\n`));
    }
    for (const ins of ir.insns) {
      const row = el("span", "insn");
      row.dataset.irep = String(ir.index);
      row.dataset.pc = String(ins.pc);
      row.append(el("span", "ln", `${ins.line === null ? "     " : String(ins.line).padStart(5)} ${pad3(ins.pc)} `));
      const op = el("span", "op", ins.op);
      op.dataset.op = ins.op;
      row.append(op);
      row.append(el("span", "args", `${ins.text ? "\t" + ins.text : ""}\n`));
      frag.append(row);
    }
  }
  root.append(frag);
}

/** Marks where the VM stands: `.current` on the running instruction, `.caller` on the frames
 *  below it. Returns a note when the running irep is not in the listing (mrblib or a gem). */
export function highlightDump(root, state, offset) {
  for (const e of root.querySelectorAll(".current, .caller")) e.classList.remove("current", "caller");
  if (!state || !state.contexts || !state.contexts.length) return "";
  const frames = state.contexts[state.cur].frames;
  if (!frames.length) return "";
  let note = "";
  frames.forEach((f, i) => {
    const innermost = i === frames.length - 1;
    const row = root.querySelector(`.insn[data-irep="${f.irep - offset}"][data-pc="${f.pc}"]`);
    if (!row) {
      // mrblib and the gems are loaded before the program, so their ireps come before `offset`
      if (innermost && f.irep < offset) note = `${f.target_class}${f.mid ? "#" + f.mid : ""} を実行中（mrblib／gem の irep ${f.irep}。この欄はプログラムの分だけです）`;
      return;
    }
    row.classList.add(innermost ? "current" : "caller");
    if (innermost) scrollIntoPane(root, row);
  });
  return note;
}

function scrollIntoPane(pane, row) {
  const top = row.offsetTop - pane.offsetTop;
  if (top < pane.scrollTop || top > pane.scrollTop + pane.clientHeight - 24) {
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 2);
  }
}

/** The instruction the VM is about to run, from the listing (for the hints below). */
function currentInsn(model) {
  const st = model.state;
  if (!st || !st.contexts || !st.contexts.length || !model.dump) return null;
  const frames = st.contexts[st.cur].frames;
  const f = frames[frames.length - 1];
  if (!f) return null;
  const ir = model.dump.ireps[f.irep - model.dump.offset];
  return ir ? ir.insns.find((i) => i.pc === f.pc) || null : null;
}

// ---------------------------------------------------------------- the "VM の状態" tabs

const TABS = { frames: framesTab, envs: envsTab, exc: excTab, fibers: fibersTab, gc: gcTab, ops: opsTab };

/** Draws one tab into `body`. `model` is what main.js keeps: the last `state`, the events of the
 *  last step (`recent`) and of the whole run (`trace`), the listing, the opcode counts, the GC
 *  history, the selected frame and the callbacks of the GC buttons. */
export function renderVm(body, tab, model) {
  body.textContent = "";
  body.append((TABS[tab] || framesTab)(model));
}

function note(text) { return el("p", "vm-note-line", text); }

function table(headers, rows) {
  const t = el("table", "vm-table");
  const thead = el("thead");
  const head = el("tr");
  for (const h of headers) head.append(el("th", null, h));
  thead.append(head);
  t.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr", r.cls);
    for (const c of r.cells) {
      const td = el("td");
      if (c instanceof Node) td.append(c); else td.textContent = String(c);
      tr.append(td);
    }
    if (r.onSelect) {
      tr.tabIndex = 0;
      tr.addEventListener("click", r.onSelect);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.onSelect(); } });
    }
    body.append(tr);
  }
  t.append(body);
  return t;
}

// 1. frames: the call stack, innermost first, and the registers of the selected frame
function framesTab(model) {
  const f = document.createDocumentFragment();
  const st = model.state;
  if (!st || !st.contexts || !st.contexts.length) { f.append(note("まだ実行していません。「デバッグ」を押すと、最初の命令の手前で止まります。")); return f; }
  const ctx = st.contexts[st.cur];
  const frames = ctx.frames.slice().reverse(); // innermost first, as a backtrace
  if (!frames.length) { f.append(note("フレームがありません（実行が終わっています）")); return f; }
  const selected = frames.find((x) => x.index === model.selectedFrame) || frames[0];

  f.append(table(["#", "メソッド", "ターゲット", "irep", "pc", "行", "env", ""], frames.map((fr) => ({
    cls: fr.index === selected.index ? "selected" : (fr === frames[0] ? "innermost" : ""),
    onSelect: () => model.onSelectFrame(fr.index),
    cells: [
      fr.index,
      fr.mid ? fr.mid : "(main)",
      fr.target_class,
      fr.irep,
      pad3(fr.pc),
      fr.line === null ? "—" : fr.line,
      fr.env === null ? "—" : `#${fr.env}`,
      fr.native_boundary ? "ネイティブの下" : "",
    ],
  }))));

  f.append(el("h3", "vm-h", `R0…R${selected.nregs - 1}（フレーム ${selected.index} のレジスタ）`));
  const list = el("ul", "regs");
  for (const r of selected.regs) {
    const li = el("li");
    li.append(el("span", "reg", `R${r.index}`));
    li.append(el("span", "rname", r.index === 0 ? "self" : r.name || ""));
    const v = el("span", "rval", r.text);
    if (r.id !== null && r.id !== undefined) { v.classList.add("oid"); v.title = `オブジェクト #${r.id}（${r.class}）`; v.dataset.oid = String(r.id); }
    li.append(v);
    li.append(el("span", "rclass", r.class));
    list.append(li);
  }
  f.append(list);
  f.append(note(`スタックの base=${selected.base} から nregs=${selected.nregs} 個がこのフレームのレジスタです（nlocals=${selected.nlocals}）。R0 は self。`));
  return f;
}

// 2. environments: what the book calls the closure's environment, on the frame or moved to the heap
function envsTab(model) {
  const f = document.createDocumentFragment();
  const st = model.state;
  const envs = st && st.envs ? st.envs : [];
  const created = new Set(), detached = new Set();
  for (const e of model.recent || []) {
    if (e.kind === "env_create") created.add(e.env);
    if (e.kind === "env_detach") detached.add(e.env);
  }
  const insn = currentInsn(model);
  if (insn && (insn.op === "GETUPVAR" || insn.op === "SETUPVAR")) {
    f.append(note(`${insn.op}: 上位環境を ${insn.c} 段たどって、その R${insn.b} を読み書きします（このフレームの env から始めます）。`));
  }
  if (!envs.length) {
    f.append(note("いま生きている環境はありません。ブロックやクロージャを作ると増えます（vm_closure.rb、cg_upvar.rb）。"));
  } else {
    f.append(table(["#id", "状態", "len", "ctx", "作ったメソッド", "値"], envs.map((e) => ({
      cls: created.has(e.id) ? "flash-new" : detached.has(e.id) ? "flash-detach" : "",
      cells: [
        `#${e.id}`,
        e.attached ? "フレーム上" : "ヒープへ（detached）",
        e.len,
        e.ctx,
        e.mid || "(main)",
        e.values.map((v) => v.text).join(", ") || "—",
      ],
    }))));
    f.append(note("フレームが返ると、そのフレームのレジスタは環境（Env）に写されて残ります。これがクロージャが外側の変数を見続けられる仕組みです。"));
  }
  const log = (model.trace || []).filter((e) => e.kind === "env_create" || e.kind === "env_detach").slice(-12);
  if (log.length) {
    f.append(el("h3", "vm-h", "環境の出来事"));
    f.append(table(["出来事", "#id", "len", "詳しく"], log.map((e) => ({
      cells: e.kind === "env_create"
        ? ["作られた", `#${e.env}`, e.len, `context ${e.ctx} のフレーム ${e.frame}、base=${e.base}`]
        : ["外された", `#${e.env}`, e.len, e.reason === "frame_return" ? "フレームが返った" : "Fiber が回収された"],
    }))));
  }
  return f;
}

// 3. exceptions: the catch table lookups of the last raise (or of a break/return)
function excTab(model) {
  const f = document.createDocumentFragment();
  const t = model.trace || [];
  let from = -1;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].kind === "raise" || (t[i].kind === "frame_unwound" && t[i].by !== "raise")) { from = i; break; }
  }
  if (from < 0) {
    f.append(note("まだ例外も break／return の大域脱出も起きていません（cg_rescue.rb を試してください）。"));
    return f;
  }
  const head = t[from];
  if (head.kind === "raise") {
    f.append(el("h3", "vm-h", `${head.class} が起きました`));
    f.append(note(`フレーム ${head.frame}、irep ${head.irep}、pc ${pad3(head.pc)}${head.line === null ? "" : `、${head.line} 行目`}。ここから内側のフレームの catch 表を順に引きます。`));
  } else {
    f.append(el("h3", "vm-h", head.by === "break" ? "break の大域脱出" : "return の大域脱出"));
  }
  if (model.state && model.state.pending_exc) {
    f.append(note(`いま持っている例外: ${model.state.pending_exc.text}`));
  }
  const rows = [];
  for (const e of t.slice(from)) {
    if (e.kind === "catch_look") {
      rows.push({
        cls: e.matched ? "matched" : "",
        cells: [
          `フレーム ${e.frame}`,
          e.irep,
          pad3(e.pc),
          e.line === null ? "—" : e.line,
          e.matched ? `${e.matched.type === "ensure" ? "ensure" : "rescue"} ${pad3(e.matched.begin)}..${pad3(e.matched.end)} → ${pad3(e.matched.target)}` : "この表には無い",
          e.matched ? "ここへ飛ぶ" : "フレームを捨てる",
        ],
      });
    } else if (e.kind === "frame_unwound") {
      rows.push({ cls: "unwound", cells: [`フレーム ${e.frame}`, "—", "—", "—", "巻き戻し", { raise: "例外", break: "break", return: "return" }[e.by] || e.by] });
    } else if (e.kind === "raise" && e !== head) {
      rows.push({ cls: "matched", cells: [`フレーム ${e.frame}`, e.irep, pad3(e.pc), e.line === null ? "—" : e.line, `${e.class} を投げた`, ""] });
    }
  }
  f.append(table(["どこで", "irep", "pc", "行", "catch 表", "結果"], rows));
  f.append(note("mruby は setjmp／longjmp を使わず、irep ごとの catch 表を内側から順に引いて飛び先を決めます（本の vm.re「例外」）。"));
  return f;
}

// 4. fibers: one card per context; the running one has a frame
function fibersTab(model) {
  const f = document.createDocumentFragment();
  const st = model.state;
  if (!st || !st.contexts) { f.append(note("まだ実行していません")); return f; }
  const last = (model.trace || []).filter((e) => e.kind === "fiber_switch").slice(-1)[0];
  if (last) {
    const kind = { resume: "resume", yield: "yield", transfer: "transfer", terminate: "終了", reset: "作り直し" }[last.switch] || last.switch;
    f.append(note(`直前の切り替え: context ${last.from} → ${last.to}（${kind}）`));
  }
  const cards = el("div", "cards");
  for (const c of st.contexts) {
    const card = el("div", `card${c.is_current ? " current" : ""}`);
    card.append(el("h4", null, c.index === 0 ? "root（メインの実行）" : `Fiber（context ${c.index}）`));
    const top = c.frames.length ? c.frames[c.frames.length - 1] : null;
    const dl = el("dl");
    for (const [k, v] of [
      ["状態", c.status],
      ["フレームの深さ", c.frames.length],
      ["いる場所", top ? `${top.mid ? top.target_class + "#" + top.mid : "(main)"}${top.line === null ? "" : ` ${top.line} 行目`}` : "—"],
      ["Fiber オブジェクト", c.fiber === null ? "—" : `#${c.fiber}`],
      ["呼び出し元", c.prev === null ? "—" : `context ${c.prev}`],
    ]) { dl.append(el("dt", null, k)); dl.append(el("dd", null, String(v))); }
    card.append(dl);
    cards.append(card);
  }
  f.append(cards);
  f.append(note("Fiber は context ごとにスタックを持ちます。実行中の context のスタックだけが VM 側にあり、他は context に退避されています。"));
  return f;
}

// 5. GC: the numbers the heap keeps, the two buttons and the history of collections
function gcTab(model) {
  const f = document.createDocumentFragment();
  const h = model.state && model.state.heap;
  if (!h) { f.append(note("まだ実行していません")); return f; }
  const dl = el("dl", "figures");
  for (const [k, v] of [
    ["オブジェクトの枠", num(h.len)],
    ["生きている", num(h.live)],
    ["空き", num(h.free)],
    ["前回の回収から", `${num(h.allocated_since_gc)} / ${num(h.alloc_threshold)}`],
    ["回収した回数", num(h.gc_count)],
    ["前回の回収後", num(h.live_after_gc)],
  ]) { dl.append(el("dt", null, k)); dl.append(el("dd", null, v)); }
  f.append(dl);

  const bar = el("div", "gc-buttons");
  const collect = el("button", null, "今すぐ回収");
  collect.type = "button";
  collect.addEventListener("click", () => model.onGc());
  const stress = el("button", null, h.stress ? "ストレス: on" : "ストレス: off");
  stress.type = "button";
  stress.setAttribute("aria-pressed", String(!!h.stress));
  stress.addEventListener("click", () => model.onStress(!h.stress));
  bar.append(collect, stress);
  f.append(bar);
  f.append(note("ストレスは 1 回の割り当てごとに回収します（遅くなりますが、回収の様子がよく見えます）。"));

  const hist = (model.trace || []).filter((e) => e.kind === "gc_collect").slice(-15);
  if (hist.length) {
    f.append(el("h3", "vm-h", "回収の履歴"));
    f.append(table(["生きていた", "残った", "回収した", "その間の割り当て"], hist.map((e) => ({
      cells: [num(e.before_live), num(e.after_live), num(e.swept), num(e.allocated_since)],
    }))));
  }
  f.append(note("印を付ける根は、各フレームのレジスタ（フレームの表）、グローバル変数、定数、クラス、実行中の Fiber と、ネイティブが持っている値です。"));
  return f;
}

// 6. the instruction histogram
function opsTab(model) {
  const f = document.createDocumentFragment();
  const counts = (model.opCounts || []).slice().sort((a, b) => b.count - a.count);
  if (!counts.length) { f.append(note("「続行」か「実行」のあとに、実行した命令の数が出ます。")); return f; }
  const total = counts.reduce((s, c) => s + c.count, 0);
  f.append(note(`${num(total)} 命令、${counts.length} 種類`));
  const list = el("ul", "bars");
  const max = counts[0].count;
  for (const c of counts.slice(0, 25)) {
    const li = el("li");
    const name = el("span", "bar-name", c.op);
    name.dataset.op = c.op;
    li.append(name);
    const track = el("span", "bar");
    const fill = el("span", "bar-fill");
    fill.style.width = `${Math.max(1, (c.count / max) * 100)}%`;
    track.append(fill);
    li.append(track);
    li.append(el("span", "bar-num", `${num(c.count)}（${((c.count / total) * 100).toFixed(1)}%）`));
    list.append(li);
  }
  f.append(list);
  return f;
}

// ---------------------------------------------------------------- opcode reference

let opcodes = null;
async function opcodeTable() {
  if (!opcodes) {
    const j = await (await fetch("opcodes.json")).json();
    opcodes = Array.isArray(j) ? Object.fromEntries(j.map((o) => [o.opcode || o.name, o])) : j;
  }
  return opcodes;
}

/** Hover or tap an opcode name (in the listing or in the histogram) for its description.
 *  The data is the book's dataset, see tools/opcodes.sh. */
export function initOpcodeTips(tip, ...roots) {
  const hide = () => { tip.hidden = true; };
  const show = async (target) => {
    const name = target.dataset.op;
    const t = await opcodeTable().catch(() => null);
    const o = t && t[name];
    if (!o) return hide();
    tip.textContent = "";
    tip.append(el("div", "tip-name", name));
    const fmt = o.format || o.operand_format;
    const ops = (o.operands || []).map((x) => `${x.name}${x.bits ? `:${x.bits}` : ""}`).join(" ");
    if (fmt) tip.append(el("div", "tip-ops", `${fmt}${ops ? `  （${ops}）` : ""}`));
    if (o.definition) tip.append(el("code", "tip-def", o.definition));
    if (o.summary) tip.append(el("p", "tip-sum", o.summary));
    const foot = [o.article && `本: ${o.article}`, o.since && `${o.since} から`].filter(Boolean).join(" · ");
    if (foot) tip.append(el("div", "tip-foot", foot));
    const r = target.getBoundingClientRect();
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    tip.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  };
  for (const root of roots) {
    root.addEventListener("pointerover", (e) => { const op = e.target.closest && e.target.closest("[data-op]"); if (op) show(op); });
    root.addEventListener("pointerout", (e) => { const to = e.relatedTarget; if (!to || !(to.closest && to.closest("[data-op]"))) hide(); });
    root.addEventListener("click", (e) => { const op = e.target.closest && e.target.closest("[data-op]"); if (op) show(op); else hide(); });
  }
  window.addEventListener("scroll", hide, true);
}
