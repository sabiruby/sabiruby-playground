# VM ビジュアライザ実装指示書（Playground 案 1〜6）

対象: この文書だけを読んで、別セッションの実装者（AI）が `docs/ideas.md` の 1〜6 を実装できること。
方針は著者決定（2026-09-12、「いいアイデアだ。1〜6 を実装指示書にしてほしい」）。
作業は 2 つのリポジトリにまたがる: **VM 側**（`../sabiruby`。状態の取り出し、出来事の記録、DBG の復号）と
**Playground 側**（このリポジトリ。C ABI、Worker、画面）。
作業前に `../sabiruby/README.md` の Rules と Verification、このリポジトリの `README.md`、`docs/playground.md`、`docs/ideas.md` を読むこと。

狙いは「本家の wasm ではできない見せ方」= **命令単位で VM の中を見せる**こと。本『Deep dive into mruby』の説明
（環境とクロージャ、longjmp 無しの大域脱出、Fiber、GC、opcode リファレンス）をそのまま動かして見せる。

## 0. 前提（調べて確かめた事実）

### Playground 側

* `wasm/src/lib.rs`（219 行）: C ABI は `sabi_version`、`sabi_alloc`／`sabi_free`、`sabi_compile(src,len,debug)`、`sabi_load`、`sabi_reset`、
  `sabi_start`、`sabi_step(budget)`（0 paused／1 finished／2 error／3 internal）、`sabi_take_output`、`sabi_take_text`、`sabi_dump`、`sabi_ast`、
  `sabi_stats(insns,live,gc)`。文字列は `give()` で `st.ret` に置き、次の `sabi_take_*`／`sabi_dump` まで有効。状態は `thread_local! ST`。
  wasm-bindgen は使わない。JSON 化のためのライブラリ（serde）も入っていない（サイズのため入れない。下記 2.1）。
* `web/sabi.js`（93 行）: ABI の薄い包み。`take(fn)`、`withBytes`、`stats()` はスクラッチ領域 `this.scratch`（32 バイト）を使う。Node のテストも同じファイルを使う。
* `web/worker.js`（65 行）: メッセージは `init`／`run`／`inspect`。`run` は `sabi.step(1_000_000)` を回し、`output`／`progress`／`done` を送る。
  停止は `worker.terminate()`。`inspect` は AST とダンプを返す。
* `web/main.js`（333 行）: `onMessage` の `switch (m.type)`（ready／output／progress／done／inspect／crash）、`run()`、`restart()`、`stop()`、
  `requestInspect()`、`loadSamples()`（`web/samples/index.json`。本の見本 `web/samples/book/*.rb`、キットの見本と `.out`）、`showCompareIfSample()`。
  エディタは CodeMirror 6（`web/vendor/` に esbuild で 1 本にまとめたもの、`tools/codemirror/`）。
* `web/index.html`: 欄は 4 つ（コード、AST、バイトコード、実行結果）。`#dump` は `<pre>` にダンプの文字列を入れているだけで、行の構造は無い。
* テスト: `test/api.mjs`（Node、ABI の経路 14 件。`runAll(src)` で compile→start→step）、`test/fixtures.mjs`（17 fixture）、
  `test/browser.mjs`（Playwright、headless Chromium。ページの実ボタン）。`npm test` が Node の 2 つ、`npm run test:browser` がブラウザ。
* ビルド: `tools/build.sh`（wasi-sdk、`wasm-opt`）。CI（`.github/workflows/pages.yml`）は `kishima/sabiruby` を固定コミットで隣に checkout する。
  **VM 側の変更を取り込むときは、この固定コミットを進める。**

### VM 側（`../sabiruby`、crate `sabiruby`、no_std + alloc）

* `Vm`（`src/vm.rs` 178〜）の公開フィールド: `heap: Heap`、`syms`、`ireps: Vec<VmIrep>`、`stack: Vec<Slot>`、`ci: Vec<CallInfo>`、`globals`、
  `exc: Option<Value>`、`instructions: u64`、`op_counts: Vec<u64>`（命令バイト値ごと。`exec_frames` の `self.op_counts[byte as usize] += 1`）、
  `gc_count`、`live_after_gc`、`gc_stress`、`contexts: Vec<Context>`、`cur: usize`（実行中の Context。`ROOT = 0`）。
