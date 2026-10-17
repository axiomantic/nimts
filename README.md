# NimTS: nimpy for TypeScript & WebAssembly

**NimTS** is a zero-friction, non-invasive bridge generator connecting **Nim** to **TypeScript** and **WebAssembly (WASM)**.

Just like `nimpy` allows writing native Python extension modules in Nim with natural types, `nimts` allows writing high-performance WebAssembly libraries in Nim with natural Nim signatures, companion C-ABI entry points, automatic `.d.ts` declaration generation, and modern TypeScript wrappers.

---

## Key Features

### 1. Non-Invasive `{.exportts.}`
Applying `{.exportts.}` (or calling `exportTs(myProc)` in a separate bridge module) **never alters the native Nim signature or behavior** of your procedures. The original proc remains 100% general-purpose for native CLI tools, native VST/CLAP audio plugins, and native unit tests with zero runtime overhead.

```nim
import nimts

# Native signature preserved 100%
proc computeFilter*(cutoff: float32, resonance: float32): float32 {.exportts.} =
  cutoff * (1.0'f32 - resonance * 0.5'f32)

# OpenArray / byte sequences map directly to Uint8Array views
proc parsePatch*(data: openArray[byte]): seq[byte] {.exportts.} =
  result = @[0xAA'u8, 0xBB'u8]
```

### 2. Stateful Handles for `ref object` Instances
Stateful entities (such as audio synths, patch graphs, and DSP voice pools) are tracked via type-safe opaque handles (`HandleId`). The generated TypeScript classes automatically bind to JavaScript's modern `FinalizationRegistry` for automatic garbage collection, while also providing explicit `.dispose()` methods.

```nim
type AudioEngine* {.exportts.} = ref object
  sampleRate*: float32
  voices*: int32

proc createEngine*(sampleRate: float32): AudioEngine {.exportts.} =
  AudioEngine(sampleRate: sampleRate, voices: 16)
```

In TypeScript:
```typescript
import { createEngine } from './synth_module.js';

const engine = createEngine(48000.0);
console.log(engine.handleId); // 1
engine.dispose(); // Deterministic release or automatic FinalizationRegistry GC
```

---

## Solved WebAssembly Gotchas

### Gotcha 1: Chrome / V8 4KB Main-Thread Sync Compile Limit
Browser main threads disallow synchronous WebAssembly compilation (`WebAssembly.compile` or `new WebAssembly.Module`) if the binary buffer size exceeds 4KB, throwing:
`RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB`

**NimTS Solution:**
The generated JavaScript glue automatically leverages:
1. **`WebAssembly.instantiateStreaming(fetch(...))`** for modern bundlers (Vite, Rollup, Webpack) with top-level await support.
2. **Explicit `initNimTs(options)`** accepting:
   - File path / URL (`wasmPath`)
   - Pre-compiled `WebAssembly.Module` (ideal for `AudioWorkletNode` where modules are sent via `processorOptions`)
   - `BufferSource` / `ArrayBuffer`

### Gotcha 2: Nim async/await (`Future[T]`) <-> JavaScript `Promise<T>` Bridge
WebAssembly is fundamentally single-threaded; blocking the WASM thread while waiting for a network request or async callback would freeze the browser.

**NimTS Solution:**
NimTS implements a bidirectional, non-blocking promise bridge:
- **Nim $\to$ JS**: When an exported `proc foo(): Future[T] {.async, exportts.}` is called, Nim allocates a `promiseId`, registers a completion callback, and immediately returns the ID to JavaScript, which wraps it in a real `Promise<T>`. When the Future completes, Nim calls the imported JS function `nimts_js_resolve_promise` or `nimts_js_reject_promise`.
- **JS $\to$ Nim**: When Nim awaits an imported JS async operation, Nim registers a pending `Future[T]` and passes a `futureId`. When the JS promise settles, JS calls back into WASM `wasm.nimts_resume_future(futureId, dataPtr, dataLen, isError)` which immediately wakes the waiting Nim coroutine.

```nim
proc fetchAndProcess*(url: string): Future[string] {.async, exportts.} =
  return "Processed from " & url
```

In TypeScript:
```typescript
const result: string = await fetchAndProcess("https://example.com/patch");
```

---

## Type Mapping Table

| Nim Type | TypeScript Type | WASM Linear Memory Marshaling |
| :--- | :--- | :--- |
| `int32`, `int16`, `int8`, `uint32` | `number` | Direct register pass / return |
| `int64`, `uint64` | `bigint` | 64-bit WASM integer (`i64`) |
| `float32`, `float64` | `number` | Direct WASM float (`f32` / `f64`) |
| `bool` | `boolean` | `int32` (0 or 1) $\leftrightarrow$ `boolean` |
| `string`, `cstring` | `string` | UTF-8 `(ptr, len)` allocated via `nimts_alloc` |
| `openArray[byte]`, `seq[byte]` | `Uint8Array` | Zero-copy `toOpenArray` view or `readBytes` |
| `ref object` | `Class` | Opaque `HandleId` with `FinalizationRegistry` |
| `object`, `tuple` | `interface` | Automatic JSON serialization / deserialization |
| `Future[T]` | `Promise<T>` | Bidirectional `PromiseId` non-blocking bridge |

---

## Vite Plugin (`vite-plugin-nimts`)

Import `.nim` files directly in your Vite application:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { nimtsPlugin } from 'nimts/vite';

export default defineConfig({
  plugins: [
    nimtsPlugin({
      extraNimFlags: ['-d:release']
    })
  ]
});
```

Then in your frontend:
```typescript
import { initNimTs, parsePatch } from './synth/engine.nim';

await initNimTs();
const result = parsePatch(patchBytes);
```

---

## Running Tests

```bash
# 1. Native Nim direct invocation tests
nim r -p:src tests/test_native.nim

# 2. Codegen unit tests
nim r -p:src tests/test_codegen.nim

# 3. WebAssembly sync & async Vitest suite
npm test
```

## License
MIT License.
