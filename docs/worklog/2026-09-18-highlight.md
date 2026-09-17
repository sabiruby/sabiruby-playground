# 2026-09-18 ブラウザ側の色付けの口 `sabi_highlight`（段階 H1）

`rubevy_games/docs/plans/editor-highlight-plan.md` の段階 H1。H0 で `sabiruby-compiler` に
入った `highlight()`（ソース 1 バイトにつき分類 1 バイト、0〜8）を、wasm モジュールの C ABI
とページ側の `sabi.js` に出す。使うのは playground 自身ではなく、この wasm を写して使う
rubevy_games のゲーム（H2）。**playground のエディタ（CodeMirror）は触っていない。**

## 先に読んだもの

計画書の §1 → §2（既定 4）→ §3.2 → §4 → §5 → §6、H0 の記録
（`sabiruby/docs/worklog/2026-09-18-highlight.md`）、`sabiruby/compiler/src/lib.rs` の
`highlight` の rustdoc。それから、この repo の `README.md`、`docs/README.md`、
`tools/build.sh`、`test/api.mjs`、`web/sabi.js`、`wasm/src/lib.rs`。

`highlight` は feature の後ろに隠れていない（`compiler/Cargo.toml` の features は `host` と
`ast` の 2 つで、`highlight` はどちらにも属していない）。`wasm/Cargo.toml` はすでに
`features = ["ast", "host"]` で compiler を引いているので、依存の記述は 1 文字も変えていない。

## 書いたもの

`wasm/src/lib.rs` に 2 つ。`sabi_highlight(src, len) -> u32` が分類し、結果を `State` に
持ち、`sabi_take_highlight(len_out) -> *const u8` が渡す。

「take の形」は `sabi_take_binary` に揃えた。つまり `give()` に渡して `st.ret` に移し、
**元は消さない**（`sabi_take_text` のほうは `std::mem::take` で空にする）。2 つの形のうち
binary 側を選んだのは、指示が名指ししているからというだけでなく、呼ぶ側が同じ表を 2 回
取りに来ても同じものが返るほうが、ホストが橋を書き間違えたときに黙って空表を色に変えずに
済むから。持ち物は `State` に `hl: Vec<u8>` を 1 つ。`bin` のような `Option` にしなかったのは、
「まだ解析していない」と「空のソースを解析した」を区別する意味がこの口には無いため（どちらも
長さ 0 の表が正しい答え）。

`sabi_highlight` は必ず 0 を返す。`highlight()` は失敗しない（構文エラーでも表が返る。上限も
無い。H0 の記録の「上限を置かなかった」の節）ので、`COMPILE_ERROR` を返す道が無い。返り値を
`u32` にしてあるのは計画書 §3.2 がそう決めているからで、rustdoc に「always 0」と書いた。

`web/sabi.js` の `highlight(src)` は `compile` + `binary` の形。

```js
  highlight(src) {
    const status = this.withBytes(src, (p, n) => this.x.sabi_highlight(p, n));
    return status === OK ? this.take(this.x.sabi_take_highlight) : new Uint8Array(0);
  }
```

`withBytes` が `sabi_free` するのは `sabi_highlight` が返ったあとで、そのときには表は
モジュール側にコピー済みなので、`take` を `withBytes` の外に出しても安全。`compile` と
`binary` を 2 回呼ぶ既存の使い方（`test/api.mjs` の binary の節）と同じ形にしたかったので、
1 つのメソッドの中で順に呼ぶ形にした。

## unsafe について

**新しい unsafe ブロックが 1 つ増えた。** 中身は `sabi_compile` / `sabi_ast` と 1 行 1 行
同じで、

```rust
// SAFETY: by the contract above.
let src = unsafe { std::slice::from_raw_parts(src, len) };
```

これ以外に C ABI でソースを受け取る書き方が無い（生ポインタを読むのは safe Rust に無い）。
`# Safety` の節と `// SAFETY:` の 1 行も既存の 2 つと同じ文面にした。H0 でも同じことが
起きていて（`compiler/src/lib.rs` から extern 関数を呼ぶ `unsafe` が 1 つ増えた）、
そこでの判断と揃えている。**「新しい unsafe を発明していない」であって「unsafe が増えて
いない」ではない**ので、ここに書いて報告にも上げた。増やさずに済ませる案は無かった
（計画書 §3.2 が `sabi_highlight(src, len)` という形を決めている）。

