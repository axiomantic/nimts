# Changelog

All notable changes to **NimTS** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
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
  - Authored [Standalone Micro-WASM Backend (`wasm32-wasip1`)](docs/guide/backend-standalone.md) detailing Clang + `wasm-ld` + `wasi-sysroot` toolchain flags, included/excluded features, and AudioWorklet safety.
  - Authored [Emscripten Runtime Backend (`wasm32-unknown-emscripten`)](docs/guide/backend-emscripten.md) detailing `emcc` virtual filesystem (`FS`) and POSIX libc shims.
- **Comprehensive Memory & GC Guide**:
  - Authored [Memory Management, Stateful Handles & Garbage Collection](docs/guide/stateful-handles.md) detailing ARC/ORC destructors, zero GC pause guarantees, ephemeral call lifecycles, and leak hazard mitigations.
- Add multi-repo paths, linker flags discovery, and manifest export in vite-plugin-nimts

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
