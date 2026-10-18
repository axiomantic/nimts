# Implementation Plan: Advanced Subsystems (Channels, Iterators, Multi-Module Namespacing, Universal Async)

## 1. Swarm Roster & Role Mapping
| Worker Name | Persona | Role | Assigned Subsystems |
| :--- | :--- | :--- | :--- |
| `nimts-architect` | Spindle-Weft | Staff Systems Architect & FFI Protocol Theorist | SPSC channel topology, universal async traits, module namespacing |
| `nimts-auditor` | Bark-Scraper | Verification & Adversarial Auditor | Negative controls, memory leak audit, buffer detachment, Two-Key gate |
| `nimts-implementer` | Sprocket-Spark | DevEx & High-Throughput Implementation Lead | Closure iterators, TypeScript codegen, AsyncIterable projections, tests |

---

## 2. Distributed Locking & Concurrency Schedule
Before modifying any shared or non-mergeable files, the designated worker must obtain an atomic lease:
- **Lock Target**: `file:src/nimts/channels.nim`
  - *Owner*: `nimts-architect`
  - *Command*: `rhizo lock file:src/nimts/channels.nim 600 --fencing`
- **Lock Target**: `file:src/nimts/macros.nim`
  - *Owner*: `nimts-architect`
  - *Command*: `rhizo lock file:src/nimts/macros.nim 600 --fencing`
- **Lock Target**: `file:src/nimts/codegen.nim`
  - *Owner*: `nimts-implementer`
  - *Command*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
- **Lock Target**: `file:tests/fixtures/test_module.nim`
  - *Owner*: `nimts-implementer`
  - *Command*: `rhizo lock file:tests/fixtures/test_module.nim 600 --fencing`

---

## 3. Vine Strand Lifecycle & Verification Matrix
For all parallel development tracks:
1. **Provision Strand**: `vine new <task_id> --branch strand/<task_id> --worktree`
2. **Execute Work**: Implement code changes, unit tests, and formatters.
3. **Two-Key Gate Verification**: `vine gate --json` (Key 1: in-memory merge-tree PASS + Key 2: compiler/test suite PASS).
4. **Trunk Weaving**: Fast-forward verified branch into main (`vine weave`).

---

## 4. Phase-by-Phase Task Checklist

### Phase 1: Core Engine Primitives
- [x] **Task 1.1: `NimTsChannel[T]` & Lockfree SPSC Topology** (`nimts-architect`)
  - *Strand*: `strand/channels-spsc`
  - *Lock*: `rhizo lock file:src/nimts/channels.nim 600 --fencing`
  - *Provider*: `src/nimts/channels.nim` (wait-free SPSC circular queue with WASM/JS target split)
  - *Consumer / Call-Site*: Wire into `src/nimts.nim` exports and channel C-ABI
  - *Verification*: `nimble test` passes channel unit tests
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/channels.nim` [WOVEN]

- [x] **Task 1.2: Multi-Module Linker Namespacing & Universal Future Adapter** (`nimts-architect`)
  - *Strand*: `strand/namespacing-async`
  - *Lock*: `rhizo lock file:src/nimts/macros.nim 600 --fencing`
  - *Provider*: `src/nimts/macros.nim` (`nimts_<module>_<proc>` C-ABI) and `src/nimts/async_bridge.nim` (`AnyFuture[F, T]` duck-typing)
  - *Consumer / Call-Site*: Wire into `classifyReturnType` and `processExportTs`
  - *Verification*: `test_codegen.nim` and `wasm-ld` multi-module link test passes
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/macros.nim` [WOVEN]

- [x] **Task 1.3: Closure Iterator Handles & C-ABI Control Surface** (`nimts-implementer`)
  - *Strand*: `strand/closure-iterators`
  - *Lock*: `rhizo lock file:src/nimts/types.nim 600 --fencing`
  - *Provider*: `src/nimts/types.nim` and `src/nimts/memory.nim` (`ClosureIterSlot[T]`, `nimts_iter_next`, `nimts_iter_dispose`)
  - *Consumer / Call-Site*: Wire into `macros.nim` return type classification
  - *Verification*: `test_memory.nim` verifies slot allocation, invocation, and deterministic teardown
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/types.nim` [WOVEN]

### Phase 2: Codegen & TypeScript Projections
- [x] **Task 2.1: `AsyncIterable<T>` & `IterableIterator<T>` TypeScript Codegen** (`nimts-implementer`)
  - *Strand*: `strand/ts-codegen`
  - *Lock*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
  - *Provider*: `src/nimts/codegen.nim` (generate `NimTsChannel<T>` and `NimTsIterator<T>` classes)
  - *Consumer / Call-Site*: Emits `.d.ts` and `.js` wrappers for channel and iterator procs
  - *Verification*: `test_codegen.nim` validates generated code structure and ES2015 protocol conformance
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/codegen.nim` [WOVEN]

