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

### `NimTsIterator[T]`
```nim
type NimTsIterator*[T] = distinct HandleId
```
Distinct type wrapping a `HandleId` for closure iterators. Automatically managed on heap and projected as ES2015 `IterableIterator<T>` in TypeScript.

---

## Channels (`nimts/channels`)

Lock-free circular SPSC queue with a WASM-native ring buffer for high-throughput streaming.

### `type Channel*[T] = NimTsChannel[T]`
Idiomatic type alias for `NimTsChannel[T]` enabling clean, standard Nim syntax.

### `newChannel[T](capacity: int = 64): Channel[T]`
Convenience constructor alias for `newNimTsChannel[T]`. Creates a new SPSC bounded channel with power-of-two capacity (default: 64).

### `newNimTsChannel[T](capacity: int = 64): NimTsChannel[T]`
Creates a new SPSC bounded channel with power-of-two capacity (default: 64).

### `send[T](ch: NimTsChannel[T], item: sink T): bool`
Pushes an item into the channel buffer. Returns `true` on success, or `false` if the buffer is full or closed.

### `tryRecv[T](ch: NimTsChannel[T], item: var T): bool`
Attempts to read an item from the channel. Returns `true` if an item was read, `false` if empty.

### `recv[T](ch: NimTsChannel[T]): Future[T]`
Asynchronously awaits the next available item from the channel.

### `close[T](ch: NimTsChannel[T])`
Closes the channel, notifying consumers that no further items will be produced.

### `nimts_chan_get_raw_ptrs(chanPtr, headPtr, tailPtr, bufPtr, capPtr)`
```nim
proc nimts_chan_get_raw_ptrs*(
  chanPtr: pointer,
  headPtr: ptr int32,
  tailPtr: ptr int32,
  bufPtr: ptr pointer,
  capPtr: ptr int32
) {.exportc, cdecl.}
```
Low-level C-ABI entry point exposing the raw linear memory offsets of the channel's `head`, `tail`, circular element buffer, and `capacity`. Enables zero-overhead shared memory synchronization with JavaScript `SharedArrayBuffer` and `Atomics`.

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

### `registerClosureIter[T](iter: iterator(): T {.closure.}): HandleId`
Registers a closure iterator inside a heap-allocated `ClosureIterSlot[T]`, returning a safe `HandleId` callable from C-ABI and WebAssembly.

---

## Async Coroutine Bridge (`nimts/async_bridge`)

### `AnyFuture[F]`
Duck-typed concept that matches any custom future type (Chronos, CPS, std/asyncdispatch) exposing `.finished`, `.failed`, and `.read`.

### `bridgeFutureToPromise[T](fut: Future[T]): PromiseId`
Attaches a completion callback to `fut`. When `fut` finishes or fails, notifies JavaScript via `nimts_js_resolve_promise` or `nimts_js_reject_promise`.

### `bridgeAnyFutureToPromise[F](fut: F): PromiseId`
Adapts any future conforming to `AnyFuture` into a JavaScript Promise.

### `registerPendingFuture[T](fid: FutureId, fut: Future[T])`
Registers a pending `Future[T]` waiting for JavaScript resumption via `nimts_resume_future`.

### `nimts_resume_future(futureId: int32, dataPtr: pointer, dataLen: int32, isError: int32)`
Called by JavaScript to settle a pending Nim Future. If `isError != 0`, fails the Future with a `NimTsError`.

