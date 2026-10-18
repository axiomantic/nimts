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

## Quickstart: Vite Integration (Recommended)

The fastest and most modern way to build with NimTS is using the official Vite plugin. You import your `.nim` modules directly into your frontend code—Vite handles background WASM compilation, type generation, and hot module reloading automatically.

### Step 1: Configure Vite

Add the `nimtsPlugin` to your `vite.config.ts`:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { nimtsPlugin } from '@axiomantic/nimts/vite';

export default defineConfig({
  plugins: [
    nimtsPlugin()
  ]
});
```

### Step 2: Write Your Nim Module

Create `src/synth.nim`:

```nim
# src/synth.nim
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
```

### Step 3: Consume in Frontend Code (Direct vs. Worker)

NimTS supports two execution patterns depending on the computational cost of your code:
1. **Direct In-Thread Mode (`from './synth.nim'`)**: Runs directly on the calling thread (e.g. main UI thread or AudioWorklet). Best for instant synchronous math (< 1ms), real-time canvas rendering, or low-latency state mutations.
2. **Off-Thread Web Worker Mode (`from './synth.nim?worker'`)**: Spawns an isolated background Web Worker on a dedicated OS thread. Best for heavy algorithms, physics simulations, audio rendering, or ML inference.

> [!WARNING]
> **No Fake Async / Main Thread Blocking**  
> In WebAssembly, calling a function on the main UI thread executes synchronously on the browser's JavaScript event loop. Even if a Nim procedure returns a `Future[T]` (bridged to a JS `Promise<T>`), CPU-intensive computation on the main thread **will freeze the browser window, drop animation frames, and lock user input**. For any non-trivial computation (> 1ms), always use the `?worker` syntax to run on a true background thread!

#### Example: Consuming Both Patterns (`src/main.ts`)

You can import both patterns in the same application—or even the same file—depending on your performance needs:

```typescript
// src/main.ts
// =========================================================================
// Pattern 1: Direct in-thread import (Synchronous, instant, zero overhead)
// =========================================================================
import {
  initNimTs,
  addNumbers,
  greet,
  processBuffer,
  createEngine,
  setVolume
} from './synth.nim';

// =========================================================================
// Pattern 2: Off-thread Web Worker import (True parallel background thread)
// =========================================================================
import SynthWorker from './synth.nim?worker';

// -------------------------------------------------------------------------
// 1. Direct In-Thread Execution (Sub-nanosecond register speed)
// Use when: Operations take < 1ms, or updating real-time canvas/DOM state.
// CAUTION: Heavy computations here WILL freeze the browser window!
// -------------------------------------------------------------------------
await initNimTs();

// Instant synchronous calls directly into WASM registers
console.log('Direct sync result:', addNumbers(17, 25)); // 42
console.log(greet("TypeScript")); // "Hello, TypeScript from NimTS!"

// Direct binary buffer manipulation (Uint8Array)
const input = new Uint8Array([0x01, 0x02, 0x03]);
const output = processBuffer(input); // Uint8Array [ 171, 168, 169 ]

// Stateful handles and direct memory access
const engine = createEngine(48000.0);
setVolume(engine, 0.707);
engine.dispose(); // Explicit deterministic cleanup

// -------------------------------------------------------------------------
// 2. Off-Thread Web Worker Execution (Dedicated background OS thread)
// Use when: Audio processing, physics simulations, ONNX inference, heavy loops.
// Keeps the main UI thread running at 60/120 FPS with zero frame drops.
// -------------------------------------------------------------------------
const worker = await SynthWorker.spawn();

// Calls the exact same Nim function off-thread; returns an honest Promise
const workerSum = await worker.addNumbers(17, 25);
console.log('Worker async result:', workerSum); // 42

// Off-thread string and buffer operations
const greeting = await worker.greet('Worker Thread');
console.log(greeting);

// Graceful cleanup
worker.terminate();
```

---

### Alternative: Building the Frontend in Nim (`nim js`)

If you prefer writing your frontend UI entirely in Nim (using `nim js`, standard DOM manipulation, or UI frameworks like [Karax](https://github.com/karaxnim/karax)), you don't need TypeScript at all!

NimTS provides a client module (`nimts/js_client`) that allows your `nim js` frontend to load and call your high-performance `nimts` WASM module with native Nim signatures:

```nim
# src/frontend.nim
# Compile with: nim js -d:release -o:public/app.js src/frontend.nim
import std/[dom, asyncjs]
import nimts/js_client

# 1. Define the typed interface matching the WASM module's exports
type SynthExports = ref object of NimTsJsModule
  addNumbers*: proc(a, b: int32): int32 {.nimcall.}
  greet*: proc(name: cstring): cstring {.nimcall.}
  computeAsync*: proc(x: int32): PromiseJs[int32] {.nimcall.}

# 2. Main DOM entry point
proc main() {.async.} =
  # Load and initialize the WASM module
  let wasm = await loadNimTsExports[SynthExports]("/wasm/synth.wasm")

  let btn = document.getElementById("calc-btn")
  let output = document.getElementById("result-display")

  btn.addEventListener("click", proc(e: Event) =
    # Call high-speed WASM routines directly from your Nim JS code!
    let total = wasm.addNumbers(17, 25)
    output.textContent = "Computed in WASM: " & $total
  )

discard main()
```

This **Dual-Tier Nim Architecture** gives you the best of both worlds:
- **`nim js` Tier**: Full, lightweight access to the browser DOM, Web APIs, and UI components without any bundle bloat.
- **`nimts` WASM Tier**: Unrestricted 64-bit math, SIMD vectorization, WebGPU-aligned memory buffers, and raw C-speed performance.

For an in-depth breakdown of `nim js` limitations and architectural best practices, see the [Dual-Tier Nim Architecture Guide](./dual-tier-nim.md).

---

## Advanced Usage: Standalone CLI & Manual Compilation

If you are building outside of Vite (e.g. headless Node.js services, standalone CLI utilities, embedded systems, or custom build scripts), you can compile modules manually with the standalone `nimts` CLI tool.

### 1. Emit Glue Code at Compile Time

Add an `emitTsGlueFiles` statement to the bottom of your Nim file:

```nim
static:
  # Emits synth.d.ts and synth.js glue code at compile-time
  emitTsGlueFiles("synth", ".")
```

### 2. Compile to WebAssembly (Choosing Your Backend)

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

### 3. Consume the Generated ES Module

```typescript
// app.ts
import { initNimTs, addNumbers } from './synth.js';

await initNimTs();
console.log(addNumbers(17, 25));
```

---

## What's Next?

- Explore [Core Concepts](/guide/non-invasive-exports) to understand how `{.exportts.}` preserves native signatures without overhead.
- Learn about [Type Marshaling](/guide/type-marshaling) for numbers, strings, byte arrays, and value objects.
- Read how [Stateful Handles & GC](/guide/stateful-handles) manage `ref object` lifecycles safely.
- Check out the [Vite Integration](/guide/vite-plugin) to import `.nim` files directly without manual compilation steps.