- [x] **Task 2.2: Memory Growth Detachment Guards & Return Disposal** (`nimts-implementer`)
  - *Strand*: `strand/codegen-guards`
  - *Lock*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
  - *Provider*: `src/nimts/codegen.nim` (dynamic `_memory.buffer` access, early `.return()` hooks)
  - *Consumer / Call-Site*: Wire into channel/iterator class bodies
  - *Verification*: `npm test` passes
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/codegen.nim` [WOVEN]

### Phase 3: Negative Controls & Consumer Integration
- [x] **Task 3.1: Adversarial Test Matrix (NEG-01 to NEG-05)** (`nimts-auditor`)
  - *Strand*: `strand/task-3-1-negative-controls`
  - *Provider*: `tests/test_negative_controls.nim` and `tests/test_negative_controls.test.ts`
  - *Consumer / Call-Site*: Live tests covering channel leaks, queue overflow, use-after-free, memory growth detachment
  - *Verification*: All negative controls catch failures when injected and pass when guarded (Two-Key Gate passed, 40 Vitest + 7 Nimble suites)
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 3.2: Full End-to-End Vitest & Nimble Verification** (`nimts-auditor`)
  - *Strand*: `strand/full-e2e`
  - *Verification*: `nimble test && npm test && npm run docs:build && npm pack --dry-run`
  - *Quality Gate*: 100% test pass rate with zero warnings
  - *Weave*: `vine gate && vine weave` [WOVEN]

### Phase 4: Full Adversarial Audit Remediation (Anti-Toy, Anti-Shelfware, Green Mirage Purge)
- [x] **Task 4.1: C-ABI, Channel Marshaling & Macro Architecture Remediation** (`nimts-architect`)
  - *Strand*: `strand/task-4-1-cabi-architecture`
  - *Lock*: `rhizo lock file:src/nimts/channels.nim 600 --fencing`
  - *Provider*: `src/nimts/channels.nim` and `src/nimts/macros.nim`
  - *Defects Addressed*:
    - AUD-01: Fix `macros.nim` `res.HandleId` for `NimTsChannel` by registering channel via `registerHandle(res)`.
    - AUD-02: Fix `channels.nim` C-ABI signature `nimts_chan_try_recv` to return packed 64-bit uint64 (`ptr | (len << 32)`).
    - AUD-03: Implement genuine async notification for channels if needed or clean non-blocking polling without phantom `nimts_chan_read`.
    - Guard `Future` in companion proc with `when declared(Future):` so modules without `std/asyncdispatch` compile cleanly.
    - AUD-08: Add exception trapping in synchronous companion wrappers to prevent unrecoverable WASM traps.
  - *Verification*: `nim c -p:src -d:nimtsCabi` on modules returning channels passes without errors.
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/channels.nim` [WOVEN]