`sabi_take_highlight` のほうは `sabi_take_binary` と同じく `unsafe` を一切書いていない
（`len_out` への書き込みは既存の `give()` の中の unsafe が 1 つで済ませている）。

## 期待値は推測しない

テストに貼る数は 1 つも推測していない。モジュールを組んだあと、スクラッチパッドに
使い捨ての `probe.mjs` を置いて、テストに使う入力そのものを `sabi.js` 越しに食わせ、
返ってきた表を 1 バイト 1 桁で印字させ、その出力を `test/api.mjs` に貼った。

| 入力 | 表 |
|---|---|
| `def a; end` | `1110800111` |
| `tell :all` | `888805555` |
| `tell :all, "season", s` | `8888055550022222222000` |
| `def foo(` | `11108880` |
| `# 甲虫\np 1\n` | `3333333338040` |
| `""`（空） | 空 |

指示が名指ししていた 2 つ（`def a; end` の先頭 3 バイトが 1、`tell :all` の `tell` が 8）は
どちらも満たしている。`tell :all, "season", s` は H0 の記録の表（`8888055550022222222000`）と
バイト単位で一致した。つまり Rust の `highlight()` が返す表が、wasm と JS の間で 1 バイトも
ずれずに届いている。

`# 甲虫\np 1\n` を入れたのは、表がバイト単位であることをテストに残すため。`# 甲虫` は
UTF-8 で 9 バイトで、表もその 9 バイトぶんが 3 になる（`333333333`）。文字数で数えて
いたら 4 になっていた。これは H2 で egui に `&str` を渡すときに効く（計画書 §5 の 4）。

`def foo(` は、構文が閉じていなくても表が返ることのテスト。

`test/api.mjs` に 1 本（`highlight() gives one category byte per source byte`）。既存の
26 本のうちの 1 本として並べた。

## 組み直しと大きさ

`tools/build.sh` は変更なしで通った。wasi-sdk は `~/.local/wasi-sdk-34.0-x86_64-linux`（
スクリプトが既定で探す 2 つめの場所）にあり、`wasm-opt` は PATH に無かったので
`~/.local/binaryen-version_132/bin` を足して呼んだ。足さずに走らせると
「wasm-opt not found: copying the unoptimised module」で 2,744,107 バイトの素の
モジュールが web に置かれてしまう。CI（`pages.yml`）は binaryen 132 を落として PATH に
入れているので、そちらと同じ条件に合わせたことになる。

大きさは **同じ木を、export を足す前と後で組んで**測った。測り直して 2 回とも同じ値。

| | バイト | gzip -9 |
|---|---:|---:|
| `main` の `wasm/src/lib.rs`（`sabi_highlight` 無し） | 2,443,773 | 839,775 |
| この枝 | 2,445,509 | 840,268 |
| 差 | **+1,736** | **+493** |

+1,736 バイトは、`sabiruby-compiler` の `csrc/shim.c` の色付けの部分（`token_type_to_category`
の switch と木を歩く第 2 段）が、export が 1 つできたことでリンカに捨てられなくなった分。
`main` の側でそれが入っていないこと自体が、`-Oz` と LTO が効いている証拠でもある。

### README のサイズの行が古かった

README の「Numbers」の表は `sabiruby.wasm` を **1,303,895 バイト**と書いていたが、今の
モジュールは倍近い。どちらが本当かを確かめるために、公開されている実物の大きさを
HTTP で聞いた。

```
$ curl -sI https://sabiruby.github.io/sabiruby-playground/sabiruby.wasm
etag: "6aa8df6b-253a83"
last-modified: Tue, 15 Sep 2026 06:02:19 GMT
```

ETag の後半 `253a83` は 16 進で、**2,439,299 バイト**。つまり公開版はとっくに 2.4 MB で、
README の数字のほうが（デバッガや AST ペインより後の SabiRuby の成長を映しておらず）
古かった。ここで測った 2,443,773 との差 4,474 バイトは、CI が固定している SabiRuby
（`9fa5b0b`）とこちらの `7be7b86` の差と、ツールチェーンの版の差。

README の行は、今日測った 3 つ（この枝の値、`sabi_highlight` の増分、公開版の実測）に
書き換え、古い 3 つの値は「以前はもっと小さかった」として後ろに残した。捨てなかったのは、
あの 3 つは「デバッガの前 / AST ペインの前」という区切りの記録で、置き換えると読めなく
なるため。

