# Stage 1 Architecture Thesis: WASM/JS Concurrency Topology, Closure Iterators, Module Namespacing, and Universal Future Adapters

**Author:** Spindle-Weft (`@nimts-architect`), Staff Systems Architect & FFI Protocol Theorist  
**Target Repository:** `nimts`  
**Date:** 2026-10-17  
**Status:** Ratified Proposal for Stage 1 Architectural Foundation  

---

## 1. Concurrency Topology: Lock-Free SPSC Channels (WASM) vs Native JS Fallback (`defined(js)`)

### 1.1 Empirical Analysis of `lockfree/bqueue.nim`
- **SPSC Bounded Queue Topology:** In `/Users/eek/Development/lockfree/src/lockfree/bqueue.nim`, lines 230–234 define `SpscBoundedQueue*[T; N: static int] = BQueue[T, ccSingle, ccSingle, N, 0, 0]`, an array-based wait-free circular buffer with cacheline separation.
- **Memory & Field Layout Invariants:**
  ```nim
  # Lines 205-208 in bqueue.nim:
  when ccProd == ccSingle and ccCons == ccSingle:
    head* {.align: CacheLineBytes.}: Atomic[int]
    tail* {.align: CacheLineBytes.}: Atomic[int]
    storage*: StorageN1[N, SlotEncoding(T)]
  ```
  The layout is verified at compile-time via static `offsetOf` assertions (lines 298–304) matching `SpscBase[8, int]`.
- **Push / Pop Semantics:** Push (lines 510–530) and Pop (lines 573–636) execute completely wait-free via `spsc_push.start[N]()` and `spsc_pop.start[N]()`. They require only single-threaded read/write pointers and atomic acquire/release loads/stores.
- **Backend Restriction in `lockfree/atomics.nim`:** Lines 38–47 explicitly mandate:
  ```nim
  when not (defined(gcc) or defined(llvm_gcc) or defined(clang) or defined(nintendoswitch) or defined(vcc)):
    {.error: "debra/atomics requires gcc, clang...".}
  ```

### 1.2 Target Topology Split: WASM vs JS
1. **WebAssembly Target (`defined(wasm)` / `defined(nimtsWasm)` / Clang/LLVM):**
   - In WASM with threads enabled (`-pthread` / `atomics`), Clang compiles `Atomic[int]` directly into WebAssembly atomic memory instructions (`i32.atomic.load`, `i32.atomic.store`, `memory.atomic.wait32`, `memory.atomic.notify`).
   - `BQueue[T, ccSingle, ccSingle, N, 0, 0]` can reside directly in linear WebAssembly memory (`SharedArrayBuffer`).
   - Host JS (Web Worker or UI Thread) interacts directly with the buffer using JavaScript `Atomics.load(i32View, headIdx)` and `Atomics.store(i32View, tailIdx)`.
   - Result: High-throughput, zero-copy, wait-free SPSC channel between JS and WASM.
2. **Pure JavaScript Target (`when defined(js)`):**
   - The JS backend does NOT run through Clang/LLVM; `lockfree/atomics.nim` traps with a compile-time error.
   - JavaScript's execution model is single-threaded and run-to-completion on an event loop. A spinning lock-free loop will freeze the browser or Node.js event loop.
   - **Architectural Decision:** Implement a clean target branch:
     - Under `when not defined(js)`: Use `lockfree/bqueue` for wait-free linear memory queues.
     - Under `when defined(js)`: Provide `JsSpscChannel[T]` backed by a contiguous circular ring buffer (`array[N, T]` with non-atomic modular integer indexing) and an asynchronous channel pattern where empty `pop()` returns a JS `Promise<T>` resolved when the producer calls `push(val)`.

---

## 2. Closure Iterator Lifecycle & Mapping to TypeScript `IterableIterator<T>`

### 2.1 Nim Closure Iterator Execution Model
- Nim closure iterators (`iterator iter(): T {.closure.}`) are compiled as 2-word fat pointers: `(procPointer, environmentPointer)`.
- The environment pointer holds captured state and local frame variables managed by Nim's memory runtime (ARC/ORC).
- Exposing a raw function pointer to WebAssembly fails because JS cannot invoke or inspect the closure environment directly.

### 2.2 Protocol Architecture: Managed Iterator Handles
1. **Handle Allocation & Lifecycle Tracking:**
   When an exported proc returns a closure iterator, `nimts` wraps `(proc, env)` into a heap-allocated record:
   ```nim
   type
     ClosureIterSlot[T] = object
       iter: proc(): T {.closure.}
       finished: bool
   ```
   Stored in a global iterator handle table (`gIteratorTable: Table[HandleId, ClosureIterSlot[T]]`).
2. **Exported C-ABI Control Surface:**
   - `nimts_<module>_iter_next(handleId: int32, outValPtr: ptr NimTsBuffer): int32`
     - Returns `0`: Success (value written to `outValPtr`).
     - Returns `1`: Finished / Done.
     - Returns `-1`: Exception thrown during iteration.
   - `nimts_<module>_iter_dispose(handleId: int32): void`
     - Removes the iterator from `gIteratorTable`, immediately releasing the closure environment to ARC/ORC deallocation.
