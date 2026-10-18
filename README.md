# NimTS: Seamless TypeScript & WebAssembly Bridge for Nim

[![CI](https://github.com/axiomantic/nimts/actions/workflows/ci.yml/badge.svg)](https://github.com/axiomantic/nimts/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-GitHub_Pages-blue.svg)](https://axiomantic.github.io/nimts/)
[![npm version](https://img.shields.io/npm/v/@axiomantic/nimts.svg)](https://www.npmjs.com/package/@axiomantic/nimts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Nimble](https://img.shields.io/badge/nimble-nimts-orange.svg)](https://nimble.directory/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/axiomantic/nimts/pulls)

**NimTS** is a zero-friction bridge generator connecting **Nim** to **TypeScript** and **WebAssembly (WASM)**.

📖 **Full Documentation & Interactive Guides**: [https://axiomantic.github.io/nimts/](https://axiomantic.github.io/nimts/)

NimTS enables writing high-performance WebAssembly libraries in Nim with natural Nim signatures, companion C-ABI entry points, automatic `.d.ts` declaration generation, and modern TypeScript wrappers.

---

## Key Highlights

- ⚡ **Zero-Overhead `{.exportts.}`**: Preserves native Nim signatures and behavior. Procs remain 100% callable by native Nim CLI tools, VST/CLAP audio plugins, and native unit tests with zero overhead.
- 🧵 **Honest Off-Thread Web Worker Runtime (`@axiomantic/nimts/worker`)**: Run CPU/DSP algorithms in dedicated background threads via `spawnWorker` or Vite's `?worker` query. Transparent typed async proxying, automatic `Future[T]` awaiting, and true zero-copy `ArrayBuffer` detachment via Transferable objects.
- 🔄 **Bidirectional Async Bridge**: Automatically bridges Nim `Future[T]` and JavaScript `Promise<T>` without blocking the main browser thread.
- 🎛️ **Stateful Handles with GC**: Exports `ref object` instances as type-safe opaque handles with automatic garbage collection via JavaScript's `FinalizationRegistry` and deterministic manual `.dispose()`.
- 🔁 **Closure Iterators & SPSC Channels**: Stream data from Nim closures as standard ES2015 `IterableIterator<T>` (`for..of`, `[...]`) and lock-free SPSC channels (`Channel[T]` / `NimTsChannel[T]`) as `AsyncIterable<T>` (`for await..of`).
- 📦 **Vite Plugin**: Import `.nim` and `.nim?worker` files directly into your frontend code with on-the-fly compilation and hot module reloading.
- 🎵 **AudioWorklet & Worker Ready**: Supports streaming instantiation, pre-compiled `WebAssembly.Module` sharing, and raw `BufferSource` buffers.

---

## Installation

### In your Nim project (Nimble)
```bash
nimble install nimts
```

### In your TypeScript / Vite project (npm)
```bash
npm install @axiomantic/nimts
```

> **Note**: For full-stack applications (e.g. Vite + React/Vue with `.nim` source files), install **both**: Nimble provides the compiler tools & macros, while npm provides the Vite plugin (`@axiomantic/nimts/vite`) and runtime (`@axiomantic/nimts/runtime`).


---

## Quickstart: Vite Integration (Recommended)

The fastest and cleanest way to use NimTS is via the official Vite plugin. You can import `.nim` files directly into your frontend or Web Worker code—compilation, type generation, and hot module reloading happen automatically.

### 1. Configure Vite (`vite.config.ts`)

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

### 2. Write your Nim module (`src/engine.nim`)

```nim
# src/engine.nim
import std/asyncdispatch
import nimts

type
  AudioEngine* {.exportts.} = ref object
    sampleRate*: float32
    volume*: float32

  SynthPatch* = object
    name*: string
    polyphony*: int32

# 1. Primitives: passed & returned directly
proc addNumbers*(a: int32, b: int32): int32 {.exportts.} =
  a + b

# 2. Strings: UTF-8 marshaled automatically
proc greet*(name: string): string {.exportts.} =
  "Hello, " & name & " from Nim!"

# 3. Binary buffers: maps directly to Uint8Array
proc processData*(data: openArray[byte]): seq[byte] {.exportts.} =
  result = newSeq[byte](data.len)
  for i in 0 ..< data.len:
    result[i] = data[i] xor 0xFF'u8

# 4. Stateful handles for ref object instances
proc createEngine*(sampleRate: float32): AudioEngine {.exportts.} =
  AudioEngine(sampleRate: sampleRate, volume: 1.0'f32)

proc setVolume*(engine: AudioEngine, vol: float32) {.exportts.} =
  if engine != nil:
    engine.volume = vol

# 5. Non-blocking async Future[T] -> JS Promise<T>
proc computeAsync*(x: int32): Future[int32] {.async, exportts.} =
  return x * 42

# 6. Idiomatic Channel[T] streaming -> AsyncIterable<T>
proc streamEvents*(count: int32): Channel[string] {.exportts.} =
  let ch = newChannel[string](32)
  for i in 1 .. count:
    discard ch.send("Event " & $i)
  return ch
```

### 3. Consume in your frontend (`src/main.ts`)

#### Pattern A: Direct In-Thread WASM Execution

```typescript
// src/main.ts
import {
  initNimTs,
  addNumbers,
  greet,
  processData,
  createEngine,
  setVolume,
  computeAsync,
  streamEvents
} from './engine.nim';

// Initialize the WebAssembly module
await initNimTs();

// Call synchronous functions
console.log(addNumbers(10, 32)); // 42
console.log(greet("TypeScript")); // "Hello, TypeScript from Nim!"

// Process binary buffers
const input = new Uint8Array([0x00, 0xAA, 0xFF]);
const output = processData(input); // Uint8Array [ 255, 85, 0 ]

// Stateful instances with handles
const engine = createEngine(48000.0);
setVolume(engine, 0.8);
engine.dispose(); // Explicit release, or automatic GC via FinalizationRegistry

// Async Future[T] seamlessly awaited as Promise<T>
const result = await computeAsync(10); // 420

// Stream from Channel[T] via native for-await
for await (const event of streamEvents(3)) {
  console.log(event); // "Event 1", "Event 2", "Event 3"
}
```

#### Pattern B: Off-Thread Web Worker with Zero-Copy Transfers (`@axiomantic/nimts/worker`)

For heavy DSP, physics simulations, or background data crunching, run entirely off the UI thread:

```typescript
// Import directly as a Web Worker using Vite's ?worker query
import EngineWorker from './engine.nim?worker';

// Or spawn manually:
// import { spawnWorker } from '@axiomantic/nimts/worker';
// const worker = await spawnWorker('./engine.js');

const worker = await new EngineWorker();

// 1. Transparent async RPC proxy
const sum = await worker.addNumbers(10, 32); // 42
const asyncRes = await worker.computeAsync(10); // 420

// 2. Zero-Copy buffer transfer (caller buffer is detached and transferred)
const audioBuffer = new Uint8Array([0x00, 0xAA, 0xFF]);
const processed = await worker.processData(audioBuffer);
// audioBuffer.byteLength is now 0 (transferred with zero copy!)

// 3. Off-thread channel streaming via MessagePort
for await (const event of worker.streamEvents(3)) {
  console.log('Worker event:', event);
}

// 4. Terminate cleanly when finished
await worker.terminate();
```

---

## Advanced Usage: Standalone CLI (Without Vite)

If you are building headless Node.js microservices, audio plugins, CLI tools, or custom build pipelines without Vite, you can compile modules manually with the standalone `nimts` CLI:

### 1. Emit static glue files at compile time

Add an `emitTsGlueFiles` call to the end of your Nim module:

```nim
static:
  # Emits engine.d.ts and engine.js glue code at compile-time
  emitTsGlueFiles("engine", ".")
```

### 2. Compile to WebAssembly

```bash
# Standalone micro-WASM (Default: clang + wasm-ld + wasi-sysroot)
# Produces minimal, zero-bloat WASM:
nimts compile engine.nim engine.wasm

# Emscripten Runtime Backend
# Uses emcc with virtual filesystem (FS) and POSIX libc shims:
nimts compile engine.nim engine.wasm --backend:emscripten
```

### 3. Consume the generated JavaScript glue

```typescript
// app.ts
import { initNimTs, addNumbers } from './engine.js';

await initNimTs();
console.log(addNumbers(10, 32));
```

---

## Solved WebAssembly Gotchas

### Gotcha 1: Chrome / V8 4KB Main-Thread Sync Compile Limit
Browser main threads disallow synchronous WebAssembly compilation (`WebAssembly.compile` or `new WebAssembly.Module`) if the binary buffer size exceeds 4KB, throwing:
> `RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB`

**NimTS Solution:**
The generated JavaScript wrapper automatically handles all modern runtime environments:
1. **`WebAssembly.instantiateStreaming(fetch(...))`** for modern browsers and bundlers.
2. **Explicit `initNimTs(options)`** accepting:
   - `wasmPath`: URL or local file path.
   - `wasmModule`: Pre-compiled `WebAssembly.Module` (ideal for passing across threads to an `AudioWorkletNode` or Web Worker).
   - `wasmBytes`: Raw `BufferSource` / `ArrayBuffer`.
   - `wasmInstance`: Existing instantiated `WebAssembly.Instance`.

### Gotcha 2: Nim async/await (`Future[T]`) $\leftrightarrow$ JavaScript `Promise<T>` Bridge
WebAssembly is fundamentally single-threaded; blocking the WASM thread while waiting for an asynchronous event would freeze the browser host.

**NimTS Solution:**
NimTS implements a bidirectional, non-blocking promise bridge:
- **Nim $\to$ JS**: When an exported `proc foo(): Future[T] {.async, exportts.}` is called, Nim allocates a monotonic `PromiseId`, registers a completion callback, and immediately returns the ID to JavaScript, which wraps it in a real `Promise<T>`. When the Future completes or fails, Nim notifies JavaScript via `nimts_js_resolve_promise` or `nimts_js_reject_promise`.
- **JS $\to$ Nim**: When Nim awaits an external async operation, it registers a pending `Future[T]` and passes a `FutureId`. When the JS promise settles, JS calls back into WASM `wasm.nimts_resume_future(futureId, dataPtr, dataLen, isError)` which immediately wakes the waiting Nim coroutine.

### Gotcha 3: Stateful Objects & Handle Leaks
Passing raw pointers between WebAssembly linear memory and JavaScript risks use-after-free, memory corruption, and garbage collection leaks.

**NimTS Solution:**
Stateful entities (`ref object`) are registered in an internal Nim handle registry that increments Nim GC reference counts (`GC_ref`). JavaScript receives a typed class holding an opaque `HandleId`:
- **Manual cleanup**: `.dispose()` deterministically frees the handle and unrefs the Nim object (`GC_unref`).
- **Automatic fallback**: Bound to JavaScript's modern `FinalizationRegistry` to prevent leaks if `.dispose()` is forgotten.

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
| `ref object` | `Class` | Opaque `HandleId` with `FinalizationRegistry` |
| `object`, `tuple` | `interface` | Automatic JSON serialization / deserialization |
| `Future[T]` | `Promise<T>` | Bidirectional non-blocking `PromiseId` bridge |
| `NimTsIterator[T]` | `NimTsIterator<T>` (`IterableIterator<T>`) | Closure iterator handle stepping via monotonic slot registry |
| `NimTsChannel[T]` | `NimTsChannel<T>` (`AsyncIterable<T>`) | Lock-free SPSC circular queue with backpressure |

---

## Vite Plugin Configuration Options

The `nimtsPlugin()` accepts configuration options for advanced builds:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { nimtsPlugin } from '@axiomantic/nimts/vite';

export default defineConfig({
  plugins: [
    nimtsPlugin({
      // Extra compiler flags passed directly to Nim
      extraNimFlags: ['-d:release', '-d:danger'],

      // Choose compilation backend: 'standalone' (default) or 'emscripten'
      backend: 'standalone',

      // Custom path to wasi-sysroot if not using standard system location
      sysroot: process.env.WASI_SYSROOT,

      // Directory where generated .wasm binaries are copied for browser serving
      publicDir: 'public/wasm'
    })
  ]
});
```

---

## AudioWorklet / Web Worker Pattern

To run Nim in an `AudioWorkletProcessor`:

```typescript
// main.ts
const wasmModule = await WebAssembly.compileStreaming(fetch('/engine.wasm'));
audioContext.audioWorklet.addModule('dsp-processor.js');

const node = new AudioWorkletNode(audioContext, 'dsp-processor', {
  processorOptions: { wasmModule }
});
```

```typescript
// dsp-processor.ts
import { initNimTs, processAudio } from './engine.js';

class DspProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Initialize synchronously from pre-compiled module
    initNimTs({ wasmModule: options.processorOptions.wasmModule });
  }

  process(inputs, outputs) {
    // Zero-allocation high-speed DSP processing
    processAudio(inputs[0][0], outputs[0][0]);
    return true;
  }
}
registerProcessor('dsp-processor', DspProcessor);
```

---

## CLI Reference

NimTS includes a command-line tool for compiling Nim modules into WebAssembly:

```bash
# Display help and available backends
nimts --help

# Display version
nimts --version

# Compile a Nim module using the standalone micro-WASM backend (default)
nimts compile src/dsp.nim dist/dsp.wasm

# Explicitly choose the standalone micro-WASM backend (LLVM clang + wasm-ld + wasi-sysroot)
nimts compile src/dsp.nim dist/dsp.wasm --backend:standalone

# Choose the Emscripten backend (emcc with POSIX shims, virtual FS, and environment polyfills)
nimts compile src/dsp.nim dist/dsp.wasm --backend:emscripten
```

### Backend Comparison

| Backend | Toolchain | Runtime Size | Virtual FS / POSIX | Best For |
| :--- | :--- | :--- | :--- | :--- |
| **`standalone`** *(Default)* | Clang + wasm-ld + wasi-sysroot | Tiny (~50–350 kB) | Minimal stubbing | AudioWorklets, Web Workers, micro-libraries, latency-critical DSP |
| **`emscripten`** | Emscripten (`emcc`) | Larger (~300 kB–1+ MB) | Full in-memory POSIX & `FS` | Legacy C/Nim dependencies needing filesystem, canvas, or full POSIX libc |

---

## Running Tests

NimTS has comprehensive test suites for both native Nim execution and WebAssembly runtime integration:

```bash
# Run Nimble unit tests (macro non-invasiveness, memory, handles, async bridge, codegen, CLI)
nimble test

# Run TypeScript / Vitest WebAssembly integration tests
npm test
```

---

## Publishing

To publish a new version to npm and GitHub:

```bash
# 1. Ensure all tests pass and package builds cleanly
npm run prepublishOnly

# 2. Check packaging contents
npm pack --dry-run

# 3. Publish to npm
npm publish --access public
```

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup, toolchain requirements, and guidelines.

---

## License

MIT License. Copyright (c) 2026 [Axiomantic](https://github.com/axiomantic) & Contributors.
