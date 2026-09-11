#!/bin/bash
# Builds web/sabiruby.wasm: SabiRuby + the reference mruby compiler for wasm32-wasip1.
#   tools/build.sh
# Needs: rustup target wasm32-wasip1; wasi-sdk (WASI_SDK_PATH, default /opt/wasi-sdk or
# ~/.local/wasi-sdk-34.0-x86_64-linux); wasm-opt from binaryen on PATH (optional, shrinks).
# The sabiruby repository is expected next to this one (../sabiruby), see README.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${WASI_SDK_PATH:-}" ]; then
  for d in /opt/wasi-sdk "$HOME/.local/wasi-sdk-34.0-x86_64-linux"; do [ -x "$d/bin/clang" ] && WASI_SDK_PATH=$d && break; done
fi
[ -x "${WASI_SDK_PATH:-}/bin/clang" ] || { echo "wasi-sdk not found: set WASI_SDK_PATH" >&2; exit 1; }
export CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang" AR_wasm32_wasip1="$WASI_SDK_PATH/bin/llvm-ar"
(cd wasm && cargo build --release)
out=wasm/target/wasm32-wasip1/release/sabiruby_wasm.wasm
if command -v wasm-opt >/dev/null; then
  # the module uses Wasm exception handling (legacy) for the compiler's setjmp/longjmp
  wasm-opt -Oz --enable-exception-handling --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals "$out" -o web/sabiruby.wasm
else
  echo "wasm-opt not found: copying the unoptimised module" >&2
  cp "$out" web/sabiruby.wasm
fi
raw=$(wc -c < web/sabiruby.wasm); gz=$(gzip -9 -c web/sabiruby.wasm | wc -c)
echo "web/sabiruby.wasm: $raw bytes ($gz gzipped)"
