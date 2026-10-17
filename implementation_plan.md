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

- [ ] **Task 5.2: AudioWorklet TextEncoder/Decoder Fallback & Synchronous Loader** (`nimts-implementer`)
  - *Strand*: `strand/task-5-2-audioworklet-hardening`
  - *Provider*: `src/nimts/codegen.nim`, `ts/runtime.ts`, `docs/guide/audioworklet-workers.md`
  - *Defects Addressed*:
    - Guard `TextEncoder` and `TextDecoder` instantiation in `codegen.nim` and `ts/runtime.ts` with pure-JS UTF-8 encoder/decoder fallbacks when running in `AudioWorkletGlobalScope`.
    - Implement `initNimTsSync(options?: NimTsOptions)` using synchronous `new WebAssembly.Instance(module, imports)` when a pre-compiled `wasmModule` or `wasmInstance` is provided for AudioWorklet constructors.
    - Update `docs/guide/audioworklet-workers.md` to document synchronous `initNimTsSync` pattern.
  - *Verification*: Vitest suite verifies operation with `globalThis.TextDecoder = undefined` and synchronous constructor loading.
  - *Weave*: `vine gate && vine weave`

- [ ] **Task 5.3: End-to-End AudioWorklet Verification & Two-Key Gate** (`nimts-architect`)
  - *Strand*: `strand/task-5-3-audioworklet-tests`
  - *Provider*: `tests/test_audioworklet.test.ts`, `tests/test_wasm_sync_and_async.test.ts`
  - *Verification*: Full Vitest and Nimble suites pass, docs build passes, npm pack dry-run clean.
  - *Weave*: `vine gate && vine weave`
