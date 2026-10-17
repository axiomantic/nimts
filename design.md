# System Architecture Design: Advanced Subsystems in `nimts`

**Ratified By:** Spindle-Weft (`@nimts-architect`), Bark-Scraper (`@nimts-auditor`), Sprocket-Spark (`@nimts-implementer`)  
**Date:** 2026-10-17  
**Status:** Approved for Implementation Planning  

---

## 1. Subsystem Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │          Nim Language Surface          │
                      │  {.exportts.}  NimTsChannel  Iterator   │
                      └──────────────────┬─────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
         [ WASM / C Backend ]                             [ JS Backend ]
      • SPSC Ring Buffer Queue                       • Native JS Microtask Queue
      • Module-Namespaced C-ABI                      • Direct JS Prototype Exports
      • DataView Memory Marshaling                   • Native Object / Promise
                 │                                               │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                      ┌────────────────────────────────────────┐
                      │       TypeScript / Vite Consumer       │
                      │  AsyncIterable<T>  IterableIterator<T> │
                      │  for await (...)   for (const x of ..) │
                      └────────────────────────────────────────┘
```

---

## 2. Detailed Technical Specifications

### Component 1: `NimTsChannel[T]` & Concurrency Topology
- **Nim API**:
  ```nim
  type NimTsChannel*[T] = ref object
  proc newNimTsChannel*[T](capacity: int = 64): NimTsChannel[T]
  proc send*[T](chan: NimTsChannel[T], item: T): bool
  proc tryRecv*[T](chan: NimTsChannel[T]): Option[T]
  proc isClosed*[T](chan: NimTsChannel[T]): bool
  proc close*[T](chan: NimTsChannel[T])
  ```
- **WASM Implementation**:
  - Wait-free circular ring buffer with power-of-two capacity and unsigned modular arithmetic to prevent wrap-around corruption.
  - High-water mark cooperative backpressure: `send()` returns `false` when full.
  - Exposed via C-ABI handle entrypoints:
    - `nimts_<module>_chan_send(handleId, dataPtr, dataLen): int32`
    - `nimts_<module>_chan_try_recv(handleId): uint64` (packed ptr + len)
    - `nimts_<module>_chan_is_closed(handleId): int32`
    - `nimts_<module>_chan_close(handleId): void`
- **TypeScript Consumer Interface**:
  - Implements `AsyncIterable<T>` and `AsyncIterator<T>`:
    ```typescript
    export class NimTsChannel<T> implements AsyncIterable<T> {
      async next(): Promise<IteratorResult<T, undefined>>;
      async return(): Promise<IteratorResult<T, undefined>>; // Triggered by early break
      close(): void;
      send(item: T): boolean;
      [Symbol.asyncIterator](): AsyncIterator<T>;
    }
    ```

### Component 2: Closure Iterators (`NimTsIterator[T]`)
- **Nim API**:
  ```nim
  type ClosureIterSlot[T] = ref object
    iter: iterator(): T {.closure.}
    finished: bool
  ```
- **C-ABI Control Surface**:
  - `nimts_<module>_iter_next(handleId): uint64` (packed ptr + len, 0 when done)
  - `nimts_<module>_iter_finished(handleId): int32`
  - `nimts_<module>_iter_dispose(handleId): void`
- **TypeScript Consumer Interface**:
  - Implements `IterableIterator<T>`:
    ```typescript
    export class NimTsIterator<T> implements IterableIterator<T> {
      next(): IteratorResult<T, undefined>;
      return(): IteratorResult<T, undefined>; // Loop break cleanup
      dispose(): void;
      [Symbol.iterator](): IterableIterator<T>;
    }
    ```

### Component 3: Multi-Module Linker Namespacing
- **Symbol Template**:
  ```nim
  let moduleSlug = cleanModuleName(procDef.lineInfoObj.filename)
  let cabiNameStr = "nimts_" & moduleSlug & "_" & procNameStr & (if overloadCount > 0: "_" & $overloadCount else: "")
  ```
- **Singletons**: Core memory allocators (`nimts_alloc`, `nimts_free`, `nimts_get_last_result_ptr`, `nimts_resume_future`) remain unified singletons in `runtime.nim`.
- **Guarantee**: Eliminates `wasm-ld: duplicate symbol` link errors when multiple modules are imported.

### Component 4: Universal Concept-Based Future Adapter
- Compile-time duck typing in `src/nimts/async_bridge.nim`:
  ```nim
  template bridgeAnyFuture*[Fut](fut: Fut): PromiseId =
    when compiles(fut.addCallback(proc(f: auto) = discard)):
      # asyncdispatch
      fut.addCallback proc(f: auto) = handleResolve(f)
    elif compiles(fut.addCallback(proc(ud: pointer) = discard)):
      # chronos
      fut.addCallback proc(ud: pointer) = handleResolve(fut)
  ```
- Works out-of-the-box with `std/asyncdispatch`, `chronos` (`-d:nimtsChronos`), or custom futures without modifying caller code.

---

## 3. Negative Controls & Invariant Test Matrix

| ID | Failure Mode | Test Assertion | Location |
|:---|:---|:---|:---|
| **NEG-01** | Channel Abandon Leak | Handle count decreases to baseline upon early `break` in `for await` | `test_wasm_sync_and_async.test.ts` |
| **NEG-02** | Ring Buffer Overflow | `send()` returns `false` on saturated queue; no silent buffer overwrite | `test_memory.nim` |
| **NEG-03** | Use-After-Free | Calling `iter.next()` after `dispose()` returns `{ done: true }` without crashing | `test_wasm_sync_and_async.test.ts` |
| **NEG-04** | Multi-Module Collision | Link two modules exporting identical proc names (`init`, `reset`) via `wasm-ld` | `test_codegen.nim` |
| **NEG-05** | Memory Growth Detachment | Active stream continues correctly after `_exports.memory.grow(1)` | `test_wasm_sync_and_async.test.ts` |