- [x] **Task 4.2: Codegen, TypeScript Projections & Toolchain Hardening** (`nimts-implementer`)
  - *Strand*: `strand/task-4-2-codegen-toolchain`
  - *Lock*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
  - *Provider*: `src/nimts/codegen.nim`, `ts/vite-plugin-nimts.ts`, `scripts/compile_wasm.sh`, `tests/fixtures/test_module.nim`
  - *Defects Addressed*:
    - AUD-05: Call `mapNimTypeToTs` in `classifyReturnType` for `seq[T]` -> `T[]`, `Option[T]` -> `T | null`.
    - AUD-06: Add `int64` and `uint64` parameters to `classifyParamType` as BigInt primitive without `JSON.stringify`.
    - AUD-07: Fix overload emission in TypeScript and JavaScript wrappers.
    - AUD-10: Remove hardcoded developer path in `compile_wasm.sh`.
    - AUD-11: Fix `runtime.wasm` property access in `vite-plugin-nimts.ts`.
    - Live Consumer Wiring: Add real `{.exportts.}` procedure returning `NimTsChannel[string]` and `NimTsChannel[int32]` in `test_module.nim`, recompile WASM fixture.
  - *Verification*: `npx tsc --noEmit` on generated `.d.ts` produces 0 errors.
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/codegen.nim` [WOVEN]

- [x] **Task 4.3: Real Adversarial Verification & Green Mirage Purge** (`nimts-auditor`)
  - *Strand*: `strand/task-4-3-green-mirage-purge`
  - *Provider*: `tests/test_negative_controls.test.ts`, `tests/test_wasm_sync_and_async.test.ts`
  - *Defects Addressed*:
    - AUD-04: Purge `BoundedRingBuffer` in-memory mock class in `test_negative_controls.test.ts`. Replace with live `NimTsChannel` imported from compiled WASM fixture.
    - Verify channel capacity saturation, `for await..of` iteration, early loop break, and `.send()` against real WASM.
    - Purge `Object.keys` tautology in `NEG-04`, replace with genuine duplicate proc name conflict test.
    - Add automated `tsc --noEmit` check in Vitest suite to guarantee all generated `.d.ts` files are valid TypeScript.
  - *Verification*: `nimble test && npm test && npm run docs:build && npm pack --dry-run` all pass 100% green with zero warnings.
  - *Weave*: `vine gate && vine weave` [WOVEN]

### Phase 5: AudioWorklet, WASM LTO & NimMain Hardening (Reported from rg2 & green-rabbit)
- [x] **Task 5.1: NimMain Export, Once-Guard & wasm-ld LTO Preservation** (`nimts-architect`)
  - *Strand*: `strand/task-5-1-nimmain-init`
  - *Provider*: `src/nimts/memory.nim`, `src/nimts/macros.nim`, `scripts/compile_wasm.sh`
  - *Defects Addressed*:
    - Pass `--export=NimMain` and `--export=nimts_init` to `wasm-ld` so `--lto-O3` never strips module initialization.
    - Implement `ensureNimTsInit()` once-guard in `memory.nim` and export `nimts_init()`.
    - Automatically call `ensureNimTsInit()` in companion procs and invoke `_exports.NimMain()` / `_exports.nimts_init()` in `initNimTs` and `initNimTsSync`.
  - *Verification*: Procs using dynamic method dispatch (`chckNilDisp`) initialize and execute cleanly without WASM traps.
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 5.2: AudioWorklet TextEncoder/Decoder Fallback & Synchronous Loader** (`nimts-implementer`)
  - *Strand*: `strand/task-5-2-audioworklet-hardening`
  - *Provider*: `src/nimts/codegen.nim`, `ts/runtime.ts`, `docs/guide/audioworklet-workers.md`
  - *Defects Addressed*:
    - Guard `TextEncoder` and `TextDecoder` instantiation in `codegen.nim` and `ts/runtime.ts` with pure-JS UTF-8 encoder/decoder fallbacks when running in `AudioWorkletGlobalScope`.
    - Implement `initNimTsSync(options?: NimTsOptions)` using synchronous `new WebAssembly.Instance(module, imports)` when a pre-compiled `wasmModule` or `wasmInstance` is provided for AudioWorklet constructors.
    - Update `docs/guide/audioworklet-workers.md` to document synchronous `initNimTsSync` pattern.
  - *Verification*: Vitest suite verifies operation with `globalThis.TextDecoder = undefined` and synchronous constructor loading.
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 5.3: End-to-End AudioWorklet Verification & Two-Key Gate** (`nimts-architect`)
  - *Strand*: `strand/task-5-3-audioworklet-tests`
  - *Provider*: `tests/test_audioworklet.test.ts`, `tests/test_wasm_sync_and_async.test.ts`
  - *Verification*: Full Vitest and Nimble suites pass, docs build passes, npm pack dry-run clean.
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 5.4: Cross-Platform WASM Library Memory Hardening** (`nimts-architect`)
  - *Strand*: `strand/msg_1792267567_nimts-orchestrator_4981`
  - *Provider*: `scripts/compile_wasm.sh`, `ts/vite-plugin-nimts.ts`, `ts/runtime.ts`
  - *Defects Addressed*:
    - Add `--noMain:on` to Nim compilation flags in `scripts/compile_wasm.sh` and `ts/vite-plugin-nimts.ts` to prevent CLI exit destructors in `NimMainModule()` from wiping out global handle and channel tables.
    - Enable `-d:useMalloc` in `scripts/compile_wasm.sh` for robust WASM heap allocation.
    - Enhance `wasi_snapshot_preview1` Proxy in `ts/runtime.ts` with `environ_sizes_get`, `args_sizes_get`, and `fd_fdstat_get` zero-byte responders to prevent uninitialized memory reads in `wasi-libc`.
  - *Verification*: GitHub Actions CI passes 100% green across all 4 OS/Node matrix combinations (Ubuntu/macOS, Node 20/22).
  - *Weave*: `vine gate && vine weave` [WOVEN]

### Phase 6: Honest WebWorkers & Lock-Free Channels (Zero-Lie Concurrency)
- [x] **Task 6.1: Idiomatic Channel[T] Alias & Shared-Buffer SPSC Atomics** (`nimts-architect`)
  - *Strand*: `strand/task-6-1-channel-atomics`
  - *Provider*: `src/nimts/channels.nim`, `src/nimts.nim`, `src/nimts/macros.nim`, `src/nimts/codegen.nim`
  - *Deliverables*:
    - Export `Channel*[T] = NimTsChannel[T]` and `proc newChannel*[T](capacity: int = DefaultChannelCapacity): Channel[T]` in `nimts.nim` and `channels.nim` so users write idiomatic `Channel[T]` without `NimTsChannel` prefix.
    - Support `Channel[T]` seamlessly in `macros.nim` return and parameter classification.
    - Add C-ABI export `nimts_chan_get_raw_ptrs(chanId: int32, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32)` to enable direct shared memory mapping with `SharedArrayBuffer` / `Atomics`.
  - *Verification*: `nimble test` verifies `Channel[T]` native and WASM builds (11/11 suites pass).
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 6.2: spawnWorker Client & WebWorker Runtime** (`nimts-implementer`)
  - *Strand*: `strand/task-6-2-spawn-worker`
  - *Provider*: `ts/worker.ts`, `package.json`, `ts/vite-plugin-nimts.ts`, `tests/test_worker.test.ts`
  - *Deliverables*:
    - Implement `spawnWorker(moduleOrUrl, options?: SpawnWorkerOptions)` in `ts/worker.ts` (exported as `nimts/worker` in `package.json`).
    - Every exported proc is projected as a typed `Promise<T>` on the main thread (honest async).
    - If the worker method returns a `Future[T]`, the worker awaits it and sends the settled value; exceptions reject the main thread Promise.
    - Support Transferable Objects: ArrayBuffer and TypedArray arguments are transferred with zero copies when specified or detected.
    - Support Vite's `?worker` query parameter in `ts/vite-plugin-nimts.ts` (`import MyWorker from './compute.nim?worker'`).
    - Channel streaming over worker boundary: when a worker proc returns `Channel[T]`, chunks are pumped to the main thread `AsyncIterable`.
  - *Verification*: Vitest suite `tests/test_worker.test.ts` verifies off-thread compute, Future resolution, and Transferable memory passing (71/71 tests pass across 5 test files).
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [x] **Task 6.3: End-to-End Verification & Matrix CI Gate** (`nimts-orchestrator`)
  - *Verification*: `npm test` (71/71 tests), `nimble test` (11/11 suites), `npm run docs:build` (0 errors), `npm pack --dry-run` (29 files, 43.4 kB clean tarball), and GitHub Actions CI matrix all 100% green.
  - *Weave*: All Phase 6 strands woven and verified.

- [x] **Task 6.4: Purge Pure JS (`defined(js)`) Vestigial Fallbacks & Clarify WebAssembly Exclusivity** (`nimts-architect`)
  - *Strand*: `strand/task-6-4-purge-js-target`
  - *Provider*: `src/nimts/channels.nim`, `tests/test_channels.nim`, `docs/`, `understanding.md`, `audit_report.md`
  - *Deliverables*:
    - Completely purged all `when defined(js)` and `when not defined(js):` dead branches and guards in `src/nimts/channels.nim` and `tests/test_channels.nim`. Channel fields (`head`, `tail`, `closed`), `import std/atomics`, and `nimts_chan_get_raw_ptrs` are now 100% unconditional.
    - Updated architecture specs, `understanding.md`, and `audit_report.md` (WARN-03) clarifying WebAssembly exclusivity (clang/wasm-ld and Emscripten).
  - *Verification*: `nimble test` (11/11) and `npm test` (71/71) pass 100% green.
  - *Weave*: Woven in commit `cb636fe` and pushed to `origin/main`.

- [x] **Task 6.5: Consolidated Documentation Synchronization for Latest Behaviors** (`nimts-implementer`)
  - *Strand*: `strand/task-6-5-docs-sync`
  - *Provider*: `README.md`, `docs/guide/async-bridge.md`, `docs/reference/typescript-runtime.md`, `docs/reference/nim-api.md`, `docs/guide/type-marshaling.md`
  - *Deliverables*:
    - `README.md`: Showcased `@axiomantic/nimts/worker` and `spawnWorker` in Quickstart & Key Highlights; highlighted idiomatic `Channel[T]` alias.
    - `docs/guide/async-bridge.md`: Detailed honest off-thread async (`spawnWorker`) vs in-thread coroutine bridging (`Future[T]`), explaining that CPU-bound work on single-threaded WASM blocks the main UI thread unless offloaded to a Web Worker.
    - `docs/reference/typescript-runtime.md`: Added comprehensive reference section for `@axiomantic/nimts/worker` (`spawnWorker`, `NimTsWorkerClient`, zero-copy buffer transfer, async proxy).
    - `docs/reference/nim-api.md`: Removed outdated references to JS event-loop fallback; documented `type Channel*[T] = NimTsChannel[T]`, `newChannel[T]()`, and `nimts_chan_get_raw_ptrs`.
    - `docs/guide/type-marshaling.md`: Added `Channel[T]` ergonomics and SPSC channel streaming section.
  - *Verification*: `npm run docs:build` (100% green, 0 errors, 19.6s), `npm test` (100% green), `nimble test` (100% green).
  - *Weave*: Woven in commit `a94a711` and pushed to `origin/main`.

## Phase 7: WebGPU Aligned Storage & Dual-Tier Nim Architecture

- [ ] **Task 7.1: WebGPU 256-Byte Aligned Allocator & Zero-Copy Storage Buffer Helpers** (`nimts-architect`)
  - *Strand*: `strand/task-7-1-webgpu-aligned-storage`
  - *Provider*: `src/nimts/memory.nim`, `src/nimts/types.nim`, `src/nimts/codegen.nim`, `ts/runtime.ts`
  - *Deliverables*:
    - In `src/nimts/memory.nim`: Implement `nimts_alloc_aligned(size: int32, alignment: int32): pointer` and `nimts_free_aligned(p: pointer)` with power-of-two support (especially 256-byte WebGPU `minUniformBufferOffsetAlignment` and 4-byte storage buffer alignment).
    - In `src/nimts/types.nim`: Define `GpuBufferSlice*[T]` object exposing pointer, byte length, element count, and alignment.
    - In `src/nimts/codegen.nim` & `ts/runtime.ts`: Generate TypeScript bindings for `GpuBufferSlice<T>` providing zero-copy `ArrayBufferView` access and helper `writeToGpuBuffer(device: GPUDevice, targetBuffer: GPUBuffer, offset = 0)`.
    - Export C-ABI entry points: `nimts_alloc_aligned`, `nimts_free_aligned`.
  - *Verification*: Unit tests in `tests/test_memory.nim` and TypeScript integration tests in `tests/test_runtime.test.ts`.
  - *Weave*: `vine gate && vine weave`

- [ ] **Task 7.2: Dual-Tier Nim-to-JS Client Module & Automated Integration Test** (`nimts-implementer`)
  - *Strand*: `strand/task-7-2-nim-js-client`
  - *Provider*: `src/nimts/js_client.nim`, `tests/test_nim_js_client.nim`, `package.json`
  - *Deliverables*:
    - Implement `src/nimts/js_client.nim`: A lightweight Nim module for `nim js` code providing idiomatic interop with `nimts` WASM modules (`loadNimTs`, `callWasm`, type shims for `Future[T]` and byte buffers).
    - Implement `tests/test_nim_js_client.nim`: Complete test compiled with `nim js -d:nodejs` that imports `test_module.js`, loads `test_module.wasm`, executes sync and async functions, verifies byte buffers, and asserts full correctness.
    - Wire `npm run test:nim-js` into `package.json` and `npm test` workflow.
  - *Verification*: `npm run test:nim-js` and `npm test` passing 100% green.
  - *Weave*: `vine gate && vine weave`

- [ ] **Task 7.3: WebGPU Compute & Dual-Tier Architecture Guides & Documentation** (`nimts-implementer`)
  - *Strand*: `strand/task-7-3-webgpu-dual-tier-docs`
  - *Provider*: `docs/guide/webgpu-compute.md`, `docs/guide/dual-tier-nim.md`, `docs/.vitepress/config.mts`, `README.md`
  - *Deliverables*:
    - Author `docs/guide/webgpu-compute.md`: Zero-copy storage buffers, 256-byte alignment, tensor data pipelines, and WebGPU WGSL compute shader integration.
    - Author `docs/guide/dual-tier-nim.md`: Dual-Tier Nim Architecture (Nim-to-JS DOM + Nim-to-WASM Compute), including the comprehensive 7-point empirical limitations table (`nim js` vs `nim c/WASM`) and working code snippets.
    - Update VitePress navigation sidebar in `docs/.vitepress/config.mts`.
    - Update `README.md` with WebGPU and Dual-Tier Nim highlights.
  - *Verification*: `npm run docs:build` passes cleanly with 0 errors.
  - *Weave*: `vine gate && vine weave`




