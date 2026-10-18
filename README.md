# NimTS: Seamless TypeScript & WebAssembly Bridge for Nim

[![CI](https://github.com/axiomantic/nimts/actions/workflows/ci.yml/badge.svg)](https://github.com/axiomantic/nimts/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-GitHub_Pages-blue.svg)](https://axiomantic.github.io/nimts/)
[![npm version](https://img.shields.io/npm/v/@axiomantic/nimts.svg)](https://www.npmjs.com/package/@axiomantic/nimts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Nimble](https://img.shields.io/badge/nimble-nimts-orange.svg)](https://nimble.directory/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/axiomantic/nimts/pulls)

**NimTS** is a zero-friction bridge connecting **Nim** to **TypeScript** and **WebAssembly (WASM)**.

Write high-performance WebAssembly in Nim with natural signatures, companion C-ABI entry points, automatic `.d.ts` declaration generation, and modern TypeScript wrappers.

📖 **Full Documentation & Interactive Guides**: [https://axiomantic.github.io/nimts/](https://axiomantic.github.io/nimts/)

---

## Key Highlights

- ⚡ **Zero-Overhead `{.exportts.}`**: Preserves native Nim signatures. Procs remain 100% callable by native Nim CLI tools, VST/CLAP audio plugins, and native unit tests with zero overhead.
- 🧵 **Multi-Threaded Web Worker Runtime (`@axiomantic/nimts/worker`)**: Run CPU/DSP algorithms in dedicated background threads via `spawnWorker` or Vite's `?worker` query. Transparent typed async proxying, automatic `Future[T]` awaiting, and true zero-copy `ArrayBuffer` detachment via Transferable objects.
- 🔄 **Bidirectional Async Bridge**: Automatically bridges Nim `Future[T]` and JavaScript `Promise<T>` without blocking the main browser thread.
- 🎛️ **Stateful Handles with GC**: Exports `ref object` instances as type-safe opaque handles with automatic garbage collection via JavaScript's `FinalizationRegistry` and deterministic manual `.dispose()`.
- 🔁 **Closure Iterators & SPSC Channels**: Stream data from Nim closures as standard ES2015 `IterableIterator<T>` (`for..of`) and lock-free SPSC channels (`Channel[T]`) as `AsyncIterable<T>` (`for await..of`).
- 📦 **Vite Plugin**: Import `.nim` and `.nim?worker` files directly into your frontend code with background compilation and hot module reloading.
- 🎮 **WebGPU Zero-Copy Storage Buffers**: Hardware-aligned 256-byte allocators (`nimts_alloc_aligned`) and `GpuBufferSlice[T]` for direct, zero-copy `device.queue.writeBuffer` transfers into WebGPU compute pipelines.
- 🏛️ **Dual-Tier Nim Architecture (`nimts/js_client`)**: Write reactive DOM UI in `nim js` and heavy compute in `nim wasm`, communicating seamlessly with zero handwritten JS/TS glue.

---

## Prerequisites

1. **Nim** (version 2.0.0 or later, tested with 2.2+)
2. **Node.js** (version 20.x or later) and **npm**
3. **LLVM & WebAssembly Toolchain**:
   - **macOS**: `brew install llvm wasi-sysroot`
   - **Ubuntu/Debian**: `sudo apt-get install clang lld llvm` + `wasi-sysroot` (or Emscripten SDK `emsdk`)

---

## Installation

### In Your Nim Project (Nimble)
```bash
nimble install nimts
```

### In Your TypeScript / Frontend Project (npm)
```bash
npm install @axiomantic/nimts
```

> **Which do you need?**
> - **Vite / Full-Stack App (Most Common)**: Install **both**. Nimble provides the compiler tools & macros; npm provides the Vite plugin (`@axiomantic/nimts/vite`) and runtime (`@axiomantic/nimts/runtime`).
> - **Pure TypeScript Consumer**: Only `npm install <published-nimts-package>`.

---

## Quickstart: Vite Integration (Recommended)

The fastest and most modern way to build with NimTS is using the official Vite plugin. Import your `.nim` modules directly into frontend code—Vite handles WASM compilation, type generation, and HMR automatically.

### Step 1: Configure Vite (`vite.config.ts`)

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

### Step 2: Write Your Nim Module (`src/synth.nim`)

```nim
# src/synth.nim
import std/asyncdispatch
import nimts

type
  AudioEngine* {.exportts.} = ref object
    sampleRate*: float32
    volume*: float32

# 1. Primitives: passed & returned directly via WASM registers
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

### Step 3: Consume in Frontend Code (`src/main.ts`)

NimTS supports both direct in-thread execution and off-thread Web Worker execution:

```typescript
// src/main.ts
// Pattern 1: Direct in-thread import (Synchronous, instant, zero overhead)
import {
  initNimTs,
  addNumbers,
  greet,
  processBuffer,
  createEngine,
  setVolume
} from './synth.nim';

// Pattern 2: Off-thread Web Worker import (Dedicated background thread)
import SynthWorker from './synth.nim?worker';

// --- 1. Direct In-Thread Execution ---
// Best for: Quick operations (< 1ms), instant math, canvas/WebGL loops.
await initNimTs();

console.log('Direct sync result:', addNumbers(17, 25)); // 42
console.log(greet("TypeScript")); // "Hello, TypeScript from NimTS!"

const input = new Uint8Array([0x01, 0x02, 0x03]);
const output = processBuffer(input); // Uint8Array [ 171, 168, 169 ]

const engine = createEngine(48000.0);
setVolume(engine, 0.707);
engine.dispose(); // Explicit cleanup, or automatic GC via FinalizationRegistry

// --- 2. Off-Thread Web Worker Execution ---
// Best for: Heavy algorithms, physics simulations, DSP, ONNX/ML inference.
// Keeps the main UI thread running at 60/120 FPS without dropped frames.
const worker = await SynthWorker.spawn();

// Calls the exact same Nim function off-thread; returns a Promise
const workerSum = await worker.addNumbers(17, 25);
console.log('Worker async result:', workerSum); // 42

worker.terminate();
```

---

### Alternative: Building the Frontend in Nim (`nim js`)

Prefer writing your frontend UI entirely in Nim (`nim js`, standard DOM, or [Karax](https://github.com/karaxnim/karax))? You don't need TypeScript!

NimTS provides `nimts/js_client` for consuming high-speed `nimts` WASM from `nim js` with native signatures:

```nim
# src/frontend.nim (compile with: nim js -d:release -o:public/app.js src/frontend.nim)
import std/[dom, asyncjs]
import nimts/js_client

type SynthExports = ref object of NimTsJsModule
  addNumbers*: proc(a, b: int32): int32 {.nimcall.}
  greet*: proc(name: cstring): cstring {.nimcall.}
  computeAsync*: proc(x: int32): PromiseJs[int32] {.nimcall.}

proc main() {.async.} =
  let wasm = await loadNimTsExports[SynthExports]("/wasm/synth.wasm")

  document.getElementById("calc-btn").addEventListener("click", proc(e: Event) =
    let res = wasm.addNumbers(17, 25)
    document.getElementById("result").textContent = "WASM Result: " & $res
  )

discard main()
```

Read the full [Dual-Tier Nim Architecture Guide](https://axiomantic.github.io/nimts/guide/dual-tier-nim.html) for details.

---

## Standalone CLI & Manual Compilation (Without Vite)

If you are building outside of Vite (headless Node.js services, CLI tools, audio plugins):

```bash
# 1. Standalone micro-WASM (Default: clang + wasm-ld + wasi-sysroot)
# Produces minimal, zero-bloat WASM (~50–250 kB):
nimts compile src/synth.nim dist/synth.wasm

# 2. Emscripten Runtime Backend (emcc with virtual FS and POSIX shims):
nimts compile src/synth.nim dist/synth.wasm --backend:emscripten
```

Consume the generated ES module in JavaScript/TypeScript:
```typescript
import { initNimTs, addNumbers } from './dist/synth.js';
await initNimTs();
console.log(addNumbers(17, 25));
```

Read the dedicated guides:
- [Standalone Micro-WASM Backend (Default)](https://axiomantic.github.io/nimts/guide/backend-standalone.html)
- [Emscripten Runtime Backend](https://axiomantic.github.io/nimts/guide/backend-emscripten.html)

---

## Common WebAssembly Gotchas (And How NimTS Solves Them)

| Gotcha | The Pitfall | How NimTS Solves It |
| :--- | :--- | :--- |
| **Main-Thread UI Freezing** | In WebAssembly, computation on the main thread is synchronous. Wrapping a CPU-heavy loop in `Future[T]` still locks the UI event loop and drops animation frames. | **`@axiomantic/nimts/worker` & `?worker`**: Automatically executes compute in an isolated Web Worker thread with typed async proxying and zero-copy `ArrayBuffer` detachment. |
| **Detached Buffer Trap** | When WebAssembly linear memory expands (`memory.grow`), the underlying `ArrayBuffer` is detached / neutered. Existing typed array views throw `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer`. | **Dynamic View Resolution**: NimTS runtime accessors dynamically fetch `wasm.memory.buffer` on every call, preventing stale detached buffer crashes. |
| **WebGPU 256-Byte Alignment** | WebGPU dynamic uniform buffers require offsets aligned to 256 bytes (`minUniformBufferOffsetAlignment`). Standard `malloc` only aligns to 8 or 16 bytes. | **Aligned Allocators & `GpuBufferSlice[T]`**: `nimts_alloc_aligned(size, 256)` and `GpuBufferSlice` provide hardware-aligned memory and direct zero-copy `queue.writeBuffer` transfers. |
| **Handle Leaks & Dangling Pointers** | Passing raw pointers to JS risks use-after-free or memory leaks. | **Handle Table + `FinalizationRegistry`**: Stateful `ref object` instances are tracked with `GC_ref`/`GC_unref`, providing deterministic `.dispose()` and automatic GC fallback. |
| **V8 4KB Sync Compile Limit** | Chromium disallows synchronous `new WebAssembly.Module()` >4KB on the main thread. | **Asynchronous Instantiation**: NimTS uses `WebAssembly.instantiateStreaming` by default and supports pre-compiled module passing for AudioWorklets. |

---

## Type Mapping Reference

| Nim Type | TypeScript Type | WASM Linear Memory Marshaling |
| :--- | :--- | :--- |
| `int32`, `int16`, `int8`, `uint32` | `number` | Direct register pass / return |
| `int64`, `uint64` | `bigint` | 64-bit WASM integer (`i64`) |
| `float32`, `float64` | `number` | Direct WASM float register (`f32` / `f64`) |
| `bool` | `boolean` | `int32` (0 or 1) $\leftrightarrow$ `boolean` |
| `string`, `cstring` | `string` | UTF-8 `(ptr, len)` allocated via `nimts_alloc` |
| `openArray[byte]`, `seq[byte]` | `Uint8Array` | Direct view copy via `allocBytesResult` / `readBytes` |
| `ref object` | `Class` | Opaque `HandleId` with `FinalizationRegistry` & `.dispose()` |
| `object`, `tuple` | `interface` | Automatic JSON serialization / deserialization |
| `Future[T]` | `Promise<T>` | Bidirectional non-blocking `PromiseId` bridge |
| `ClosureIter[T]` / `NimTsIterator[T]` | `IterableIterator<T>` | Closure iterator stepping via monotonic slot registry (`for..of`) |
| `Channel[T]` / `NimTsChannel[T]` | `AsyncIterable<T>` | Lock-free SPSC circular queue with backpressure (`for await..of`) |
| `GpuBufferSlice[T]` | `GpuBufferSlice<T>` | 256-byte aligned WebGPU zero-copy storage buffer slice |

---

## Documentation & Guides

- [Getting Started Guide](https://axiomantic.github.io/nimts/guide/getting-started.html)
- [Core Concepts & `{.exportts.}`](https://axiomantic.github.io/nimts/guide/non-invasive-exports.html)
- [Type Marshaling Deep Dive](https://axiomantic.github.io/nimts/guide/type-marshaling.html)
- [Stateful Handles & Garbage Collection](https://axiomantic.github.io/nimts/guide/stateful-handles.html)
- [Async Future ↔ Promise Bridge](https://axiomantic.github.io/nimts/guide/async-bridge.html)
- [Vite Plugin Integration](https://axiomantic.github.io/nimts/guide/vite-plugin.html)
- [AudioWorklet & Web Workers](https://axiomantic.github.io/nimts/guide/audioworklet-workers.html)
- [WebGPU & GPU Compute Guide](https://axiomantic.github.io/nimts/guide/webgpu-compute.html)
- [Dual-Tier Nim Architecture (`nim js` + WASM)](https://axiomantic.github.io/nimts/guide/dual-tier-nim.html)
- [Standalone Micro-WASM Backend](https://axiomantic.github.io/nimts/guide/backend-standalone.html)
- [Emscripten Runtime Backend](https://axiomantic.github.io/nimts/guide/backend-emscripten.html)

---

## Running Tests

```bash
# Run all Nimble test suites (memory, handles, async, channels, codegen, CLI)
nimble test

# Run all TypeScript / Vitest suites (sync/async, Web Workers, negative controls, Vite plugin)
npm test
```

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup and guidelines.

---

## License

MIT License. Copyright (c) 2026 [Axiomantic](https://github.com/axiomantic) & Contributors.
