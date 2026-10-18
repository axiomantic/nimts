# Understanding Document: Advanced Subsystems (Channels, Iterators, Multi-Module Namespacing, Universal Async)

**Swarm Deliberation:** Triad `@nimts-architect`, `@nimts-auditor`, `@nimts-implementer`  
**Date:** 2026-10-17  
**Status:** Fact-Checked & Ratified  

---

## 1. Domain Glossary & Invariants

- **`NimTsChannel[T]`**: Typed FIFO communication pipe between Nim and TypeScript/JavaScript. Implemented as a lock-free SPSC (Single Producer, Single Consumer) circular ring-buffer residing in WebAssembly linear memory (`std/atomics`). Direct pointer extraction (`nimts_chan_get_raw_ptrs`) enables zero-copy shared memory mapping via `SharedArrayBuffer` / `Atomics`. Note: nimts exclusively targets WebAssembly (standalone wasm-ld and Emscripten) because memory.nim and channels.nim require raw linear memory pointers and atomics, which cannot run on pure nim js.
- **`NimTsIterator[T]`**: Wrapper around Nim's 2-word fat pointer closure iterators (`iterator(): T {.closure.}`). Managed on the heap via `ClosureIterSlot[T]` and exposed through a stateful `HandleId`.
- **Two-Point Diff**: Every new capability must be evidenced by both a Provider (Nim module / C-ABI export) and an active Consumer (live TypeScript caller / test harness).
- **Early Loop Return Guarantee**: When consumer executes `break` or `throw` in `for await` or `for..of`, JS engine automatically invokes `.return()`, immediately calling `nimts_channel_close` or `nimts_iter_dispose`.

---

## 2. Empirical Findings & Constraints

1. **Atomics & WebAssembly Exclusivity (`channels.nim`)**:
   - `nimts` exclusively targets WebAssembly (standalone `wasm-ld` and Emscripten). Pure JavaScript (`nim js`) is unsupported because `channels.nim` and `memory.nim` require raw linear memory pointers and `std/atomics`.
   - In single-threaded WASM (`compileOption("threads") == false`), wait-free SPSC queue works without blocking or `Atomics.wait`.
   - In multi-threaded WASM (`--threads:on`), atomics compile to `i32.atomic.*` and map directly to `SharedArrayBuffer` / `Atomics` in JavaScript.
2. **Buffer Detachment on `memory.grow` (`codegen.nim:187-213`)**:
   - When WASM heap grows, existing `_memory.buffer` instances in JS are detached.
   - Retaining stale `ArrayBuffer` views across asynchronous ticks produces `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer`.
   - Fresh views must be instantiated from `_memory.buffer` on each read/write tick.
3. **Linker Duplicate Symbol Collision (`macros.nim:102`)**:
   - Exporting `nimts_<procName>` causes duplicate symbol linker failures in `wasm-ld` when multiple `.nim` modules export common procedure names (`init`, `update`, `reset`).
   - Namespacing to `nimts_<module>_<procName>` completely partitions symbols at link time.
4. **Decoupling from `std/asyncdispatch` (`async_bridge.nim:4`)**:
   - Hardcoding `std/asyncdispatch.Future[T]` breaks projects using `chronos` due to conflicting reactor loop definitions.
   - Using concept duck-typing (`when compiles(fut.addCallback(...))`) enables zero-cost static dispatch across any future-like type.