* `CallInfo { base, pc, irep, proc_, n, kw, mid: Option<Sym>, target_class, env: Option<ObjId>, cci: Cci, vis, modfunc, vis_break }`。
  `Context { stack, ci, status: FiberState, prev, fib: Option<ObjId>, proc_, vmexec, pending_reg }`。**実行中の Context の `stack`／`ci` は `Vm` 側にあり、
  `contexts[cur]` の方は空**（`switch_context` が `mem::swap` する）。スナップショットではこの入れ替えを戻して読む。
* `VmIrep { nlocals, nregs, iseq, catch: Vec<CatchHandler{kind,begin,end,target}>, pool, syms, reps, lv: Vec<Option<Sym>> }`。**行番号は無い**:
  `src/rite.rs` 148 行目は `b"DBG\0" => { /* line numbers: not used yet */ }` で DBG セクションを読み飛ばしている。
  `Vm::load(bin)` は RITE の irep を `ireps` の末尾に足し、`rite.root + offset` を返す（mrblib と gem の irep が先に入っているので offset > 0）。
* ダンプ: `pub fn dump(rite: &rite::Rite) -> String`（`vm.rs` 2921〜）。`rite::Irep::decode(pc) -> Option<(Op, a, b, c, next)>`（`rite.rs` 272）、
  `Op::name()`、`Op::operands()`（`src/opcode.rs`、`OP_NAMES`、`OP_OPERANDS`、`OP_COUNT = 119`）。行番号の列は無い（`mrbc --verbose` は先頭に行番号を出す）。
* 出来事の場所:
  * 環境の生成 `frame_env()`（`vm.rs` 1564。`EnvData { ctx, base, len, bidx, attached: true, values, mid, target_class, .. }` を作りフレームに付ける）
  * 環境の切り離し: `pop_frame()`（1580〜。`ed.attached = false` は 1599）と、GC の sweep で終了した Context のフレームの環境を外す箇所（1459）
  * 例外の巻き戻し `handle_raise(exc, stop_depth, lc)`（1739〜。`catch_find(irep, pc, ensure_only)`（1651）で表を引き、無ければ `pop_frame()`）、
    非局所脱出 `unwind_return`（1702）
  * Fiber の切り替え `switch_context(to)`（1195）、`fiber_switch`／`fiber_yield`／`fiber_transfer`（1290〜）、`fiber_terminate`（1222）
  * GC `gc_collect()`（1417。`gc_mark_roots` → `mark_drain` → sweep。`heap.live_count()`、`heap.len()`、`is_free`、`is_marked`）
* `Heap { objs: Vec<HeapObject{class, ivars, frozen, kind: ObjKind}>, flags (MARKED/FREE), free, allocated_since_gc, alloc_threshold, .. }`。
  `ObjKind::{Object, Break, Class, String, Array, Hash, Range, Proc(ProcData{irep,upper,env,target_class,strict,scope,orphan}), Env(EnvData), Exception, Fiber(usize)}`。
* 値を Ruby を呼ばずに文字列にする関数は無い（`describe_for_error` はクラス名だけ。`inspect` はネイティブメソッドで、配列などは要素の `inspect` を Ruby 経由で呼ぶ）。
  **スナップショットの値表示は Rust 側で完結させる**（下記 1.3。Ruby を呼ぶとプログラムの状態が変わる）。
* `Vm::step(budget)` は `step_left` を減らしながら `run_loop_ctx(ROOT, 0)` を回す。命令境界で止まる。`Vm::start(irep)` が最上位フレームを積む。
* Rules（README）: 本体は no_std + alloc（`tools/check_no_std.sh`、CI で thumbv7em と wasm32 をビルド）。検証の基準（fixtures、mrbtest の基準値、Docker の mrbc）は動かさない。
  実行ループ（`exec_frames`）に命令ごとの分岐を足さない（性能。`docs/performance.md`、`tools/bench.sh` で本家比を測っている）。

### 本家（`../../ref/mruby`、4.1.0-rc）

