# Adversarial Failure Mode Analysis & Negative Controls
**Project**: `nimts`  
**Auditor**: `@nimts-auditor` (Bark-Scraper — Verification & Adversarial Auditor)  
**Target Review**: Proposed subsystem additions (Channels, Closure Iterators, Multi-Module C ABI Namespacing, Universal Async Adapter, JS Target Checks)  
**Date**: 2026-10-17  

---

## Executive Summary
This audit reviews the proposed architectural additions for `nimts` through an adversarial verification lens. While the core primitives (`nimts/memory.nim`, `nimts/macros.nim`, `nimts/codegen.nim`, `nimts/async_bridge.nim`) function correctly for basic synchronous and promise-based single-module invocations, the transition to streaming channels, closure iterators, multi-module linking, and universal target support introduces severe failure modes regarding memory safety, handle reclamation, symbol collisions, and buffer detachment.

---

## 1. Memory Reclamation, Handle Lifecycle Leaks & FinalizationRegistry Guarantees

### Empirical Evidence & Citations
- `src/nimts/memory.nim` lines 66–80:
  ```nim
  proc registerHandle*[T: ref object](obj: T): HandleId =
    if obj.isNil: return InvalidHandleId
    result = gHandleCounter
    inc gHandleCounter
    GC_ref(obj) # <--- Pinned in Nim ARC/ORC root set
    ...
  ```
- `src/nimts/codegen.nim` lines 141–143 & 237–250:
  ```javascript
  const _finalizer = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry(h => {
    if (_exports && _exports.nimts_destroy_handle) _exports.nimts_destroy_handle(h);
  }) : null;
  ...
  export class Typename {
    #handleId = 0;
    constructor(handleId) {
      this.#handleId = handleId;
      if (_finalizer && handleId > 0) _finalizer.register(this, handleId, this);
    }
    dispose() { ... }
  }
  ```

### Identified Failure Modes
1. **ECMA-262 Non-Guarantee of FinalizationRegistry**:
   - Per ECMA-262 §26.2, `FinalizationRegistry` execution is **non-deterministic and not guaranteed**. Engines are explicitly permitted never to run finalizers before process exit or during low memory pressure.
   - If a channel or iterator is abandoned in JavaScript (e.g. `break` out of a `for await...of` loop or an unhandled exception before exhausting the stream), relying on GC/FinalizationRegistry results in permanent memory leaks in Nim's linear heap because `GC_ref(obj)` prevents Nim's ARC/ORC from ever reclaiming the buffer or iterator state.
2. **Abandoned Closure Iterators & Broken Async Iteration Protocols**:
   - Standard JS `AsyncIterator` requires an explicit `.return()` method to handle early termination (`break`, `return`, `throw`).
   - If the generator or channel wrapper does not implement both `.return()` and `[Symbol.asyncDispose]` (TypeScript 5.2+ Explicit Resource Management `await using`), consumers abandoning iterators will leak both the channel handle and any buffered frames.
3. **Closure Iterators Type-Confusion Vulnerability**:
   - In Nim, closure iterators (`iterator(): T {.closure.}`) are internal 2-pointer calling structures `(proc, rawEnv)` or environment pointers. They are **not** standard `ref object` types!
   - Casting a closure iterator directly via `cast[ref object]` or invoking `GC_ref` directly on a raw closure pointer causes memory corruption and instant crashes. Closure iterators **must** be boxed in a dedicated Nim wrapper reference object (e.g., `type NimTsIterWrapper[T] = ref object; iter: proc(): T {.closure.}; isExhausted: bool`).
4. **Stale Handle Access Traps**:
   - In `src/nimts/memory.nim` line 81–90, `getHandle[T](h)` returns `nil` if the handle was already released.
   - Any C ABI wrapper that dereferences the pointer without checking for `nil` causes an immediate WebAssembly `unreachable` trap or segmentation violation.

---

## 2. Ring Buffer Overflow & Backpressure Semantics in WebAssembly

