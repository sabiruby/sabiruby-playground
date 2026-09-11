// UI of the playground. All Ruby runs in worker.js; this file owns the editor, the samples,
// the output pane and the worker's lifecycle (Stop = terminate + a new worker).

import { EditorView, basicSetup, EditorState, keymap, indentWithTab, StreamLanguage, HighlightStyle, syntaxHighlighting, ruby, tags } from "./vendor/codemirror/codemirror.js";

const DEFAULT = `# SabiRuby Playground
# mruby 4.1 のコンパイラ（C を wasm に）で翻訳し、Rust 製 VM の SabiRuby（wasm）で実行します。
# Ctrl+Enter で実行。右上の「バイトコード」で命令列も見られます。

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
  run: $("run"), stop: $("stop"), toggleDump: $("toggle-dump"), share: $("share"), sample: $("sample"),
  output: $("output"), status: $("status"), dump: $("dump"), dumpPane: $("dump-pane"), panes: $("panes"),
  compare: $("compare"), compareResult: $("compare-result"), sampleNote: $("sample-note"), version: $("version"), toast: $("toast"),
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
      EditorView.updateListener.of((u) => { if (u.docChanged) onEdit(); }),
    ],
  }),
});
const source = () => editor.state.doc.toString();
function setSource(text) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

// ---------------------------------------------------------------- worker

const modulePromise = (async () => {
  const t0 = performance.now();
  const response = await fetch("sabiruby.wasm");
  if (!response.ok) throw new Error(`sabiruby.wasm: HTTP ${response.status}`);
  const module = await WebAssembly.compileStreaming(response);
  return { module, ms: performance.now() - t0 };
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
        modulePromise.then(({ ms }) => { loadMs = ms + m.ms; setStatus(`準備完了（wasm の読み込みと VM の初期化: ${fmt(loadMs)} ms）`); });
      } else {
        setStatus("準備完了");
      }
      if (ui.toggleDump.getAttribute("aria-pressed") === "true") requestDump();
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
    case "dump":
      ui.dump.textContent = m.text;
      ui.dump.classList.toggle("note", !m.ok);
      break;
    case "crash":
      appendError(`VM が停止しました: ${m.text}`);
      restart("VM を作り直しました");
      break;
  }
}

function run() {
  if (!ready || running) return;
  running = true;
  ui.run.disabled = true;
  ui.stop.disabled = false;
  ui.output.textContent = "";
  decoder = new TextDecoder("utf-8", { fatal: false });
  outLen = 0; truncated = false; lastOutput = "";
  lastRunSource = source();
  hideCompare();
  setStatus("実行中…", true);
  worker.postMessage({ type: "run", src: lastRunSource });
  if (ui.toggleDump.getAttribute("aria-pressed") === "true") requestDump();
}

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

// ---------------------------------------------------------------- bytecode

let dumpTimer = null;
function requestDump() {
  if (ready) worker.postMessage({ type: "dump", src: source() });
}
ui.toggleDump.addEventListener("click", () => {
  const on = ui.toggleDump.getAttribute("aria-pressed") !== "true";
  ui.toggleDump.setAttribute("aria-pressed", String(on));
  ui.dumpPane.hidden = !on;
  ui.panes.classList.toggle("with-dump", on);
  if (on) requestDump();
});

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
  current = { name, text, expected: s.expected };
  setSource(text);
  history.replaceState(null, "", location.pathname + location.search);
  ui.sampleNote.textContent = kind === "f" ? `${name}.rb · 本家の出力と比較できます` : `${name}.rb · 本の例`;
  hideCompare();
  ui.output.textContent = "";
  setStatus(kind === "f" ? "「実行」のあと、本家 mruby の出力と比べられます" : "準備完了");
});

function onEdit() {
  if (current && source() !== current.text) ui.sampleNote.textContent = `${current.name}.rb（編集済み）`;
  if (ui.toggleDump.getAttribute("aria-pressed") === "true") {
    clearTimeout(dumpTimer);
    dumpTimer = setTimeout(requestDump, 400);
  }
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