* DBG セクション: `src/load.c` `read_section_debug`（521）→ `read_debug_record`（404）。ファイル名表の後、irep ごとに
  `pc_count`（4 バイト）、ファイル数（2 バイト）、ファイルごとに `start_pos`（4）、ファイル名のインデックス（2）、`line_entry_count`（4）、
  `line_type`（1）、行データ。`line_type` は `mrb_debug_line_ary`（0。pc ごとに行 2 バイト）、`flat_map`（1。`{start_pos 4, line 2}` の並び）、
  `packed_map`（2。`src/debug.c` 116〜: 可変長整数で pc の差分と行の差分を交互に持つ）。読み手は `src/debug.c` `mrb_debug_get_line`（154）。
  書き手は `mrbgems/mruby-compiler/src/dump.c` `write_debug_record`（542）。本の `bytecode.re`「DBG セクション」節に概要。
* `mrbc --verbose` の 1 命令の行は `    3 004 GETUPVAR	R2	2	0` の形（行番号、pc、命令、operand）。

### opcode データセット

* 本のリポジトリ `../../book_mruby3/dataset/opcodes.jsonl`（MIT、`dataset/LICENSE`。公開キット `../mruby-porting-kit/dataset/` に同じもの）。
  119 レコード、800 KB。キー: `opcode`、`operand_format`（`BBB` など）、`operands`（`[{name,bits}]`）、`definition`（`R[a] = uvget(b,c)`）、
  `summary`（日本語 1〜2 文）、`usage_text`、`supplement_text`、`vm_impl`（`src/vm.c` の抜粋）、`dumps`、`article`、`since_tag` など。
  ページに入れるのは小さな部分集合（下記 4.5）。

## 1. VM 側（crate `sabiruby`）

### 1.1 DBG セクションを読む（行番号）

* `src/rite.rs`: `Irep` に `lines: Vec<(u32, u32)>`（`(pc, line)`、pc 昇順。ファイルをまたぐ irep は無視して 1 ファイル前提）と `filename: Option<Vec<u8>>` を足し、
  `b"DBG\0"` で本家 `read_debug_record` と同じ順に復号する。3 つの `line_type` すべてに対応する（`mrbc -g` が出すのは 4.1.0-rc では `packed_map`。
  `dump.c` `get_debug_record_size` で確かめる。他の 2 つも本家の `load.c` を写す）。失敗は LVAR と同じく best effort（無視）。
* `Irep::line_of(pc) -> Option<u32>`: `lines` を二分探索して、`pc` 以下で最大の `start_pos` の行（`mrb_debug_get_line` と同じ規則）。
* `VmIrep` に `lines`／`filename` を写す（`Vm::load`）。`Vm::current_line()`（最上位フレームの `irep`、`pc` から）。
* `vm::dump` の各命令行の先頭に行番号の列を足し、`mrbc --verbose` と同じ形（`    3 004 GETUPVAR`）にする。行番号が無い irep は空白。
  **既存のテストのうちダンプ文字列を見るもの**（このリポジトリの `test/api.mjs`、sabiruby の `tests/` で `dump` を使うもの）を直す。
* テスト（sabiruby `tests/`）: `tests/fixtures/closure.mrb` は `mrbc -g` ではないので、`tests/custom/` の `.mrb`（`-g` 付き。`tools/custom.sh`）で
  `line_of` の値が `mrbc --verbose` の行番号列と一致することを、`.dump` を Docker で取って比べる（`tools/fixtures.sh` の `--verbose` と同じ）。
  副産物: 後で `Exception#backtrace` の行番号にも使える（この指示書の範囲外）。

### 1.2 出来事の記録（trace）

`Vm` に `pub trace: Option<Vec<TraceEvent>>` を足す（`None` が既定。**命令ごとの経路には触らない**。出来事の場所（上記 0）で
`if let Some(t) = &mut self.trace { t.push(..) }` だけ。off のとき `Option` の判定 1 回が増えるのは出来事の場所だけで、ベンチ（`tools/bench.sh`）で差が出ないことを確かめる）。