3. **TypeScript Projection (`IterableIterator<T>` Invariant):**
   The TypeScript glue generates a class satisfying the standard ES2015 iterator and iterable protocol:
   ```typescript
   export class NimIterator<T> implements IterableIterator<T> {
     private handleId: number;
     private done: boolean = false;

     constructor(handleId: number) {
       this.handleId = handleId;
       _finalizer?.register(this, handleId);
     }

     next(): IteratorResult<T, undefined> {
       if (this.done) return { done: true, value: undefined };
       const res = _exports.nimts_iter_next(this.handleId);
       if (res.done) {
         this.dispose();
         return { done: true, value: undefined };
       }
       return { done: false, value: res.value };
     }

     return(): IteratorResult<T, undefined> {
       this.dispose();
       return { done: true, value: undefined };
     }

     [Symbol.iterator](): IterableIterator<T> {
       return this;
     }

     dispose(): void {
       if (!this.done) {
         _exports.nimts_iter_dispose(this.handleId);
         this.done = true;
       }
     }
   }
   ```
   **Early Exit Invariant:** When a JS consumer executes `break`, `return`, or throws inside a `for (const item of iter)` loop, JavaScript engines automatically invoke `.return()`. Mapping `.return()` directly to `dispose()` guarantees zero memory leaks in WebAssembly linear memory even on abnormal loop termination.

---

## 3. Module Namespacing (`nimts_<module>_<procName>`) & `wasm-ld` Collision Elimination

### 3.1 Empirical Vulnerability in Current Macro Architecture
- In `src/nimts/macros.nim` (line 102):
  ```nim
  var cabiNameStr = "nimts_" & procNameStr
  ```
- If two separate modules (e.g. `audio.nim` and `physics.nim`) export functions with common names like `init()`, `update()`, `reset()`, or `step()`, LLVM linker `wasm-ld` will abort the build:
  `wasm-ld: error: duplicate symbol: nimts_init`
- In addition, runtime allocation entrypoints in `src/nimts/codegen.nim` (`nimts_alloc`, `nimts_free`, `nimts_destroy_handle`) are currently exported unpartitioned.

### 3.2 Namespacing Protocol & Architecture
1. **Module Name Derivation:**
   - Explicit: `{.exportts(module = "audio").}`
   - Automatic Fallback: Derive module slug from `instantiationInfo().filename` normalized to snake_case.
2. **C-ABI Export Structure:**
   - Every procedure export is assigned the canonical symbol name:
     `nimts_<module>_<procName>` (e.g., `nimts_audio_init`, `nimts_physics_init`).
   - If proc overloading occurs within the same module, append `_<idx>` disambiguation: `nimts_audio_init_1`.
3. **Core Runtime vs Module Symbols:**
   - Shared runtime functions (`nimts_alloc`, `nimts_free`, `nimts_get_last_result_ptr`, `nimts_resume_future`) remain unified in `nimts/runtime.nim` as singleton runtime exports.
   - Module functions are strictly isolated under their `<module>` prefix.
4. **TypeScript Interface Generation:**
   - Generates modular namespaces or sub-interfaces:
     ```typescript
     export interface AudioExports {
       init(sampleRate: number): void;
     }
     export interface PhysicsExports {
       init(gravity: number): void;
     }
     ```
   - Prevents both linker collisions at build-time and property collisions in JavaScript runtimes.

---

## 4. Universal Concept-Based Async Future Adapter (Chronos / asyncdispatch / CPS)

### 4.1 Empirical Vulnerability in Current Async Bridge
- In `src/nimts/async_bridge.nim` (line 4):
  ```nim
  import std/asyncdispatch
  ```
  `bridgeFutureToPromise*[T](fut: Future[T])` is directly locked to `std/asyncdispatch.Future[T]`.
- Projects utilizing `chronos` (the standard asynchronous engine for Ethereum, Nim-Libp2p, and Status) or `cps` cannot use `nimts` because importing `std/asyncdispatch` causes fatal compiler conflicts with `chronos` types and event loop polling pumps.

### 4.2 Concept-Based Future Trait Architecture
We replace hard-coded imports with a zero-cost compile-time Concept & Trait Adapter:

1. **Future Concept Definition:**
   ```nim
   type
     AnyFuture*[F, T] = concept f
       f.finished is bool or f.completed() is bool
       f.failed is bool or f.failed() is bool
   ```

2. **Decoupled Future Adapter Interface (`FutureAdapter[F, T]`):**
   ```nim
   type
     FutureAdapter*[F, T] = object
       isFinished*: proc(f: F): bool
       isFailed*: proc(f: F): bool
       readResult*: proc(f: F): T
       readErrorMsg*: proc(f: F): string
       addCallback*: proc(f: F, cb: proc() {.gcsafe.})
   ```

3. **Pluggable Modular Implementations:**
   - `nimts/adapters/asyncdispatch_adapter.nim`: Implements traits for `std/asyncdispatch.Future[T]`.
   - `nimts/adapters/chronos_adapter.nim`: Implements traits for `chronos.Future[T]` (`completed()`, `read()`, `error.msg`).
   - `nimts/adapters/cps_adapter.nim`: Implements continuation hooks.

4. **Zero-Overhead Static Dispatch:**
   By using static templates and `when defined(...)`:
   ```nim
   when defined(nimtsChronos):
     import ./adapters/chronos_adapter
     export chronos_adapter
   elif defined(nimtsAsyncDispatch) or not defined(nimtsCustomAsync):
     import ./adapters/asyncdispatch_adapter
     export asyncdispatch_adapter
   ```
   Users configure their chosen async framework with a single flag (`-d:nimtsChronos`), maintaining full type safety and zero runtime overhead.

---

## 5. Summary & Next Steps
This architecture thesis establishes the formal foundation for Phase 2 implementation:
- [x] Lock-free SPSC channel topology partitioned between WASM linear memory and JS event-loop fallbacks.
- [x] Closure iterator lifecycle with managed handle tracking and ES2015 `IterableIterator<T>` compliance.
- [x] Deterministic `nimts_<module>_<procName>` namespacing eliminating `wasm-ld` collisions.
- [x] Pluggable concept-based future adapter supporting `chronos`, `asyncdispatch`, and `cps`.