### Identified Failure Modes
1. **Single-Thread Event Loop Deadlocks vs. Data Loss**:
   - In single-threaded WebAssembly (standard browser main thread or Node.js main thread), synchronous blocking is impossible: calling `Atomics.wait` or spin-locking on the main thread throws `RangeError: Atomics.wait cannot be called in this thread` and freezes UI rendering.
   - A ring buffer without backpressure must either:
     - **Drop elements**: Silent loss of audio frames, sensor data, or messages.
     - **Unbounded buffer growth**: Violates memory determinism, rapidly exhausts WASM 32-bit linear heap, and triggers OOM crash.
   - **Requirement**: Channel pushes must support an asynchronous promise-returning API (`async push` / `Future[void]`) with a strict High-Water Mark / Low-Water Mark protocol.
2. **Atomics & Monotonic Wrapping in SPSC Ring Buffers**:
   - For multi-threaded WASM (e.g., `SharedArrayBuffer` between AudioWorklet or Web Worker and Main Thread):
     - Ring buffer indices (`head`, `tail`) must be power-of-two sized (`mask = capacity - 1`).
     - Monotonic counters (`uint32`) must compute occupancy using unsigned subtraction `(head - tail) < capacity` to remain sound across $2^{32}-1$ integer overflow wrapping boundaries.
3. **AudioWorklet Zero-Allocation Invariant**:
   - Inside an `AudioWorkletProcessor.process()` callback, dynamic allocations (`nimts_alloc`, `alloc0`, GC cycles) are strictly forbidden because they trigger audio glitching and thread priority inversions. Ring buffer channels intended for AudioWorklet must be pre-allocated statically at instantiation.

---

## 3. Multi-Module Symbol Collision Vectors in wasm-ld

### Empirical Evidence & Citations
- `src/nimts/macros.nim` lines 102–109 & 229–232:
  ```nim
  var cabiNameStr = "nimts_" & procNameStr
  ...
  companionPragmas.add(newColonExpr(ident("exportc"), newLit(cabiNameStr)))
  ```
- `src/nimts/memory.nim` lines 20–32:
  ```nim
  proc nimts_alloc*(size: int32): pointer {.exportc: "nimts_alloc", cdecl.}
  proc nimts_free*(p: pointer) {.exportc: "nimts_free", cdecl.}
  proc nimts_destroy_handle*(h: HandleId) {.exportc: "nimts_destroy_handle", cdecl.}
  ```

### Identified Failure Modes
1. **Global Unscoped C-ABI Export Collisions**:
   - Currently, all exported procs receive the prefix `nimts_<procName>`.
   - If two modules in the same project (or an application importing two independent NimTS modules) both define `proc process*(x: int)` or `proc init*()`, both emit `{.exportc: "nimts_process".}`.
   - When linked via `wasm-ld`:
     ```text
     wasm-ld: error: duplicate symbol: nimts_process
     >>> defined in module_a.o
     >>> defined in module_b.o
     ```
2. **Runtime Memory Function Multi-Definition**:
   - If multiple compilation units include `nimts/memory.nim` without static linking guards, `nimts_alloc`, `nimts_free`, `nimts_get_last_result_ptr`, and `nimts_destroy_handle` collide in `wasm-ld`.
3. **Namespacing Invariant**:
   - Every module must declare or infer a distinct namespace: `nimts_<moduleName>_<procName>` or pass an explicit `moduleName` parameter to `{.exportts(module = "synth").}`.
   - Core runtime allocator/handle symbols must be exported strictly once by the runtime anchor module.

---

## 4. Unaligned DataView Access, Memory Growth & Pointer Traps

### Empirical Evidence & Citations
- `src/nimts/codegen.nim` lines 187–213 (`_readPrimitive`):
  ```javascript
  function _readPrimitive(bufOrPtr, len, kind) {
    let view;
    if (typeof bufOrPtr === 'number') {
      view = new DataView(_memory.buffer, bufOrPtr, len);
    ...
  ```
