#!/bin/bash
# Extracts the small part of the book's opcode dataset that the page shows in the tooltip of
# the bytecode pane into web/opcodes.json (committed, so CI needs no checkout of the kit).
#   tools/opcodes.sh          # KIT=../mruby-porting-kit by default
# Source: mruby-porting-kit dataset/opcodes.jsonl (MIT, see its dataset/LICENSE).
set -eu
cd "$(dirname "$0")/.."
KIT=${KIT:-../mruby-porting-kit}
node -e '
const fs = require("fs");
const src = process.argv[1] + "/dataset/opcodes.jsonl";
const out = {};
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  out[r.opcode] = {
    format: r.operand_format,
    operands: (r.operands || []).map(o => o.name + ":" + o.bits),
    definition: r.definition,
    summary: r.summary,
    since: r.since_tag,
    article: r.article ? r.article.replace(/^sub-article\//, "").replace(/\.re$/, "") : null,
  };
}
fs.writeFileSync("web/opcodes.json", JSON.stringify(out) + "\n");
console.log(`web/opcodes.json: ${Object.keys(out).length} opcodes, ${fs.statSync("web/opcodes.json").size} bytes`);
' "$KIT"
