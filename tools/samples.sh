#!/bin/bash
# Copies the samples into web/samples/ and writes web/samples/index.json.
#   tools/samples.sh    # SABIRUBY=../sabiruby KIT=../mruby-porting-kit by default
# fixtures/: SabiRuby's reference fixtures, each with the reference mruby's stdout (.out)
# book/:     the scripts the book's examples are taken from (mruby porting kit, samples/)
set -eu
cd "$(dirname "$0")/.."
SABIRUBY=${SABIRUBY:-../sabiruby}
KIT=${KIT:-../mruby-porting-kit}
rm -rf web/samples && mkdir -p web/samples/fixtures web/samples/book
cp "$SABIRUBY"/tests/fixtures/*.rb "$SABIRUBY"/tests/fixtures/*.out web/samples/fixtures/
for f in "$KIT"/samples/{overview,vm,corelib,gc,cg}_*.rb; do cp "$f" web/samples/book/; done
cp tools/samples/*.rb web/samples/book/   # examples of this repository (the GC tab needs one)
node -e '
const fs = require("fs");
const list = (d, ext) => fs.readdirSync("web/samples/" + d).filter(f => f.endsWith(".rb")).sort().map(f => f.slice(0, -3));
const fixtures = list("fixtures").map(n => ({ name: n, path: "samples/fixtures/" + n + ".rb", expected: "samples/fixtures/" + n + ".out" }));
// What to watch in the debugger; shown as a toast when debugging starts (docs/playground.md).
const notes = {
  vm_closure: "スコープタブ: mk が返るときに Env がヒープへ移る（detached）",
  cg_upvar:   "バイトコード欄の GETUPVAR と、スコープタブの上位環境のたどり方",
  cg_rescue:  "例外タブ: raise から catch 表を引いて rescue に着くまで",
  vm_fiber:   "Fiber タブ: resume と yield で実行中の context が入れ替わる",
  vm_fiber2:  "Fiber タブ: 二つの Fiber と root の間の切り替え",
  gc_churn:   "GC タブ: live と allocated_since_gc、回収の履歴",
};
const book = list("book").map(n => ({ name: n, path: "samples/book/" + n + ".rb", ...(notes[n] ? { note: notes[n] } : {}) }));
fs.writeFileSync("web/samples/index.json", JSON.stringify({ fixtures, book }, null, 1) + "\n");
console.log(`samples: ${fixtures.length} fixtures, ${book.length} book examples`);
'