- `src/nimts/codegen.nim` lines 151, 156, 163, 170:
  ```javascript
  new Uint8Array(_memory.buffer, ptr, len)
  ```

### Identified Failure Modes
1. **Detached ArrayBuffer Traps on WASM Memory Growth**:
   - Whenever WebAssembly linear memory grows (via `memory.grow` in WASM or `alloc0` expanding pages in Nim), the underlying `_memory.buffer` `ArrayBuffer` is **neutered / detached**.
   - If TypeScript code caches a `Uint8Array` or `DataView` across an asynchronous yield or between function calls where an allocation occurred:
     `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer` is thrown.
   - `_memory.buffer` must **always** be dynamically accessed via `_getBuffer()` accessor and never stored in module-scope variables across async boundaries.
2. **Truncation & Silent Zeroing in Primitive Resolution**:
   - In `_readPrimitive` lines 200–211:
     If a corrupted or truncated packet delivers `len < 8` for `float64` or `int64`, the switch statement silently returns `0`. This masks buffer under-runs and protocol framing corruptions.
   - Truncated buffers must throw an explicit `RangeError: Incomplete buffer for type <kind> (expected N bytes, received M)`.
3. **64-bit Packed Word Truncation in JS Number**:
   - `packBuffer(p, len)` packs 32-bit pointer and 32-bit length into `uint64`.
   - In JS, numbers are IEEE 754 double-precision floats (53-bit mantissa). Bitwise shift operators in JS (`x >> 32`) cast to **32-bit signed integers**!
   - In `src/nimts/codegen.nim` line 179:
     ```javascript
     if (typeof packed === 'bigint') {
       return { ptr: Number(packed & 0xffffffffn), len: Number(packed >> 32n) };
     }
     ```
     If the host environment passes `packed` as a JS Number instead of a BigInt, `_unpackResult64` falls back to `nimts_get_last_result_ptr()` and `nimts_get_last_result_len()`. However, if BigInt WASM integration is disabled (`-Wwasm-bigint` omitted), reading `packed` directly will corrupt pointers $> 2^{31}$.

---

## 5. Mandatory Negative Control Test Suites

The following test suites must be implemented as mandatory gates before accepting Stage 2 & 3 deliverables:

| Test Suite | Target Invariant | Failure Mode Tested | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **`neg_channel_abandon_leak`** | Memory Safety | Abandoning an active async channel mid-stream (`for await` break) without `.dispose()`. | Verified that explicit `.return()` or `.dispose()` reclaims all Nim memory and decrements `activeHandleCount()` to baseline 0. |
| **`neg_channel_overflow_backpressure`** | Backpressure | Pushing to a saturated channel buffer beyond capacity. | Synchronous push throws `ChannelFullError` or returns `false`; async push halts until drained below low-water mark. |
| **`neg_handle_use_after_free`** | Type/Memory Safety | Invoking methods on an explicitly disposed handle ID or random integer ID. | Throws descriptive error `InvalidHandleError`; zero memory corruption, no wasm `unreachable` trap. |
| **`neg_multimodule_symbol_collision`** | Linker Hygiene | Compiling two modules (`alpha.nim`, `beta.nim`) exporting identical proc signatures. | Namespaced exports (`nimts_alpha_run`, `nimts_beta_run`) link cleanly; un-namespaced test confirms `wasm-ld` collision error. |
| **`neg_wasm_memory_grow_detachment`** | Buffer Invariants | Retaining buffer references while triggering a 64MB memory reallocation. | ArrayBuffer neutering handled cleanly; refreshed views access valid data without `TypeError: detached ArrayBuffer`. |
| **`neg_primitive_underflow_alignment`** | FFI Decoding | Passing unaligned buffers (offsets 1, 3, 5, 7) and truncated byte lengths (< 4 or < 8 bytes). | Throws explicit `RangeError`; no silent zeroing or unaligned memory traps. |
