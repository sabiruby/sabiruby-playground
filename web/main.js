// UI of the playground. All Ruby runs in worker.js; this file owns the editor, the samples,
// the output pane and the worker's lifecycle (Stop = terminate + a new worker).

import { EditorView, basicSetup, EditorState, keymap, indentWithTab, StreamLanguage, HighlightStyle, syntaxHighlighting, ruby, tags, Compartment, StateField, StateEffect, Decoration } from "./vendor/codemirror/codemirror.js";
import { renderDump, highlightDump, renderVm, initOpcodeTips } from "./debug.js";
import { STEP_INSTRUCTION, STEP_OVER, STEP_INTO, STEP_OUT, STEP_CONTINUE } from "./sabi.js";

const DEFAULT = `# SabiRuby Playground
# mruby 4.1 のコンパイラ（C を wasm に）で翻訳し、Rust 製 VM の SabiRuby（wasm）で実行します。
# Ctrl+Enter で実行。コード → AST → バイトコード → 実行結果 の順に並んでいます。

class Greeter
  def initialize(name) = @name = name
  def greet = "Hello, #{@name}!"
end

puts Greeter.new("SabiRuby").greet

fib = Fiber.new do
  a, b = 0, 1
  loop { Fiber.yield a; a, b = b, a + b }
end
p 10.times.map { fib.resume }

h = { apple: 3, banana: 5 }
h.each { |k, v| puts "#{k}: #{'*' * v}" }
`;
const OUTPUT_LIMIT = 1 << 20; // characters kept in the output pane
const SHARE_LIMIT = 8192;     // bytes of source put into a link

const $ = (id) => document.getElementById(id);
const ui = {
  run: $("run"), stop: $("stop"), toggleDump: $("toggle-dump"), toggleAst: $("toggle-ast"), share: $("share"), sample: $("sample"),
  output: $("output"), status: $("status"), dump: $("dump"), dumpPane: $("dump-pane"), ast: $("ast"), astPane: $("ast-pane"), panes: $("panes"),
  compare: $("compare"), compareResult: $("compare-result"), sampleNote: $("sample-note"), version: $("version"), toast: $("toast"),
  realtime: $("realtime"),
  debug: $("debug"), debugControls: $("debug-controls"), stepOver: $("step-over"), stepInto: $("step-into"),
  stepOut: $("step-out"), stepInsn: $("step-insn"), cont: $("continue"), debugRestart: $("debug-restart"), debugQuit: $("debug-quit"),
  stepScope: $("step-scope"), vmPane: $("vm-pane"), vmBody: $("vm-body"), vmTabs: $("vm-tabs"), vmNote: $("vm-note"),
  dumpNote: $("dump-note"), dumpBanner: $("dump-banner"), opcodeTip: $("opcode-tip"),
};

// ---------------------------------------------------------------- editor

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword], color: "var(--hl-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--hl-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--hl-number)" },
  { tag: [tags.special(tags.variableName), tags.labelName], color: "var(--hl-symbol)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [tags.className, tags.typeName, tags.constant(tags.variableName)], color: "var(--hl-constant)" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--hl-variable)" },
]);

const readOnly = new Compartment();
const setVmLine = StateEffect.define();
const vmLine = Decoration.line({ class: "cm-currentVmLine" });
const vmLineField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setVmLine)) continue;
      const n = e.value;
      value = n && n >= 1 && n <= tr.state.doc.lines ? Decoration.set([vmLine.range(tr.state.doc.line(n).from)]) : Decoration.none;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const editor = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: initialSource(),
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      StreamLanguage.define(ruby),
      syntaxHighlighting(highlight),
      keymap.of([{ key: "Mod-Enter", run: () => { run(); return true; } }, indentWithTab]),
      vmLineField,
      readOnly.of(EditorState.readOnly.of(false)),
      EditorView.updateListener.of((u) => { if (u.docChanged) onEdit(); }),
    ],
  }),
});
const source = () => editor.state.doc.toString();
const setEditable = (on) => editor.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(!on)) });
const showVmLine = (n) => editor.dispatch({ effects: setVmLine.of(n || null) });
function setSource(text) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

// ---------------------------------------------------------------- worker

const modulePromise = (async () => {
  const response = await fetch("sabiruby.wasm");
  if (!response.ok) throw new Error(`sabiruby.wasm: HTTP ${response.status}`);
  const module = await WebAssembly.compileStreaming(response);
  return { module };
})();

let worker = null, running = false, ready = false;
let decoder, outLen, truncated, lastOutput = "", lastRunSource = null, loadMs = null;