```rust
// src/inspect.rs（新。no_std + alloc）
pub enum TraceEvent {
    EnvCreate  { env: ObjId, ctx: usize, frame: usize, base: usize, len: usize, mid: Option<Sym> },
    EnvDetach  { env: ObjId, len: usize, reason: DetachReason },       // FrameReturn | ContextSwept
    Raise      { exc: ObjId, class: Sym, frame: usize, irep: IrepId, pc: usize },
    CatchLook  { frame: usize, irep: IrepId, pc: usize, matched: Option<CatchHandlerInfo> }, // 表を引いた結果。None なら pop
    FrameUnwound { frame: usize, mid: Option<Sym>, by: UnwindBy },     // Raise | Break | Return
    FiberSwitch { from: usize, to: usize, kind: SwitchKind },          // Resume | Yield | Transfer | Terminate
    GcCollect  { before_live: usize, after_live: usize, swept: usize, allocated_since: usize },
}
```

* 生成場所: `frame_env`（EnvCreate）、`pop_frame` の `attached = false`（EnvDetach/FrameReturn）、GC sweep 1459（EnvDetach/ContextSwept）、
  `handle_raise` の入口（Raise）と各周回（CatchLook。`catch_find` の結果。`pop_frame` した周回は FrameUnwound/Raise）、
  `unwind_return`（FrameUnwound/Break または Return）、`switch_context`（FiberSwitch。`kind` は呼び出し側 `fiber_switch`／`fiber_yield`／`fiber_transfer`／`fiber_terminate` が渡す）、
  `gc_collect` の終わり（GcCollect）。
* `Vm::take_trace() -> Vec<TraceEvent>`（`Option` の中身を `mem::take`）。`Vm::set_trace(bool)`。
* テスト: `tests/inspect.rs`。`closure` fixture を trace on で走らせ、EnvCreate 1 件と EnvDetach（FrameReturn）1 件が `mk` の帰りに出ること。
  `exception` fixture で Raise→CatchLook（matched）の並び。`gem_fiber` 相当の小さなプログラムで FiberSwitch の from/to。GC ストレスで GcCollect が出ること。

### 1.3 スナップショット

```rust
pub struct Snapshot {
    pub cur: usize,
    pub contexts: Vec<ContextView>,          // contexts[cur] は Vm 側の stack/ci から作る（swap の向きに注意）
    pub pending_exc: Option<ValueView>,
    pub heap: HeapView,                      // len, live, free, allocated_since_gc, alloc_threshold, gc_count, live_after_gc, stress
    pub instructions: u64,
}
pub struct ContextView { pub status: FiberState, pub fiber: Option<ObjId>, pub frames: Vec<FrameView>, pub is_current: bool }
pub struct FrameView {
    pub irep: IrepId, pub pc: usize, pub line: Option<u32>, pub mid: Option<String>, pub target_class: String,
    pub base: usize, pub nregs: usize, pub nlocals: usize, pub cci: Cci, pub env: Option<EnvView>,
    pub regs: Vec<RegView>,                  // R0.. nregs。name は irep.lv（R1.. の名前、無ければ None）
}
pub struct RegView { pub index: usize, pub name: Option<String>, pub value: ValueView }
pub struct EnvView { pub id: ObjId, pub attached: bool, pub len: usize, pub ctx: usize, pub values: Vec<ValueView> /* detached のとき */ }
pub struct ValueView { pub text: String, pub class: String, pub id: Option<ObjId> }
```

* `Vm::snapshot(&self, regs_frames: usize) -> Snapshot`。`regs_frames` は「上から何フレームぶんレジスタを付けるか」（画面は 8 で呼ぶ。全フレームだと深い再帰で大きい）。
* **値の文字列化は Rust だけで行う** `fn render(&self, v: Value, depth: u8) -> ValueView`:
  nil／true／false／Integer／Float（`Float#to_s` と同じ書式の関数が numeric.rs にあるはず。無ければ `{:?}`）／Symbol（`:name`）／
  String（`inspect` 風に `"..."` でエスケープ、64 バイトで `...`）／Array（先頭 8 要素、depth 2 まで、`[1, 2, ...(+12)]`）／
  Hash（大きさと先頭 4 組）／Range／Proc（`#<Proc irep=N lambda env=#id>`）／Class・Module（名前）／Exception（`#<Class: message>`）／
  Fiber（状態）／Env（`#<Env len=N attached>`）／それ以外 `#<ClassName:0xID ivars=N>`。ネイティブメソッドは呼ばない。
