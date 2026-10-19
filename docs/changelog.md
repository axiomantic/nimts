# Changelog & Release Notes

All notable changes across NimTS releases are documented below.

For release artifacts, pre-packaged tarballs, and git release tags, visit [GitHub Releases](https://github.com/axiomantic/nimts/releases).

---

## [Unreleased]

---

## [0.2.1] - 2026-10-19

### Added
- **LaTeX Math Rendering**: Enabled client-side LaTeX and formula rendering across the VitePress documentation using `markdown-it-mathjax3` (`markdown: { math: true }`).

### Documentation & Architecture
- **Async & Threading Architecture**: Rewrote `docs/guide/async-bridge.md` to establish clear, forward-facing technical principles:
  - Synchronous execution of standard WebAssembly on the caller's thread with sub-nanosecond register speed.
  - Dedicated background execution via Web Workers (`?worker` / `@axiomantic/nimts/worker`) and AudioWorklet for CPU/DSP computation.
  - Clean separation of concerns with TypeScript managing browser I/O (`fetch`, timers) and passing buffers directly to Nim.
  - Reframed `Future[T]` as a low-level FFI callback bridge for host resumption, purging misleading in-thread cooperative coroutine claims.
- **Terminology Cleanliness**: Scrubbed internal conversational jargon from user-facing guides and updated navigation to "Async & Threading".

---

## [0.2.0] - 2026-10-18

### Added
- **First-Class WebAudio AudioWorklet Support (`@axiomantic/nimts/worklet` & `.nim?worklet`)**:
  - Implemented `{.exporttsWorklet.}` and `{.exportts, audioProcess.}` pragma macros in `src/nimts/macros.nim` and `src/nimts/codegen.nim`.
  - Added `@axiomantic/nimts/worklet` runtime with `NimTsAudioWorkletProcessor` supporting WASI snapshot preview 1 mocks, zero-copy `Float32Array` audio render callbacks, and parameter automation.
  - Implemented `createWorkletProcessorScript` bundle code generator for inline Blob URL worklet script loading.
  - Implemented strongly typed `NimTsWorkletClient<T>` with thenable-safe RPC proxy, event subscriptions (`.on()`), and WebAudio graph routing (`.connect()`).
  - Added `.nim?worklet` Vite query support in `vite-plugin-nimts` generating `createWorklet` factory and `NimWorkletNode`.
- **Zero-Copy Pinned TypedArray Views (`NimTsView[T]`)**:
  - Implemented `NimTsView*[T]` in `src/nimts/types.nim` and `initNimTsView` / `newNimTsView` in `src/nimts/memory.nim`, exposing live zero-copy views into Nim data structures across the C-ABI boundary via `packNimTsViewResult`.
  - Added `NimTsView` class and `createNimTsView` proxy factory in `ts/runtime.ts` and `src/nimts/codegen.nim`.
  - Enabled direct array indexing (`view[i]`), slice/subarray operations, iterator support (`for..of`), and live bidirectional mutations between Nim and JavaScript/TypeScript without intermediate allocations or JSON serialization.
  - Implemented dynamic detachment resilience: automatically detects WebAssembly `memory.grow()` reallocations and transparently re-binds the underlying TypedArray view to the new `ArrayBuffer`.
  - Added `createView<T>(pointer, length, ctor)` helper method to `NimTsRuntime`.
- **Binary TypedArray ABI Marshaling for `seq[T]` / `openArray[T]`**:
  - Implemented raw binary TypedArray marshaling across the WASM C-ABI boundary for numeric slices (`openArray`/`seq` of `byte`/`uint8`, `int8`, `int16`, `uint16`, `int32`, `uint32`, `float32`, `float64`, `int64`, `uint64`).
  - Completely bypassed JSON text serialization and string parsing for numeric collections, replacing them with direct binary pointer/length descriptor passing (`packBuffer`) and `.slice()` views over `wasmMemory.buffer`.
  - Added `allocTypedArrayResult[T]` and `readTypedArray[T]` in `src/nimts/memory.nim` with zero intermediate allocations for `openArray[T]`.
  - Added `readTypedArray` and `passTypedArray` in `ts/runtime.ts` and generated TypeScript / JavaScript glue wrappers.
- **Multi-Repo & Linker Discovery in `vite-plugin-nimts`**:
  - Added `nimPaths` (`--path:...`), `clangFlags` (`--passC:...`), `linkerFlags` (`--passL:...`), `cwd`, and `watchGlobs` plugin options.
  - Automated export of symbols referenced in `_nimts_exports.json` manifest via `-Wl,--export=...` / wasm-ld.
  - Added transitive `.nim` import and include dependency tracking for instant Vite HMR invalidation across local packages.
- **Multi-Threaded Web Worker Runtime (`@axiomantic/nimts/worker`)**:
  - Implemented `spawnWorker(moduleUrl, options)` providing transparent async RPC proxying to background Web Workers.
  - Added Vite `?worker` query syntax support (`import SynthWorker from './synth.nim?worker'`) for effortless zero-config worker instantiation.
  - Implemented bidirectional zero-copy `ArrayBuffer` detachment via Transferable objects (`extractTransfers`) for both call arguments (Main &rarr; Worker) and return values (Worker &rarr; Main).
  - Automated `Future[T]` to `Promise<T>` settlement inside worker threads.
- **Wait-Free SPSC Channels (`NimTsChannel[T]` / `Channel[T]`)**:
  - Implemented high-performance lock-free Single-Producer Single-Consumer ring buffer in `src/nimts/channels.nim` with monotonic atomic head/tail indices.
  - Added idiomatic `Channel[T]` alias and `newChannel[T](capacity)` constructor.
  - Added `nimts_chan_get_raw_ptrs` C-ABI export for zero-copy memory inspections.
  - Implemented `AsyncIterable<T>` streaming wrapper in TypeScript runtime (`for await (const chunk of channel)`).
  - Implemented channel chunk streaming across `MessagePort` with per-item buffer detachment.
- **WebGPU 256-Byte Aligned Allocator & Storage Buffers**:
  - Implemented `nimts_alloc_aligned` and `nimts_free_aligned` in `src/nimts/memory.nim`, supporting power-of-two alignments with a base-pointer prefix header.
  - Enforced 256-byte alignment matching WebGPU's `minUniformBufferOffsetAlignment` standard.
  - Added `GpuBufferSlice[T]` in Nim and TypeScript with direct, zero-copy `device.queue.writeBuffer` transfers from WASM linear memory into GPU staging buffers.
- **Dual-Tier Nim Architecture (`src/nimts/js_client.nim`)**:
  - Created client module for Nim JS applications (`nim js`) allowing DOM/UI layers (Karax, standard DOM) to consume `nimts` WASM modules with native Nim signatures and zero handwritten JS/TS glue.
  - Added `NimTsJsModule`, `loadNimTsModule`, `loadNimTsExports`, `toFuture`, `toUint8Array`, and `toSeqByte`.
  - Added automated `test:nim-js` integration suite compiled via `nim js -d:nodejs`.
- **Dedicated Backend Architecture Guides**:
  - Authored [Standalone Micro-WASM Backend (`wasm32-wasip1`)](./guide/backend-standalone.md) detailing Clang + `wasm-ld` + `wasi-sysroot` toolchain flags, included/excluded features, and AudioWorklet safety.
  - Authored [Emscripten Runtime Backend (`wasm32-unknown-emscripten`)](./guide/backend-emscripten.md) detailing `emcc` virtual filesystem (`FS`) and POSIX libc shims.
- **Comprehensive Memory & GC Guide**:
  - Authored [Memory Management, Stateful Handles & Garbage Collection](./guide/stateful-handles.md) detailing ARC/ORC destructors, zero GC pause guarantees, ephemeral call lifecycles, and leak hazard mitigations.

### Changed
- **Honest Concurrency**: Purged single-threaded fake async/await heuristic (`poll()` loop) in favor of true off-thread Web Worker execution.
- **Terminology Cleanliness**: Eliminated internal development jargon ("honest async", "lying async") across documentation in favor of standard engineering terms (*Multi-Threaded Web Worker Runtime*, *Background Promise*, *CPU-Bound Main Thread Pitfall*).
- **Streamlined README**: Simplified `README.md` to mirror the getting started guide with a 3-step Quickstart, side-by-side consumption patterns, and fact-checked WebAssembly gotchas table.

### Removed
- **`defined(js)` Purge**: Purged all vestigial `when defined(js)` and `when not defined(js):` branches across `src/nimts/channels.nim` and `tests/test_channels.nim` since WebAssembly linear memory is the default and only expectation for core channels.

---

## [0.1.0] - 2026-10-17

### Added
- Initial public release of **NimTS**.
- Non-invasive `{.exportts.}` macro preserving 100% native Nim procedure signatures.
- Companion C-ABI code generation and automatic TypeScript `.d.ts` declaration generation.
- Support for primitive types (`int32`, `float32`, `float64`, `bool`), UTF-8 strings (`string`, `cstring`), and binary byte arrays (`openArray[byte]`, `seq[byte]`).
- Stateful opaque handles for `ref object` instances with `GC_ref`/`GC_unref`, deterministic `.dispose()`, and `FinalizationRegistry` safety nets.
- Bidirectional async bridge connecting Nim `std/asyncdispatch` (`Future[T]`) to JavaScript `Promise<T>`.
- Official Vite plugin (`@axiomantic/nimts/vite`) for direct `.nim` imports with on-the-fly background WASM compilation and hot module reloading.
- Standalone CLI compiler tool (`nimts compile`) supporting both Standalone micro-WASM and Emscripten compilation backends.
- Complete documentation suite with VitePress deployed to GitHub Pages.
