#!/usr/bin/env bash
# scripts/compile_wasm.sh - Compiles a Nim module into a standalone .wasm binary
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT_NIM="${1:-${ROOT_DIR}/tests/fixtures/test_module.nim}"
OUTPUT_WASM="${2:-${ROOT_DIR}/tests/fixtures/test_module.wasm}"
NIMCACHE_DIR="${3:-${ROOT_DIR}/tests/fixtures/nimcache}"

if [[ -z "${CLANG_BIN:-}" ]]; then
  if [[ -x "/opt/homebrew/opt/llvm/bin/clang" ]]; then
    CLANG_BIN="/opt/homebrew/opt/llvm/bin/clang"
  else
    CLANG_BIN="$(command -v clang || echo "")"
  fi
fi

if [[ -z "${WASM_LD_BIN:-}" ]]; then
  if [[ -x "/opt/homebrew/bin/wasm-ld" ]]; then
    WASM_LD_BIN="/opt/homebrew/bin/wasm-ld"
  else
    WASM_LD_BIN="$(command -v wasm-ld || echo "")"
  fi
fi

if [[ -z "${WASI_SYSROOT:-}" ]]; then
  if [[ -d "/opt/homebrew/share/wasi-sysroot" ]]; then
    WASI_SYSROOT="/opt/homebrew/share/wasi-sysroot"
  elif [[ -d "/usr/share/wasi-sysroot" ]]; then
    WASI_SYSROOT="/usr/share/wasi-sysroot"
  else
    WASI_SYSROOT=""
  fi
fi

NIM_LIB="$(nim dump 2>&1 | grep "lib$" | head -1 || echo "")"
if [[ -z "${NIM_LIB}" || ! -d "${NIM_LIB}" ]]; then
  NIM_LIB="/Users/eek/.local/share/mise/installs/nim/2.2.12/lib"
fi

if [[ -z "${CLANG_BIN}" || ! -x "${CLANG_BIN}" ]]; then
  echo "Error: clang was not found at '${CLANG_BIN}'" >&2
  exit 1
fi

if [[ -z "${WASM_LD_BIN}" || ! -x "${WASM_LD_BIN}" ]]; then
  echo "Error: wasm-ld was not found at '${WASM_LD_BIN}'" >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT_WASM}")"
rm -rf "${NIMCACHE_DIR}"
mkdir -p "${NIMCACHE_DIR}"

echo "==> 1. Generating C sources from ${INPUT_NIM} via Nim..."
nim c -c -d:emscripten -d:danger --opt:speed --panics:on --checks:off --cpu:wasm32 \
  -p:"${ROOT_DIR}/src" \
  --nimcache:"${NIMCACHE_DIR}" \
  "${INPUT_NIM}"

echo "==> 2. Compiling builtins_wasm.c..."
"${CLANG_BIN}" --target=wasm32-wasip1 --sysroot="${WASI_SYSROOT}" -O3 -flto -mbulk-memory \
  -c "${ROOT_DIR}/c_src/builtins_wasm.c" -o "${NIMCACHE_DIR}/builtins_wasm.o"

echo "==> 3. Compiling Nim C sources to wasm object files..."
for f in "${NIMCACHE_DIR}"/*.c; do
  "${CLANG_BIN}" --target=wasm32-wasip1 --sysroot="${WASI_SYSROOT}" \
    -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL \
    -O3 -flto -mbulk-memory -I"${NIM_LIB}" \
    -c -o "${f}.o" -- "${f}"
done

echo "==> 4. Linking standalone ${OUTPUT_WASM} via wasm-ld..."
"${WASM_LD_BIN}" --no-entry --export-all --allow-undefined --lto-O3 \
  -L"${WASI_SYSROOT}/lib/wasm32-wasip1" -lc -lwasi-emulated-mman -lwasi-emulated-signal \
  -o "${OUTPUT_WASM}" \
  "${NIMCACHE_DIR}"/*.o

echo "==> Build successful: ${OUTPUT_WASM} ($(du -h "${OUTPUT_WASM}" | cut -f1))"