* `ObjId` を JSON の `id` として出すのは、環境の欄とレジスタの欄で同じオブジェクトを線で結ぶため。
* テスト: `tests/inspect.rs`。`Vm::start` + `step(k)` の後に `snapshot(8)` を取り、`vm_closure` 相当のプログラムで
  最上位フレームの `regs[2].name == Some("l")` など、名前とレジスタ番号の対応を確かめる（`.mrb` は `-g` 付き）。

### 1.4 その他

* `Vm::op_counts` は命令バイト値の添字なので、`OP_NAMES` で名前に引ける関数 `Vm::op_histogram() -> Vec<(&'static str, u64)>`（0 の命令は省く）。
* `Vm::gc_collect()` は公開済み。ストレスは `set_gc_stress`。
* `cargo doc`、`tools/check_no_std.sh`、`cargo test --workspace`、CI が通ること。`docs/inspect.md`（新）に、記録する出来事、スナップショットの形、
  「Ruby を呼ばない」理由、実行ループに触っていないこと（ベンチの数字）を書く。README の docs 一覧に足す。

## 2. Playground 側: C ABI（`wasm/src/lib.rs`）

### 2.1 JSON

serde は入れない（サイズ。`docs/playground.md` の大きさの表が指標）。`wasm/src/json.rs` に 100 行程度の書き手（オブジェクト／配列／文字列のエスケープ／数値）を書き、
`Snapshot`／`TraceEvent` を手で書き出す。キー名はこの文書のフィールド名（snake_case）をそのまま使う。

### 2.2 追加する関数

| 関数 | 内容 |
|---|---|
| `sabi_trace(on: u32)` | `vm.set_trace(on != 0)` |
| `sabi_step_until(mode: u32, budget: u32) -> u32` | `mode` 0: 1 命令、1: 行が変わるまで（`current_line()` の変化、または呼び出し先へ入った／戻った）、2: フレームの深さが変わるまで（call／return）、3: `budget` 命令（= 今の `sabi_step`）。戻り値は `sabi_step` と同じ。**ループは Rust 側**（`vm.step(1)` を回す。JS 往復を避ける）。mode 1／2 でも上限 `budget` で止まる |
| `sabi_state(regs_frames: u32, len_out) -> ptr` | `vm.snapshot(regs_frames)` の JSON。実行中でないときは `{}` |
| `sabi_take_trace(len_out) -> ptr` | `vm.take_trace()` の JSON 配列 |
| `sabi_gc_collect() -> u32` | `vm.gc_collect()` |
| `sabi_gc_stress(on: u32)` | |
| `sabi_op_counts(len_out) -> ptr` | `[{"op":"MOVE","count":n},..]` |
| `sabi_dump_json(len_out) -> ptr` | ダンプを構造化: `{"offset": N, "ireps":[{"index":i,"nregs","nlocals","lv":[..],"catch":[..],"insns":[{"pc","line","op","a","b","c","text"}]}]}`。`offset` は `Vm::load` が返した root と `rite.root` の差（フレームの `irep` から表の添字を引くため）。文字列の `sabi_dump` は残す |

`sabi_start` は `offset` を `State` に覚える。

### 2.3 `web/sabi.js`

上の関数に対応するメソッド（`trace(on)`、`stepUntil(mode, budget)`、`state(n)`（JSON.parse 済み）、`takeTrace()`、`gcCollect()`、`gcStress(on)`、`opCounts()`、`dumpJson()`）。
`test/api.mjs` に追加: `state()` の形（`contexts[0].frames[0].regs[1].name`）、`stepUntil(1)` で行が進むこと、closure の trace に EnvCreate／EnvDetach、
`dumpJson().ireps[0].insns[0].line` が 1、`opCounts()` に `MOVE` があること。既存 14 件と fixtures はそのまま通ること。

## 3. Worker（`web/worker.js`）

