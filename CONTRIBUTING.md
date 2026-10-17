# Contributing to NimTS

Thank you for your interest in contributing to **NimTS**!

NimTS bridges **Nim** to **TypeScript** and **WebAssembly**, providing seamless zero-overhead exports, stateful object handles, asynchronous Future/Promise bridging, and Vite bundling.

---

## Prerequisites

To build and test NimTS locally, you will need:

1. **Nim** (version 2.0.0 or later, tested with 2.2+)
   - Install via [choosenim](https://github.com/dom96/choosenim) or [mise](https://mise.jdx.dev/).
2. **Node.js** (version 20.x or later) and **npm**
3. **LLVM & WebAssembly Toolchain**:
   - **macOS**:
     ```bash
     brew install llvm wasi-sysroot
     ```
   - **Ubuntu / Debian**:
     ```bash
     sudo apt-get install -y clang lld llvm
     # Install wasi-sysroot
     WASI_VERSION=22
     wget https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VERSION}/wasi-sysroot-${WASI_VERSION}.0.tar.gz
     sudo tar -xzf wasi-sysroot-${WASI_VERSION}.0.tar.gz -C /usr/share/
     export WASI_SYSROOT=/usr/share/wasi-sysroot
     ```

---

## Local Setup

```bash
# Clone the repository
git clone https://github.com/axiomantic/nimts.git
cd nimts

# Install Node dependencies
npm install

# Build TypeScript wrappers and Vite plugin
npm run build
```

---

## Running Tests

NimTS has a dual-layer test suite covering both native Nim mechanics and WebAssembly runtime integration.

### 1. Nim Unit & Macro Tests (Nimble)
Tests that `{.exportts.}` preserves 100% native compatibility without runtime overhead, tests memory allocators, handle registries, and codegen:
```bash
nimble test
```

### 2. TypeScript & WebAssembly Tests (Vitest)
Tests real WASM module loading, sync/async calls, error propagation, handles, and the Vite plugin:
```bash
npm test
```

### 3. Recompiling the Test WASM Module
When modifying `tests/fixtures/test_module.nim`:
```bash
./scripts/compile_wasm.sh
```
This compiles the Nim code into `test_module.wasm` and generates `test_module.js` and `test_module.d.ts`.

---

## Repository Structure

```
nimts/
├── src/
│   ├── nimts.nim             # Main Nim entry point & CLI
│   └── nimts/
│       ├── types.nim         # HandleId, PromiseId, FutureId, NimTsHandle[T]
│       ├── memory.nim        # Buffer marshaling, alloc/free, handle registry
│       ├── async_bridge.nim  # Bidirectional Future <-> Promise bridge
│       ├── codegen.nim       # .d.ts and .js code generation
│       └── macros.nim        # {.exportts.}, exportTs(), importts, emitTsGlueFiles
├── ts/
│   ├── index.ts              # Package entry point
│   ├── runtime.ts            # NimTsRuntime browser/node WebAssembly runner
│   └── vite-plugin-nimts.ts  # Vite plugin for direct .nim imports
├── c_src/
│   └── builtins_wasm.c       # Clean-room 128-bit compiler-rt helpers for wasm32
├── scripts/
│   └── compile_wasm.sh       # Standalone wasm32 compilation script
└── tests/                    # Nim and TypeScript test suites
```

---

## Pull Request Checklist

Before submitting a pull request, please ensure:
- [ ] `nimble check` passes.
- [ ] `nimble test` passes with zero warnings.
- [ ] `npm run build` succeeds cleanly.
- [ ] `npm test` passes all tests.
- [ ] `npm pack --dry-run` succeeds without missing files.
