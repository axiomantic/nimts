# Getting Started with NimTS

Welcome to **NimTS**, a bridge generator connecting **Nim** to **TypeScript** and **WebAssembly (WASM)**.

NimTS enables writing high-performance WebAssembly libraries in Nim with natural Nim signatures, companion C-ABI entry points, automatic `.d.ts` declaration generation, and modern TypeScript wrappers.

---

## Prerequisites

Before using NimTS, ensure your environment has the following installed:

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
     # Download wasi-sysroot
     WASI_VERSION=22
     wget https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VERSION}/wasi-sysroot-${WASI_VERSION}.0.tar.gz
     sudo tar -xzf wasi-sysroot-${WASI_VERSION}.0.tar.gz -C /usr/share/
     export WASI_SYSROOT=/usr/share/wasi-sysroot
     ```

---

## Installation

### In Your Nim Project (Nimble)

Add `nimts` to your `.nimble` file or install directly:

```bash
nimble install nimts
```

### In Your TypeScript / Frontend Project (npm)

```bash
npm install @axiomantic/nimts
```

> [!TIP]
> **Which do you need?**
> - **Full-Stack / Vite App (Most Common)**: You will use **both**. `nimble install nimts` installs the Nim macros, types, and compiler tools; `npm install @axiomantic/nimts` provides the Vite plugin (`@axiomantic/nimts/vite`) and runtime loader (`@axiomantic/nimts/runtime`).
> - **Nim Library Author**: If you are writing a Nim library that generates `.wasm` and `.d.ts` bundles for JavaScript users, you need `nimble install nimts` during development. When ready, you run `npm publish` to publish the resulting JavaScript/TypeScript artifacts to npm.
> - **Pure TypeScript Consumer**: If you are consuming a pre-compiled NimTS package published by someone else on npm, you only need `npm install <their-package>`.

---

## Quickstart: Building Your First Module

Let's write a module called `synth.nim` that exports synchronous procedures, byte processing, stateful handles, and an asynchronous coroutine.

### Step 1: Write the Nim Code

Create `synth.nim`:

```nim
# synth.nim
import std/asyncdispatch
import nimts

type
  AudioEngine* {.exportts.} = ref object
    sampleRate*: float32
    volume*: float32

# 1. Primitives: passed & returned directly via registers
proc addNumbers*(a: int32, b: int32): int32 {.exportts.} =
  a + b

# 2. Strings: UTF-8 marshaled automatically
proc greet*(name: string): string {.exportts.} =
  "Hello, " & name & " from NimTS!"

# 3. Binary buffers: maps directly to Uint8Array
proc processBuffer*(data: openArray[byte]): seq[byte] {.exportts.} =
  result = newSeq[byte](data.len)
  for i in 0 ..< data.len:
    result[i] = data[i] xor 0xAA'u8

# 4. Stateful handles for ref object instances
proc createEngine*(sampleRate: float32): AudioEngine {.exportts.} =
  AudioEngine(sampleRate: sampleRate, volume: 1.0'f32)

proc setVolume*(engine: AudioEngine, vol: float32) {.exportts.} =
  if engine != nil:
    engine.volume = vol

# 5. Non-blocking async coroutine: Future[T] -> JS Promise<T>
proc computeAsync*(x: int32): Future[int32] {.async, exportts.} =
  return x * 42

static:
  # Emits synth.d.ts and synth.js glue code at compile-time
  emitTsGlueFiles("synth", ".")
```

### Step 2: Compile to WebAssembly (Choosing Your Backend)

Compile the Nim file into a WebAssembly binary. You can choose between two compilation backends depending on your deployment target:

```bash
# 1. Standalone micro-WASM (Default)
# Uses LLVM clang + wasm-ld + wasi-sysroot. Produces minimal, zero-bloat WASM
# ideal for AudioWorklets, Web Workers, and lightweight web apps:
nimts compile synth.nim synth.wasm

# 2. Emscripten Runtime Backend
# Uses emcc with virtual filesystem (FS), POSIX shims, and modularized ES6 output.
# Ideal if your code depends on legacy C libraries expecting file I/O or full POSIX libc:
nimts compile synth.nim synth.wasm --backend:emscripten
```

This generates:
- `synth.wasm`: WebAssembly binary.
- `synth.d.ts`: Full TypeScript type declarations for all exported types and functions.
- `synth.js`: Modern ES module with memory allocation, handle tracking, and promise bridging (identical TypeScript interface across both backends).

### Step 3: Consume in TypeScript

```typescript
// app.ts
import {
  initNimTs,
  addNumbers,
  greet,
  processBuffer,
  createEngine,
  setVolume,
  computeAsync
} from './synth.js';

// 1. Initialize the WebAssembly module
await initNimTs();

// 2. Call synchronous functions
console.log(addNumbers(17, 25)); // 42
console.log(greet("TypeScript")); // "Hello, TypeScript from NimTS!"

// 3. Process binary buffers
const input = new Uint8Array([0x01, 0x02, 0x03]);
const output = processBuffer(input); // Uint8Array [ 171, 168, 169 ]

// 4. Manage stateful instances
const engine = createEngine(48000.0);
setVolume(engine, 0.707);
engine.dispose(); // Explicit deterministic cleanup

// 5. Await asynchronous Nim coroutines
const answer = await computeAsync(10);
console.log(answer); // 420
```

---

## What's Next?

- Explore [Core Concepts](/guide/non-invasive-exports) to understand how `{.exportts.}` preserves native signatures without overhead.
- Learn about [Type Marshaling](/guide/type-marshaling) for numbers, strings, byte arrays, and value objects.
- Read how [Stateful Handles & GC](/guide/stateful-handles) manage `ref object` lifecycles safely.
- Check out the [Vite Integration](/guide/vite-plugin) to import `.nim` files directly without manual compilation steps.