メッセージを足す（既存の `run`／`inspect` は変えない）:

* `debug-start {src}`: reset → compile → start → `trace(1)` → `dumpJson` を返す（`{type:"debug", phase:"started", dump, state}`）。
* `debug-step {mode, budget}`: `stepUntil` → `{type:"debug", phase:"paused"|"finished"|"error", state, trace, output(bytes), text, stats}`。
  `mode` 3（続行）は `budget` を 1_000_000 にして `run` と同じく `output`／`progress` を流し、終わりに `state` を送る。
* `debug-gc {collect|stress:on}` → `{type:"debug", phase:"paused", state, trace}`。
* `debug-stop`: `reset()`。実行中の停止は今までどおり `terminate()`。

## 4. 画面（`web/index.html`、`web/main.js`、`web/style.css`）

### 4.1 操作

ヘッダの「実行」の隣に「デバッグ」トグル。on のとき「1 命令」「1 行」「呼び出し／戻り」「続行」「最初から」「停止」のボタン。キー: F10 = 1 行、F11 = 1 命令、F5 = 続行。
デバッグ中はエディタを読み取り専用にする（編集したら「最初から」で再コンパイル）。

### 4.2 強調表示

* バイトコード欄: `#dump` を `sabi_dump_json` から組み立てた行の要素（`<div data-irep data-pc>`）に変える（文字列表示のときと同じ見た目）。
  現在のフレームの `(irep - offset, pc)` の行に `.current`、その下のフレーム（呼び出し元）に `.caller`。自動スクロール。
  フレームの irep が `offset` より小さい（mrblib／gem の Ruby）ときは、欄の上に「mrblib の `Integer#times` を実行中」と出し、強調は呼び出し元に付ける。
* コード欄: CodeMirror の行装飾（`Decoration.line`）で現在行を強調。`tools/codemirror/entry.js` に `Decoration`／`StateField` の export を足して bundle を作り直す。
* AST 欄はデバッグ中そのまま。

### 4.3 「VM の状態」欄（新。実行結果の隣。狭い画面では下）

タブで切り替える。すべて `state`／`trace` の JSON から描く。

1. **フレーム**: callinfo を上（最上位）から表にする（`#`、メソッド名、ターゲットクラス、irep、pc、行、`cci`、env の有無）。選んだフレームのレジスタを
   `R0 self = main`、`R2 a = 11` の形で。値の `id` があるものは環境タブと同じ色。本の vm.re「メソッド呼び出し」の図に合わせて、`base` から `nregs` の範囲であることを注記。
2. **環境**（案 2）: いま生きている Env（フレームの `env` と、レジスタ／Proc から届く Env）を `#id`、`attached`／`detached`、`len`、持ち主のフレーム、値で並べる。
   `trace` の EnvCreate で行が増え、EnvDetach で「ヒープへ」に変わる（1 秒の色の変化）。`GETUPVAR`／`SETUPVAR` を実行した直後（`op` で分かる）は、
   `upper` を c 回たどった先の Env とレジスタ b を強調する（`state` のフレームの Proc → `upper` は `ProcData` から `render` に含める: `FrameView` に `proc: ProcView{upper, env}` を足す）。
3. **例外**（案 3）: 直近の Raise から始まる `trace` の並びを、フレームごとに「catch 表（begin／end／target）／pc／一致した行／pop」で表にする。
   一致した `rescue`／`ensure` を強調。`break`／`return` の非局所脱出（FrameUnwound by Break/Return）も同じ表。
4. **Fiber**（案 4）: `contexts` を列に。各列に状態、フレームの深さ、最上位フレームの行。`FiberSwitch` で `from` から `to` へ強調が移る。`is_current` の列に枠。
5. **GC**（案 5）: `heap` の数字（`len`、`live`、`free`、`allocated_since_gc`／`alloc_threshold`、`gc_count`、`live_after_gc`）、「今回収する」「ストレス」ボタン、
   `GcCollect` の履歴（before→after、swept）。ルートの一覧は「レジスタ（フレームの表）、グローバル（数）、定数、ネイティブ登録」の説明文でよい（値の一覧は出さない）。
