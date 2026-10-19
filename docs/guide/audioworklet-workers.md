# AudioWorklet & Web Workers

In modern web development, compute-heavy audio DSP algorithms and CPU-intensive computations must run off the main thread—either inside an `AudioWorkletNode` for real-time audio or inside a `Worker` for background tasks.

NimTS is engineered specifically to thrive in these high-performance, multithreaded environments.

---

## Solved Gotcha: The 4KB Main-Thread Compile Limit

Browser engines (including Chrome and Chromium-based browsers) disallow synchronous WebAssembly compilation on the main thread if the binary buffer exceeds 4KB:

> `RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB`

### The NimTS Solution:
NimTS wrappers support asynchronous streaming compilation as well as pre-compiled modules:

```typescript
// 1. In your main thread: pre-compile the module once
const wasmModule = await WebAssembly.compileStreaming(fetch('/engine.wasm'));

// 2. Pass the pre-compiled WebAssembly.Module across threads via postMessage:
audioContext.audioWorklet.addModule('dsp-processor.js');

const synthNode = new AudioWorkletNode(audioContext, 'dsp-processor', {
  processorOptions: { wasmModule }
});
```

---

## First-Class AudioWorklet Support (`.nim?worklet` & `@axiomantic/nimts/worklet`)

NimTS provides **first-class WebAudio AudioWorklet generation**, allowing you to write your DSP synthesis or audio processing code directly in Nim and instantiate it with zero manual JavaScript glue.

### Step 1: Write Your Audio DSP in Nim

Annotate your audio render callback with `{.exportts, audioProcess.}` or use `{.exporttsWorklet.}`:

```nim
# src/synth.nim
import nimts

var gPhase: float32 = 0.0'f32
var gFrequency: float32 = 440.0'f32

proc audioProcess*(output: openArray[float32], sampleRate: float32): int32 {.exportts, audioProcess.} =
  let phaseInc = (2.0'f32 * 3.14159265'f32 * gFrequency) / sampleRate
  for i in 0 ..< output.len:
    output[i] = sin(gPhase)
    gPhase += phaseInc
    if gPhase >= 2.0'f32 * 3.14159265'f32:
      gPhase -= 2.0'f32 * 3.14159265'f32
  return 1

# Additional RPC controls accessible from the main thread
proc setFrequency*(freq: float32) {.exportts.} =
  gFrequency = freq
```

### Step 2: Instant Vite Worklet Node (`.nim?worklet`)

With the Vite plugin, simply import `.nim?worklet`:

```typescript
import { createWorklet } from './synth.nim?worklet';

const audioContext = new AudioContext();
const synthNode = await createWorklet(audioContext);

// Connect directly into the WebAudio audio graph
synthNode.connect(audioContext.destination);

// Call exported Nim RPC methods over the worklet message port
await synthNode.setFrequency(880.0);
```

### Manual Usage: `@axiomantic/nimts/worklet`

If you are not using Vite, you can use the `@axiomantic/nimts/worklet` runtime package directly:

```typescript
import { createNimTsWorklet } from '@axiomantic/nimts/worklet';

const synthClient = await createNimTsWorklet({
  audioContext,
  wasmPath: '/synth.wasm'
});

synthClient.connect(audioContext.destination);
await synthClient.setFrequency(523.25);
```

Because `initNimTsSync` accepts `wasmModule: WebAssembly.Module`, the AudioWorklet initializes synchronously without network calls, microtask scheduling races, or buffer compilation delays.

---

## Web Worker Runtime (`@axiomantic/nimts/worker`)

For CPU-bound tasks, heavy algorithms, or background data crunching, NimTS provides a full **Web Worker client runtime** (`@axiomantic/nimts/worker`) compatible with both browser Web Workers and `node:worker_threads`.

### Features
- **Typed Transparent Proxy**: All exported Nim functions are exposed as asynchronous methods returning `Promise<T>`.
- **Async/Await Resolution**: Automatically resolves Nim `Future[T]` in the worker and settles the caller's Promise.
- **Zero-Copy Buffer Transfers**: Automatically detects `ArrayBuffer` and `TypedArray` views in arguments/results and includes them in the `postMessage` transfer list, detaching the sender buffer for true zero-copy performance.
- **Channel Streaming**: Supports continuous streaming over `MessagePort` so you can consume `NimTsChannel[T]` via `for await (const chunk of worker.streamWords())` or directly `await` the aggregated array.
- **Clean Termination**: Explicit `worker.terminate()` immediately releases worker threads and rejects in-flight calls.

### Example: Spawning a Worker

```typescript
import { spawnWorker } from '@axiomantic/nimts/worker';

// Spawn worker pointing to your compiled module
const worker = await spawnWorker('./engine.js', {
  wasmPath: '/wasm/engine.wasm'
});

// 1. Primitive RPC
const sum = await worker.addNumbers(15, 27);
console.log('Sum:', sum); // 42

// 2. Zero-Copy Buffer Transfer
const audioBuffer = new Uint8Array([10, 20, 30, 40]);
const processed = await worker.checksumBytes(audioBuffer);
// audioBuffer.byteLength is now 0 (detached and transferred zero-copy)

// 3. Off-Thread Async Future[T]
const asyncResult = await worker.asyncAdd(100, 250);
console.log('Async Add:', asyncResult); // 350

// 4. Channel Streaming via for-await
for await (const word of worker.streamWords(['nim', 'wasm', 'worker'])) {
  console.log('Stream chunk:', word);
}

// 5. Terminate when done
await worker.terminate();
```