## `SABIRUBY_REF` を進めた（計画書に無い変更）

`pages.yml` の `SABIRUBY_REF` は `9fa5b0b` で止まっていた。これは H0 の 3 コミットより前で、
`sabiruby_compiler::highlight` が**まだ存在しない**。このまま main に入れると、
`wasm/Cargo.toml` が path で引く `../../sabiruby` を CI が `9fa5b0b` で checkout するので、
**CI のビルドがコンパイルエラーで落ちる**。

計画書の既定 10 は `rubevy_games` の `PLAYGROUND_REF` を H2 で進めることだけを書いていて、
playground 自身の `SABIRUBY_REF` は抜けていた。`highlight()` を含む最も古いコミットは `4e1e1c8` だが、
それは H0 の枝の途中なので、枝がマージされた main の先端 `7be7b86` に進めた。これで
`9fa5b0b..7be7b86` の 117 コミット（0.5.0 のメソッドの可視性、0.5.1、perf3 の String と
命令ループ、mruby-task の 2 件、`sabiruby` 0.5.2）も一緒に公開版へ載る。**ここは本体の
判断が要るところなので報告に上げた。** 1 行なので戻すのは簡単。

副作用として `wasm/Cargo.lock` が `sabiruby` 0.4.0 → 0.5.2、`sabiruby-compiler` 0.2.1 →
0.2.3 に更新された（`cargo build` が自分で書き換えた。path 依存なので版が動くだけ）。
lock が 0.4.0 のままだったことからも、CI の固定と手元の checkout は前からずれていた。

README の「Pinned versions」の SabiRuby の行も `bbd0e58`（`sabiruby` 0.2.0 と書いてある）
のまま化石になっていたので、`pages.yml` が本物だと分かるように書き直した。

## 確認

* `npm test`（Node）: `18/18 fixtures match the reference output`、`26/26 checks`。
  新しい `highlight()` の 1 本を含む。
* `npm run test:browser`（Playwright + Chromium、`~/.cache/ms-playwright/chromium-1243`）:
  22 項目すべて ok、`no errors in the console` も ok、`all passed; page ready in 344 ms`。
  `SABIRUBY_REF` を進めたぶん VM が入れ替わっているので、この 22 本が通ったことは
  「0.5.2 でもページが同じように動く」の確認にもなっている。
* ブラウザの console から直接: `web/` を Node の静的サーバで配り、ページを開いて
  `run` ボタンが有効になるのを待ってから、ページの文脈で
  `const { Sabi } = await import("./sabi.js"); const sabi = await Sabi.create(await fetch("./sabiruby.wasm"));`
  として `sabi.highlight(...)` を呼んだ（`Sabi.create` は `Response` を受けて
  `instantiateStreaming` する道を持っている。ページ自身は `main.js` が
  `WebAssembly.Module` を作って worker に渡す形なので、そこは真似ずに、H2 のゲームの橋が
  やることに近い「ページ側で 1 つ作る」を再現した）。返ってきた表は Node と 1 バイトも
  同じで、`instanceof Uint8Array` も真、`pageerror` と `console.error` は 0 件。

```
{ "version": "SabiRuby 0.5.2 (7be7b86) / compiler: mruby 4.1.0-rc (3cf73ee), Prism 1.9.0",
  "def": "1110800111", "tell": "8888055550022222222000",
  "broken": "11108880", "ja": "3333333338040", "isU8": true }
problems: none
```

## やっていないこと

* playground の CodeMirror のエディタには触っていない（計画書 §3.2 の最後の行）。この口は
  出口だけで、このページ自身は誰も呼ばない。呼ぶのは H2 の `web/garden.html` /
  `web/sabibots.html` の橋。
* `docs/` の設計文書（`sabiruby/docs/design/playground.md`）の C ABI の一覧には
  `sabi_highlight` をまだ足していない。あれは別 repo（sabiruby）にあり、H1 の範囲外。
  この repo の README の一覧には足した。
* CI は走らせていない（push しない）。`pages.yml` の変更が正しいことは、手元で同じ
  `tools/build.sh` が同じ wasi-sdk 34 / binaryen 132 で通ったことまでしか確かめていない。