function startWorker() {
  ready = false;
  worker = new Worker("worker.js", { type: "module" });
  worker.onmessage = (e) => onMessage(e.data);
  worker.onerror = (e) => { setStatus(`Worker を起動できませんでした: ${e.message || "不明なエラー"}`); };
  modulePromise.then(({ module }) => worker.postMessage({ type: "init", module }))
    .catch((err) => setStatus(`wasm を読み込めませんでした: ${err.message}`));
}

function onMessage(m) {
  switch (m.type) {
    case "ready":
      ready = true;
      ui.version.textContent = m.version;
      ui.run.disabled = false;
      if (loadMs === null) {
        loadMs = performance.now(); // since navigation start: everything the first visit waits for
        setStatus(`準備完了（ページを開いてから ${fmt(loadMs)} ms）`);
      } else {
        setStatus("準備完了");
      }
      requestInspect();
      break;
    case "output":
      appendOutput(decoder.decode(m.bytes, { stream: true }));
      break;
    case "progress":
      setStatus(`実行中… ${fmtStats(m.stats)} · ${fmt(m.ms)} ms`, true);
      break;
    case "done":
      appendOutput(decoder.decode());
      finishRun(m);
      break;
    case "inspect":
      if (m.id !== inspectId) break; // an older request; a newer one is on its way
      if (debugging) break;          // the listing belongs to the program being debugged
      ui.ast.textContent = m.ast;
      ui.dump.classList.toggle("note", !m.ok);
      if (m.ok && m.dumpJson && !m.dumpJson.error) {
        vm.dump = m.dumpJson;
        renderDump(ui.dump, m.dumpJson); // rows, so an opcode can be looked up
      } else {
        vm.dump = null;
        ui.dump.textContent = m.dump;
      }
      break;
    case "debug":
      onDebug(m);
      break;
    case "op-counts":
      vm.opCounts = m.counts;
      if (vmTab === "ops") renderVm(ui.vmBody, vmTab, vm);
      break;
    case "crash":
      appendError(`VM が停止しました: ${m.text}`);
      if (debugging) leaveDebug();
      restart("VM を作り直しました");
      break;
  }
}

function run() {
  if (!ready || running || debugging) return;
  running = true;
  ui.run.disabled = true;
  ui.stop.disabled = false;
  ui.output.textContent = "";
  decoder = new TextDecoder("utf-8", { fatal: false });
  outLen = 0; truncated = false; lastOutput = "";
  lastRunSource = source();
  hideCompare();
  const realtime = ui.realtime.getAttribute("aria-pressed") === "true";
  setStatus(realtime ? "実行中…（実時間）" : "実行中…", true);
  worker.postMessage({ type: "run", src: lastRunSource, realtime });
  requestInspect();
}

// `sleep` waits for real: the program runs as a task and mruby-task's clock comes from the
// browser's, so a sleeping task costs time instead of nothing (docs/playground.md). Off by
// default, and not used while debugging, where the page steps the root context itself.
ui.realtime.addEventListener("click", () => {
  const on = ui.realtime.getAttribute("aria-pressed") !== "true";
  ui.realtime.setAttribute("aria-pressed", String(on));
  toast(on ? "実時間: sleep はブラウザの時計で待ちます（プログラムはタスクとして走ります）" : "実時間をやめました: tick は命令数で進みます");
});

function finishRun(m) {
  running = false;
  ui.run.disabled = false;
  ui.stop.disabled = true;
  if (m.kind === "compile") {
    appendError(m.text);
    lastOutput += `<compile error: ${m.text}>\n`;
    setStatus(`コンパイルエラー · ${fmt(m.ms)} ms`);
  } else if (m.kind === "error" || m.kind === "internal") {
    appendError(m.text);
    lastOutput += `<error: ${m.text}>\n`;
    setStatus(`例外で終了 · ${fmtStats(m.stats)} · ${fmt(m.ms)} ms`);
  } else {
    setStatus(`完了 · ${fmtStats(m.stats)} · ${fmt(m.ms)} ms`);
  }
  if (!ui.output.textContent) ui.output.innerHTML = '<span class="note">（出力なし）</span>';
  showCompareIfSample();
}

function restart(message) {
  worker.terminate();
  running = false;
  if (debugging) leaveDebug();
  ui.run.disabled = true;
  ui.stop.disabled = true;
  startWorker();
  setStatus(message);
}

