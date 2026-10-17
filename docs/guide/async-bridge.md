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
