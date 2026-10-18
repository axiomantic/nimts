# Async Future ↔ Promise Bridge

WebAssembly is single-threaded in the browser. Blocking the WASM thread while waiting for a network response, timer, or async callback would freeze the browser UI and drop audio frames.

NimTS provides a **bidirectional, non-blocking coroutine bridge** connecting Nim's `std/asyncdispatch` (`Future[T]`) to JavaScript's `Promise<T>`.

---

## Nim `Future[T]` $\to$ JavaScript `Promise<T>`

When you export an asynchronous procedure in Nim using `{.async, exportts.}`:

```nim
import std/asyncdispatch
import nimts

proc fetchPatchData*(url: string): Future[string] {.async, exportts.} =
  # Asynchronous operation in Nim
  return "Patch data from " & url
```

### Generated Workflow
1. When TypeScript calls `fetchPatchData("https://example.com/patch")`, the WASM function allocates a `PromiseId` and immediately returns it to JavaScript without blocking.
2. The generated TypeScript wrapper wraps this `PromiseId` in a real JavaScript `Promise<string>`.
3. When the Nim `Future` finishes:
   - If successful, Nim calls `nimts_js_resolve_promise(promiseId, dataPtr, dataLen)`.
   - If the Future fails with an exception, Nim calls `nimts_js_reject_promise(promiseId, errPtr, errLen)`.
4. The JavaScript promise settles immediately:

```typescript
try {
  const patch = await fetchPatchData("https://example.com/patch");
  console.log(patch);
} catch (err) {
  console.error("Failed to load patch:", err);
}
```

---

## JavaScript $\to$ Nim Coroutine Resumption

You can also suspend a Nim coroutine and resume it later from JavaScript:

```nim
proc startAsyncJob*(): Future[string] {.exportts.} =
  let fut = newFuture[string]("job")
  let fid = nextFutureId()
  registerPendingFuture(fid, fut)
  return fut
```

In JavaScript, when your external task finishes, call `nimts_resume_future`:

```typescript
const promise = startAsyncJob();
const wasm = getNimTsModule();
const futureId = wasm.nimts_getLastFutureId();

// Resume from JavaScript callback:
const encoder = new TextEncoder();
const payload = encoder.encode("Result from JS Web Worker");
const ptr = wasm.nimts_alloc(payload.length + 1);
new Uint8Array(wasm.memory.buffer, ptr, payload.length).set(payload);

// wasm.nimts_resume_future(futureId, ptr, len, isError=0)
wasm.nimts_resume_future(futureId, ptr, payload.length, 0);
wasm.nimts_free(ptr);

const result = await promise;
console.log(result); // "Result from JS Web Worker"
```

If an error occurred, passing `isError = 1` causes Nim to fail the `Future` with a `NimTsError`, automatically rejecting the JavaScript Promise.

---

## In-Thread Coroutines vs. Honest Off-Thread Execution

A crucial distinction in WebAssembly and browser architecture is the difference between **in-thread coroutine scheduling** and **honest off-thread execution**.

### The "Lying Async" Pitfall

Because standard WebAssembly instances run on the caller's thread, wrapping synchronous, CPU-intensive code inside a Nim `{.async.}` proc does **not** move computation to a background thread. 

```nim
# ⚠️ CAUTION: Lying Async on Main Thread
proc heavyComputation*(iterations: int32): Future[int32] {.async, exportts.} =
  var sum = 0'i32
  for i in 0 ..< iterations: # CPU-bound loop!
    sum += i
  return sum
```

Even though TypeScript sees `Promise<number>` and awaits it with `await heavyComputation(100_000_000)`, the CPU loop runs synchronously on the browser's main event loop during that microtask, freezing UI rendering, scrolling, and user interactions.

### When to Use In-Thread `Future[T]` vs `spawnWorker`

| Use Case | Recommended Approach | Mechanism |
| :--- | :--- | :--- |
| **I/O & Network Requests** (`fetch`, API calls) | In-Thread `Future[T]` | Non-blocking callback resumption (`nimts_resume_future`) |
| **Async Timers & Yields** (`sleepAsync`) | In-Thread `Future[T]` | Event-loop timer integration |
| **Cooperative Coroutines** (step-by-step state) | In-Thread `Future[T]` | Microtask event interleaving |
| **Audio DSP & Synthesis** | Dedicated Worker / AudioWorklet | Dedicated thread, zero main thread interference |
| **Physics, Math & Heavy Simulations** | `spawnWorker` (`@axiomantic/nimts/worker`) | Off-thread worker with transparent async RPC |
| **Large Binary Processing / Cryptography** | `spawnWorker` (`@axiomantic/nimts/worker`) | Zero-copy `ArrayBuffer` detachment via Transferable objects |

### Honest Off-Thread Execution via `spawnWorker`

When you need true background parallelism without blocking the browser UI, use `@axiomantic/nimts/worker`:

```typescript
import { spawnWorker } from '@axiomantic/nimts/worker';

// Runs entirely off the main thread in a dedicated Web Worker
const worker = await spawnWorker('./engine.js');

// Executes without freezing the UI thread for even a single millisecond
const sum = await worker.heavyComputation(100_000_000);
```

Or via Vite with `?worker`:

```typescript
import EngineWorker from './engine.nim?worker';
const worker = await new EngineWorker();
const sum = await worker.heavyComputation(100_000_000);
```
