# Nim Macro & Bridge API Reference

The `nimts` package exports compile-time macros, types, memory marshaling routines, and coroutine bridge utilities.

---

## Macros

### `{.exportts.}`
Annotates a Nim procedure or type for export to TypeScript and WebAssembly.
- Does **not** modify the native signature or behavior.
- Retains 100% compatibility with native Nim callers.
- Automatically generates companion C-ABI entry points prefixed with `nimts_`.

```nim
proc add*(a: int32, b: int32): int32 {.exportts.} =
  a + b
```

### `exportTs*(target: untyped)`
A freestanding macro that registers an existing procedure or type definition for export.

```nim
import core_dsp

exportTs(SynthEngine)
exportTs(computeSample)
```

### `emitTsGlueFiles*(moduleName: static[string], outputDir: static[string] = ".")`
Compile-time macro that generates `<moduleName>.d.ts` and `<moduleName>.js` glue code for all registered exports. Typically executed in a `static:` block at the end of the entry-point module.

```nim
static:
  emitTsGlueFiles("my_module", "dist")
```

### `{.importts.}`
Annotates an imported foreign JavaScript function returning a `Future[T]`.

```nim
proc jsFetch*(url: cstring): Future[seq[byte]] {.importts.}
```

---

## Types (`nimts/types`)

### `HandleId`
```nim
type HandleId* = int32
const InvalidHandleId*: HandleId = 0
```
An opaque integer identifier representing a heap-allocated `ref object` registered in the handle table.

### `NimTsHandle[T]`
```nim
type NimTsHandle*[T] = distinct HandleId
```
Distinct type wrapping a `HandleId` for compile-time type safety.

### `PromiseId` & `FutureId`
```nim
type
  PromiseId* = int32
  FutureId* = int32
```
Monotonic identifiers representing active coroutines in the async bridge.

---

## Memory Marshaling (`nimts/memory`)

### `nimts_alloc(size: int32): pointer`
Allocates zero-initialized memory in WebAssembly linear memory.

### `nimts_free(p: pointer)`
Frees memory previously allocated via `nimts_alloc`.

### `registerHandle[T: ref object](obj: T): HandleId`
Registers an active `ref object` instance in the handle table, invokes `GC_ref(obj)`, and returns a unique `HandleId`.

### `getHandle[T: ref object](h: HandleId): T`
Retrieves the typed `ref object` associated with `h`. Returns `nil` if the handle is invalid or was released.

### `releaseHandle(h: HandleId)`
Removes the handle from the table and calls `GC_unref` on the underlying object.

---

## Async Coroutine Bridge (`nimts/async_bridge`)

### `bridgeFutureToPromise[T](fut: Future[T]): PromiseId`
Attaches a completion callback to `fut`. When `fut` finishes or fails, notifies JavaScript via `nimts_js_resolve_promise` or `nimts_js_reject_promise`.

### `registerPendingFuture[T](fid: FutureId, fut: Future[T])`
Registers a pending `Future[T]` waiting for JavaScript resumption via `nimts_resume_future`.

### `nimts_resume_future(futureId: int32, dataPtr: pointer, dataLen: int32, isError: int32)`
Called by JavaScript to settle a pending Nim Future. If `isError != 0`, fails the Future with a `NimTsError`.
