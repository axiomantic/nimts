#!/usr/bin/env bash
# scripts/compile_wasm.sh - Compiles a Nim module into a standalone .wasm binary
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKEND="${NIMTS_BACKEND:-standalone}"
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend:*)
      BACKEND="${1#--backend:}"
      shift
      ;;
    --backend=*)
      BACKEND="${1#--backend=}"
      shift
      ;;
    --backend)
      BACKEND="$2"
      shift 2
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "${BACKEND}" != "standalone" && "${BACKEND}" != "emscripten" ]]; then
  echo "Error: Unknown backend '${BACKEND}'. Supported backends: 'standalone' (default) and 'emscripten'." >&2
  exit 1
fi

INPUT_NIM="${POSITIONAL_ARGS[0]:-${ROOT_DIR}/tests/fixtures/test_module.nim}"
OUTPUT_WASM="${POSITIONAL_ARGS[1]:-${ROOT_DIR}/tests/fixtures/test_module.wasm}"
NIMCACHE_DIR="${POSITIONAL_ARGS[2]:-${ROOT_DIR}/tests/fixtures/nimcache}"

NIM_LIB="$(nim dump 2>&1 | grep "lib$" | head -1 || echo "")"
if [[ -z "${NIM_LIB}" || ! -d "${NIM_LIB}" ]]; then
  NIM_BIN="$(command -v nim || echo "")"
  if [[ -n "${NIM_BIN}" ]]; then
    CANDIDATE="$(dirname "$(dirname "$(readlink -f "${NIM_BIN}" 2>/dev/null || realpath "${NIM_BIN}" 2>/dev/null || echo "${NIM_BIN}")")")/lib"
    if [[ -d "${CANDIDATE}" ]]; then
      NIM_LIB="${CANDIDATE}"
    fi
  fi
fi

mkdir -p "$(dirname "${OUTPUT_WASM}")"
rm -rf "${NIMCACHE_DIR}"
mkdir -p "${NIMCACHE_DIR}"