function stop() {
  if (!running) return;
  appendOutput(decoder.decode());
  appendNote("\n（停止しました）");
  restart("停止しました。VM を作り直しています…");
}

// ---------------------------------------------------------------- debugging
// The worker holds the VM; this side keeps what the panes draw from (web/debug.js).

let debugging = false, debugBusy = false, vmTab = "frames";
const vm = {
  state: null, dump: null, trace: [], recent: [], opCounts: [], selectedFrame: null,
  onSelectFrame: (index) => { vm.selectedFrame = index; renderVm(ui.vmBody, vmTab, vm); },
  onGc: () => sendDebug({ type: "debug-gc", collect: true }),
  onStress: (on) => sendDebug({ type: "debug-gc", stress: on }),
};

function sendDebug(message) {
  if (!debugging || debugBusy) return;
  debugBusy = true;
  setStepButtons(false);
  worker.postMessage(message);
}

function setStepButtons(on) {
  for (const b of [ui.stepOver, ui.stepInto, ui.stepOut, ui.stepInsn, ui.cont]) b.disabled = !on;
}

function startDebug() {
  if (!ready || running) return;
  debugging = true;
  ui.debug.setAttribute("aria-pressed", "true");
  ui.debugControls.hidden = false;
  ui.vmPane.hidden = false;
  ui.run.disabled = true;
  ui.stop.disabled = true;
  ui.realtime.disabled = true; // the page steps the root context itself here
  setEditable(false);
  ui.output.textContent = "";
  decoder = new TextDecoder("utf-8", { fatal: false });
  outLen = 0; truncated = false; lastOutput = "";
  lastRunSource = source();
  hideCompare();
  Object.assign(vm, { state: null, trace: [], recent: [], opCounts: [], selectedFrame: null });
  debugBusy = true;
  setStepButtons(false);
  setStatus("デバッグの準備をしています…", true);
  worker.postMessage({ type: "debug-start", src: lastRunSource });
  worker.postMessage({ type: "debug-scope", programOnly: !enteringMrblib() }); // a new worker starts with the default
  if (current && current.note && source() === current.text) toast(`見どころ: ${current.note}`);
}

/** Puts the page back the way it was; the VM itself is reset by the worker. */
function leaveDebug() {
  debugging = false;
  debugBusy = false;
  ui.debug.setAttribute("aria-pressed", "false");
  ui.debugControls.hidden = true;
  ui.vmPane.hidden = true;
  ui.run.disabled = !ready;
  ui.realtime.disabled = false;
  setEditable(true);
  showVmLine(null);
  highlightDump(ui.dump, null, 0);
  ui.dumpNote.textContent = "sabiruby dump の形式";
  ui.dumpBanner.hidden = true;
}

function stopDebug() {
  if (!debugging) return;
  worker.postMessage({ type: "debug-stop" });
  leaveDebug();
  setStatus("デバッグを終了しました");
  requestInspect();
}

function onDebug(m) {
  if (m.phase === "stopped") return;
  if (m.phase === "compile_error") {
    appendError(m.text);
    leaveDebug();
    setStatus("コンパイルエラー");
    return;
  }
  if (m.phase === "started") {
    vm.dump = m.dump;
    renderDump(ui.dump, m.dump);
  }
  debugBusy = false;
  if (m.state && m.state.contexts) vm.state = m.state;
  if (m.trace && m.trace.length) {
    vm.recent = m.trace;
    vm.trace = vm.trace.concat(m.trace).slice(-5000);
  } else if (m.phase !== "started") {
    vm.recent = [];
  }
  const frames = currentFrames();
  if (!frames.some((f) => f.index === vm.selectedFrame)) vm.selectedFrame = frames.length ? frames[frames.length - 1].index : null;
  drawVm();

  const done = m.phase === "finished" || m.phase === "error";
  setStepButtons(!done);
  if (m.phase === "started") {
    setStatus("最初の命令の手前で止まっています。ステップオーバー（F10）やステップイン（F11）で進みます。");
  } else if (m.phase === "paused") {
    setStatus(`停止中 · ${fmtStats(m.stats)}`);
  } else if (m.phase === "finished") {
    appendOutput(decoder.decode());
    if (!ui.output.textContent) ui.output.innerHTML = '<span class="note">（出力なし）</span>';
    setStatus(`完了 · ${fmtStats(m.stats)}`);
    worker.postMessage({ type: "op-counts" });
  } else if (m.phase === "error") {
    appendOutput(decoder.decode());
    appendError(m.text);
    setStatus(`例外で終了 · ${fmtStats(m.stats)}`);
    worker.postMessage({ type: "op-counts" });
  }
}

