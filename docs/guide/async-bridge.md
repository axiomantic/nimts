# Async & Threading Architecture

A critical architectural reality of the browser environment is that **standard WebAssembly instances execute synchronously on the caller's thread**.

NimTS provides a clear, predictable model for asynchronous programming, background execution, and WebAssembly threading.

---

## 1. Main-Thread WebAssembly is Synchronous

When you import and call a Nim procedure on the main UI thread:

```typescript
import { calculate } from './engine.nim';

// Executes directly on the main thread call stack
const result = calculate(42);
```

- **Instant Register Speed**: Execution runs at native C speed directly in CPU registers with zero IPC latency.
- **Synchronous to the Browser**: WebAssembly runs on the exact same thread as the browser's UI and event loop.
- **No Automatic Backgrounding**: Wrapping synchronous, CPU-intensive Nim loops in `{.async.}` does **not** move computation to a background thread. Running heavy loops on the main thread will freeze the browser window and drop animation frames.

---

## 2. Background Computation: Use Dedicated Web Workers

When you need non-blocking background execution for CPU-intensive tasks—such as audio DSP, physics simulation, large array transformations, or machine learning inference—use **`@axiomantic/nimts/worker`** or Vite's **`?worker`** query:

```typescript
import EngineWorker from './engine.nim?worker';

// Spawns a dedicated Web Worker running on an isolated background OS thread
const worker = await new EngineWorker();

// Calls the exact same Nim function off-thread; returns a real Promise
const sum = await worker.heavyComputation(100_000_000);
```

- **True OS Threads**: Runs in a separate browser thread or `worker_threads` context. The main UI thread stays at a locked 60/120 FPS.
- **Transparent RPC**: NimTS automatically generates typed Promise proxies for all exported procedures.
- **Zero-Copy Transfers**: Binary buffers (`ArrayBuffer`, `Uint8Array`) are detached and transferred instantly via Transferable Objects without copying.

---

## 3. Web I/O: Let TypeScript Handle the Browser

WebAssembly does not have direct access to POSIX sockets or the browser DOM. The most robust, idiomatic architecture divides responsibilities cleanly:

1. **TypeScript handles browser I/O**: Fetching files, waiting for timers, user events, and `requestAnimationFrame`.
2. **Nim handles core computation**: Processing data, running algorithms, and mutating state.

```typescript
// 1. TypeScript fetches data using standard browser APIs
const response = await fetch('/assets/soundbank.bin');
const buffer = new Uint8Array(await response.arrayBuffer());

// 2. Pass binary buffer directly into Nim at WASM speed
engine.loadSoundbank(buffer);
```

This avoids bloating your WebAssembly binary with complex event-loop shims or fragile POSIX socket emulators.

---

## 4. Low-Level Bridge: Nim `Future[T]` ↔ JavaScript `Promise<T>`

For advanced use cases where a Nim procedure naturally yields a `Future[T]` (for instance, when interfacing with an external asynchronous callback), NimTS provides a low-level bidirectional bridge connecting Nim's `Future[T]` to JavaScript's `Promise<T>`.

### Exporting an Async Proc
When an exported procedure returns a `Future[T]`:

```nim
import std/asyncdispatch
import nimts

proc runTask*(name: string): Future[string] {.async, exportts.} =
  return "Completed: " & name
```

1. NimTS allocates a unique `PromiseId` and returns it immediately to JavaScript.
2. The TypeScript wrapper wraps this `PromiseId` in a native `Promise<T>`.
3. When Nim completes the `Future`, NimTS resolves the JavaScript promise with the serialized result.

### Resuming a Nim Coroutine from JavaScript
You can also suspend a Nim coroutine and resume it later from JavaScript via `nimts_resume_future`:

```nim
proc startAsyncJob*(): Future[string] {.exportts.} =
  let fut = newFuture[string]("job")
  let fid = nextFutureId()
  registerPendingFuture(fid, fut)
  return fut
```

In JavaScript, when the external operation finishes:

```typescript
const promise = startAsyncJob();
const wasm = getNimTsModule();
const futureId = wasm.nimts_getLastFutureId();

// Resume coroutine with payload:
const payload = new TextEncoder().encode("Data from host");
const ptr = wasm.nimts_alloc(payload.length);
new Uint8Array(wasm.memory.buffer, ptr, payload.length).set(payload);

wasm.nimts_resume_future(futureId, ptr, payload.length, /* isError */ 0);
wasm.nimts_free(ptr);

const result = await promise;
```

> [!NOTE]
> The `Future[T]` bridge is a low-level FFI mechanism for host callback resumption. For general background parallelism and non-blocking tasks, always use **Web Workers (`?worker`)**.