if [[ "${BACKEND}" == "emscripten" ]]; then
  if [[ -z "${EMCC_BIN:-}" ]]; then
    if [[ -x "/opt/homebrew/bin/emcc" ]]; then
      EMCC_BIN="/opt/homebrew/bin/emcc"
    else
      EMCC_BIN="$(command -v emcc || echo "")"
    fi
  else
    EMCC_BIN="$(command -v "${EMCC_BIN}" || echo "${EMCC_BIN}")"
  fi

  if [[ -z "${EMCC_BIN}" || ! -x "${EMCC_BIN}" ]]; then
    echo "Error: emcc (Emscripten compiler) was not found." >&2
    echo "To use the Emscripten backend, please install and activate the Emscripten SDK (emsdk):" >&2
    echo "  git clone https://github.com/emscripten-core/emsdk.git" >&2
    echo "  ./emsdk/emsdk install latest && ./emsdk/emsdk activate latest" >&2
    echo "  source ./emsdk/emsdk_env.sh" >&2
    echo "Or install via Homebrew on macOS: brew install emscripten" >&2
    exit 1
  fi

  echo "==> [Backend: Emscripten] 1. Generating C sources from ${INPUT_NIM} via Nim..."
  nim c -c -d:emscripten -d:release --opt:speed --cpu:wasm32 \
    -p:"${ROOT_DIR}/src" \
    --nimcache:"${NIMCACHE_DIR}" \
    "${INPUT_NIM}"

  echo "==> [Backend: Emscripten] 2. Compiling and linking with emcc..."
  OUTPUT_JS="${OUTPUT_WASM%.wasm}.emscripten.js"
  "${EMCC_BIN}" -O3 \
    -sEXPORT_ALL=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sFORCE_FILESYSTEM=1 \
    -I"${NIM_LIB}" \
    -o "${OUTPUT_JS}" \
    "${NIMCACHE_DIR}"/*.c

  EMCC_WASM="${OUTPUT_JS%.js}.wasm"
  if [[ -f "${EMCC_WASM}" && "${EMCC_WASM}" != "${OUTPUT_WASM}" ]]; then
    cp -f "${EMCC_WASM}" "${OUTPUT_WASM}"
  fi

  echo "==> Emscripten build successful:"
  echo "    WASM binary: ${OUTPUT_WASM} ($(du -h "${OUTPUT_WASM}" | cut -f1))"
  echo "    JS runtime:  ${OUTPUT_JS} ($(du -h "${OUTPUT_JS}" | cut -f1))"
  exit 0
fi

# Standalone backend (Clang + wasm-ld + wasi-sysroot)
if [[ -z "${CLANG_BIN:-}" ]]; then
  if [[ -x "/opt/homebrew/opt/llvm/bin/clang" ]]; then
    CLANG_BIN="/opt/homebrew/opt/llvm/bin/clang"
  else
    CLANG_BIN="$(command -v clang || echo "")"
  fi
else
  CLANG_BIN="$(command -v "${CLANG_BIN}" || echo "${CLANG_BIN}")"
fi

if [[ -z "${WASM_LD_BIN:-}" ]]; then
  if [[ -x "/opt/homebrew/bin/wasm-ld" ]]; then
    WASM_LD_BIN="/opt/homebrew/bin/wasm-ld"
  else
    WASM_LD_BIN="$(command -v wasm-ld || echo "")"
  fi
else
  WASM_LD_BIN="$(command -v "${WASM_LD_BIN}" || echo "${WASM_LD_BIN}")"
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

if [[ -z "${CLANG_BIN}" || ! -x "${CLANG_BIN}" ]]; then
  echo "Error: clang was not found at '${CLANG_BIN}'" >&2
  exit 1
fi

if [[ -z "${WASM_LD_BIN}" || ! -x "${WASM_LD_BIN}" ]]; then
  echo "Error: wasm-ld was not found at '${WASM_LD_BIN}'" >&2
  exit 1
fi

echo "==> [Backend: Standalone] 1. Generating C sources from ${INPUT_NIM} via Nim..."
nim c -c -d:emscripten -d:release --opt:speed --cpu:wasm32 \
  -p:"${ROOT_DIR}/src" \
  --nimcache:"${NIMCACHE_DIR}" \
  "${INPUT_NIM}"

echo "==> [Backend: Standalone] 2. Compiling builtins_wasm.c..."
"${CLANG_BIN}" --target=wasm32-wasip1 --sysroot="${WASI_SYSROOT}" -O3 -flto -mbulk-memory \
  -c "${ROOT_DIR}/c_src/builtins_wasm.c" -o "${NIMCACHE_DIR}/builtins_wasm.o"

echo "==> [Backend: Standalone] 3. Compiling Nim C sources to wasm object files..."
for f in "${NIMCACHE_DIR}"/*.c; do
  "${CLANG_BIN}" --target=wasm32-wasip1 --sysroot="${WASI_SYSROOT}" \
    -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL \
    -O3 -flto -mbulk-memory -I"${NIM_LIB}" \
    -c -o "${f}.o" -- "${f}"
done

echo "==> [Backend: Standalone] 4. Linking standalone ${OUTPUT_WASM} via wasm-ld..."
"${WASM_LD_BIN}" --no-entry --export-all --allow-undefined --lto-O3 \
  --initial-memory=16777216 --max-memory=2147483648 \
  --export=NimMain --export=nimts_init \
  -L"${WASI_SYSROOT}/lib/wasm32-wasip1" -lc -lwasi-emulated-mman -lwasi-emulated-signal \
  -o "${OUTPUT_WASM}" \
  "${NIMCACHE_DIR}"/*.o

echo "==> Standalone build successful: ${OUTPUT_WASM} ($(du -h "${OUTPUT_WASM}" | cut -f1))"