const currentFrames = () => (vm.state && vm.state.contexts && vm.state.contexts.length ? vm.state.contexts[vm.state.cur].frames : []);

function drawVm() {
  const offset = vm.dump ? vm.dump.offset : 0;
  // inside mrblib the listing has no row to highlight; the banner says where the VM is instead
  const banner = highlightDump(ui.dump, vm.state, offset);
  ui.dumpBanner.textContent = banner;
  ui.dumpBanner.hidden = !banner;
  ui.dumpNote.textContent = "実行中の命令を強調しています";
  const frames = currentFrames();
  const top = frames[frames.length - 1];
  showVmLine(top && top.irep >= offset ? top.line : null);
  ui.vmNote.textContent = vm.state ? `${vm.state.instructions.toLocaleString()} 命令 · 生存 ${vm.state.heap.live.toLocaleString()}` : "";
  renderVm(ui.vmBody, vmTab, vm);
}

ui.debug.addEventListener("click", () => (debugging ? stopDebug() : startDebug()));
ui.debugQuit.addEventListener("click", stopDebug);
ui.debugRestart.addEventListener("click", () => { if (debugging) { leaveDebug(); startDebug(); } });
ui.stepOver.addEventListener("click", () => sendDebug({ type: "debug-step", mode: STEP_OVER }));
ui.stepInto.addEventListener("click", () => sendDebug({ type: "debug-step", mode: STEP_INTO }));
ui.stepOut.addEventListener("click", () => sendDebug({ type: "debug-step", mode: STEP_OUT }));
ui.stepInsn.addEventListener("click", () => sendDebug({ type: "debug-step", mode: STEP_INSTRUCTION }));
ui.cont.addEventListener("click", () => { setStatus("実行中…", true); sendDebug({ type: "debug-step", mode: STEP_CONTINUE }); });

const enteringMrblib = () => ui.stepScope.getAttribute("aria-pressed") === "true";
ui.stepScope.addEventListener("click", () => {
  const on = !enteringMrblib();
  ui.stepScope.setAttribute("aria-pressed", String(on));
  worker.postMessage({ type: "debug-scope", programOnly: !on });
  toast(on ? "mrblib や gem の中でも止まります" : "mrblib や gem の中では止まりません（プログラムの命令だけ）");
});

ui.vmTabs.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-tab]");
  if (!button) return;
  vmTab = button.dataset.tab;
  for (const b of ui.vmTabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b === button));
  renderVm(ui.vmBody, vmTab, vm);
});

// The keys of Visual Studio and VS Code: F10 over, F11 into, Shift+F11 out, F5 continue.
document.addEventListener("keydown", (e) => {
  if (!debugging || e.altKey) return;
  const ctrl = e.ctrlKey || e.metaKey;
  let button = null;
  if (e.key === "F10" && !ctrl && !e.shiftKey) button = ui.stepOver;
  else if (e.key === "F11") button = ctrl ? ui.stepInsn : e.shiftKey ? ui.stepOut : ui.stepInto;
  else if (e.key === "F5") button = ctrl && e.shiftKey ? ui.debugRestart : e.shiftKey ? ui.debugQuit : ui.cont;
  if (!button || button.disabled) return;
  e.preventDefault(); // F5 and Shift+F5 would reload the page
  button.click();
});

initOpcodeTips(ui.opcodeTip, ui.dump, ui.vmBody);

// ---------------------------------------------------------------- output

function appendOutput(text) {
  if (!text) return;
  if (lastOutput.length < OUTPUT_LIMIT) lastOutput += text; // for the comparison; fixtures are small
  if (truncated) return;
  if (outLen + text.length > OUTPUT_LIMIT) {
    text = text.slice(0, OUTPUT_LIMIT - outLen);
    truncated = true;
  }
  outLen += text.length;
  ui.output.append(text);
  if (truncated) appendNote(`\n（出力が ${OUTPUT_LIMIT.toLocaleString()} 文字を超えたので、表示はここまでにしています）`);
  ui.output.scrollTop = ui.output.scrollHeight;
}
function appendError(text) {
  const span = document.createElement("span");
  span.className = "err";
  span.textContent = text;
  ui.output.append(span);
}
function appendNote(text) {
  const span = document.createElement("span");
  span.className = "note";
  span.textContent = text;
  ui.output.append(span);
}
function setStatus(text, busy = false) {
  ui.status.textContent = text;
  ui.status.setAttribute("aria-busy", busy ? "true" : "false");
}
const fmt = (ms) => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString());
const fmtStats = (s) => s ? `${s.instructions.toLocaleString()} 命令 · GC ${s.gc.toLocaleString()} 回 · 生存オブジェクト ${s.live.toLocaleString()}` : "";