6. **命令の統計**（案 6 の後半）: `opCounts` の度数分布（横棒）。実行の終わりと「続行」の後に更新。

### 4.4 opcode リファレンス（案 6）

バイトコード欄の命令名にホバー／タップで吹き出し: `definition`、`operand_format` と operand 名、`summary`。「本の記事」リンク（`article` の見出し名を表示。リンク先は `README` の本の URL）。
`web/opcodes.json` から引く（下記 4.5）。デバッグ中でなくても効く（ダンプ欄は常に構造化した表示にする）。

### 4.5 データ

`tools/opcodes.sh`: `../mruby-porting-kit/dataset/opcodes.jsonl`（MIT）から `opcode`、`operand_format`、`operands`、`definition`、`summary`、`article`、`since_tag` だけを抜いて
`web/opcodes.json` にする（119 件、数十 KB）。`web/opcodes.json` はコミットする（生成物だが CI にキットを checkout させない）。ページの脚注と `README` の License に
「opcode の説明は mruby-porting-kit の dataset（MIT）」を足す。

### 4.6 見本

`web/samples/index.json` の本の見本に「見どころ」を付ける（`note` 欄）: `vm_closure.rb`（環境タブ: `mk` の帰りで Env が detached になる）、
`cg_upvar.rb`（GETUPVAR の段数）、`cg_rescue.rb`（例外タブ）、`vm_fiber.rb`／`vm_fiber2.rb`（Fiber タブ）。GC 用に `gc_churn.rb`（配列を作っては捨てる 1,000 回。`GcCollect` が数回出る）を足す。
デバッグ開始時にその見本の「見どころ」をトーストで出す。

## 5. 検証

* sabiruby: `cargo test --workspace`（新規 `tests/inspect.rs` 含む）、`tools/check_no_std.sh`、`tools/bench.sh` で trace off の数字が変わらないこと（`docs/bench.md` の前回と比べて ±3% 以内。超えたら原因を書く）。
* Playground: `npm test`（fixtures 17 + api の既存 14 と追加分）、`npm run test:browser` に追加: 「デバッグ」→「1 行」を 3 回押して `#dump .current` が動くこと、
  「VM の状態」のフレーム表に `main` が出ること、`vm_closure.rb` で「続行」の後に環境タブに `detached` が 1 つあること、opcode の吹き出しが出ること。
* 大きさ: `tools/build.sh` の出力（gzip 後）を `docs/playground.md` の表に前後で書く。JSON 書き手と snapshot で数十 KB 増える見込み。100 KB を超えたら報告。
* 本家との一致の表示（案 7）はこの指示書の範囲外だが、既存の「本家 mruby の出力と比較」ボタンはデバッグ中も壊さない。

## 6. 順序と規模

1. VM 1.1（DBG）→ 1.3（snapshot）→ 2（ABI、api.mjs）→ 3／4.1／4.2／4.3-1（ステップ実行とフレーム表）。ここまでで案 1 が動く。1.5 日。
2. 1.2（trace）→ 4.3-2／3／4（環境、例外、Fiber）。1.5 日。
3. 4.3-5（GC）、4.3-6 と 4.4／4.5（統計と opcode 吹き出し）。1 日。
4. 4.6、`docs/playground.md` の更新、README、CI の固定コミット更新、公開（Pages）。半日。

## 7. 記録

* sabiruby: `docs/inspect.md`（新）、README の docs 一覧、`docs/bench.md`（trace off の再計測）。
* Playground: `docs/playground.md` に「デバッグ」節（ABI 表、メッセージ、欄、データの出所）と大きさの表の更新。`docs/ideas.md` の 1〜6 に「実装済み」と日付。
* 指示書から変えた点は理由付きで `docs/playground.md` に書く（`compiler-plan.md`→`compiler.md` と同じ形）。
* コミットは両リポジトリで分け、Playground の CI が指す sabiruby のコミットを更新する。push は著者が行う。

## 8. 範囲外

時間の巻き戻し（`Vm: Clone`）、停止中のメソッド再定義（eval）、本家 wasm との並走（`docs/ideas.md` 8）。`Exception#backtrace` への行番号の反映（DBG を読めば後は VM 側の作業）。