// ---------------------------------------------------------------- AST and bytecode

let inspectTimer = null, inspectId = 0;
const shown = (button) => button.getAttribute("aria-pressed") === "true";
function requestInspect() {
  if (ready && (shown(ui.toggleAst) || shown(ui.toggleDump))) worker.postMessage({ type: "inspect", src: source(), id: ++inspectId });
}
for (const [button, pane] of [[ui.toggleAst, ui.astPane], [ui.toggleDump, ui.dumpPane]]) {
  button.addEventListener("click", () => {
    const on = !shown(button);
    button.setAttribute("aria-pressed", String(on));
    pane.hidden = !on;
    if (on) requestInspect();
  });
}

// ---------------------------------------------------------------- samples and comparison

let samples = { fixtures: [], book: [] }, current = null; // current: { name, text, expected? }

async function loadSamples() {
  try {
    samples = await (await fetch("samples/index.json")).json();
  } catch { return; }
  const group = (label, list, prefix) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const s of list) {
      const o = document.createElement("option");
      o.value = `${prefix}:${s.name}`;
      o.textContent = s.name;
      g.append(o);
    }
    ui.sample.append(g);
  };
  group("照合スクリプト（本家 mruby の出力つき）", samples.fixtures, "f");
  group("本の例", samples.book, "b");
}

ui.sample.addEventListener("change", async () => {
  const [kind, name] = ui.sample.value.split(":");
  if (!name) return;
  const s = (kind === "f" ? samples.fixtures : samples.book).find((x) => x.name === name);
  const text = await (await fetch(s.path)).text();
  if (debugging) stopDebug();
  current = { name, text, expected: s.expected, note: s.note };
  setSource(text);
  history.replaceState(null, "", location.pathname + location.search);
  ui.sampleNote.textContent = kind === "f" ? `${name}.rb · 本家の出力と比較できます` : `${name}.rb · 本の例${s.note ? " · 見どころあり" : ""}`;
  hideCompare();
  ui.output.textContent = "";
  setStatus(kind === "f" ? "「実行」のあと、本家 mruby の出力と比べられます" : "準備完了");
});

function onEdit() {
  if (current && source() !== current.text) ui.sampleNote.textContent = `${current.name}.rb（編集済み）`;
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(requestInspect, 400);
}

function hideCompare() { ui.compare.hidden = true; ui.compareResult.hidden = true; }
function showCompareIfSample() { ui.compare.hidden = !(current && current.expected && lastRunSource !== null); }

ui.compare.addEventListener("click", async () => {
  const expected = await (await fetch(current.expected)).text();
  const edited = lastRunSource !== current.text;
  const same = lastOutput === expected;
  ui.compareResult.hidden = false;
  ui.compareResult.className = `chip ${same ? "ok" : "ng"}`;
  if (same) {
    ui.compareResult.textContent = edited ? "一致（編集後のコード）" : "本家と一致";
  } else {
    let i = 0;
    while (i < expected.length && lastOutput[i] === expected[i]) i++;
    const line = expected.slice(0, i).split("\n").length;
    ui.compareResult.textContent = edited ? `不一致（${line} 行目から。コードは編集済み）` : `不一致（${line} 行目から）`;
  }
});

// ---------------------------------------------------------------- share links

function initialSource() {
  const m = location.hash.match(/^#code=([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch { /* fall through to the default */ }
  }
  return DEFAULT;
}

ui.share.addEventListener("click", async () => {
  const bytes = new TextEncoder().encode(source());
  if (bytes.length > SHARE_LIMIT) return toast(`コードが ${SHARE_LIMIT.toLocaleString()} バイトを超えるので、リンクにできません`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const code = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  history.replaceState(null, "", `#code=${code}`);
  try {
    await navigator.clipboard.writeText(location.href);
    toast("リンクをコピーしました");
  } catch {
    toast("アドレスバーのリンクをコピーしてください");
  }
});

let toastTimer = null;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2400);
}

// ---------------------------------------------------------------- start

ui.run.addEventListener("click", run);
ui.stop.addEventListener("click", stop);
if (!("WebAssembly" in self)) {
  setStatus("このブラウザは WebAssembly に対応していません");
} else {
  startWorker();
  loadSamples();
}
