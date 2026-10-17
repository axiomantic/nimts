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
- [ ] **Task 1.1: `NimTsChannel[T]` & Lockfree SPSC Topology** (`nimts-architect`)
  - *Strand*: `strand/channels-spsc`
  - *Lock*: `rhizo lock file:src/nimts/channels.nim 600 --fencing`
  - *Provider*: `src/nimts/channels.nim` (wait-free SPSC circular queue with WASM/JS target split)
  - *Consumer / Call-Site*: Wire into `src/nimts.nim` exports and channel C-ABI
  - *Verification*: `nimble test` passes channel unit tests
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/channels.nim`

- [ ] **Task 1.2: Multi-Module Linker Namespacing & Universal Future Adapter** (`nimts-architect`)
  - *Strand*: `strand/namespacing-async`
  - *Lock*: `rhizo lock file:src/nimts/macros.nim 600 --fencing`
  - *Provider*: `src/nimts/macros.nim` (`nimts_<module>_<proc>` C-ABI) and `src/nimts/async_bridge.nim` (`AnyFuture[F, T]` duck-typing)
  - *Consumer / Call-Site*: Wire into `classifyReturnType` and `processExportTs`
  - *Verification*: `test_codegen.nim` and `wasm-ld` multi-module link test passes
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/macros.nim`

- [ ] **Task 1.3: Closure Iterator Handles & C-ABI Control Surface** (`nimts-implementer`)
  - *Strand*: `strand/closure-iterators`
  - *Lock*: `rhizo lock file:src/nimts/types.nim 600 --fencing`
  - *Provider*: `src/nimts/types.nim` and `src/nimts/memory.nim` (`ClosureIterSlot[T]`, `nimts_iter_next`, `nimts_iter_dispose`)
  - *Consumer / Call-Site*: Wire into `macros.nim` return type classification
  - *Verification*: `test_memory.nim` verifies slot allocation, invocation, and deterministic teardown
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/types.nim`

### Phase 2: Codegen & TypeScript Projections
- [ ] **Task 2.1: `AsyncIterable<T>` & `IterableIterator<T>` TypeScript Codegen** (`nimts-implementer`)
  - *Strand*: `strand/ts-codegen`
  - *Lock*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
  - *Provider*: `src/nimts/codegen.nim` (generate `NimTsChannel<T>` and `NimTsIterator<T>` classes)
  - *Consumer / Call-Site*: Emits `.d.ts` and `.js` wrappers for channel and iterator procs
  - *Verification*: `test_codegen.nim` validates generated code structure and ES2015 protocol conformance
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/codegen.nim`

- [ ] **Task 2.2: Memory Growth Detachment Guards & Return Disposal** (`nimts-implementer`)
  - *Strand*: `strand/codegen-guards`
  - *Lock*: `rhizo lock file:src/nimts/codegen.nim 600 --fencing`
  - *Provider*: `src/nimts/codegen.nim` (dynamic `_memory.buffer` access, early `.return()` hooks)
  - *Consumer / Call-Site*: Wire into channel/iterator class bodies
  - *Verification*: `npm test` passes
  - *Weave*: `vine gate && vine weave && rhizo unlock file:src/nimts/codegen.nim`

### Phase 3: Negative Controls & Consumer Integration
- [x] **Task 3.1: Adversarial Test Matrix (NEG-01 to NEG-05)** (`nimts-auditor`)
  - *Strand*: `strand/task-3-1-negative-controls`
  - *Provider*: `tests/test_negative_controls.nim` and `tests/test_negative_controls.test.ts`
  - *Consumer / Call-Site*: Live tests covering channel leaks, queue overflow, use-after-free, memory growth detachment
  - *Verification*: All negative controls catch failures when injected and pass when guarded (Two-Key Gate passed, 40 Vitest + 7 Nimble suites)
  - *Weave*: `vine gate && vine weave` [WOVEN]

- [ ] **Task 3.2: Full End-to-End Vitest & Nimble Verification** (`nimts-auditor`)
  - *Strand*: `strand/full-e2e`
  - *Verification*: `nimble test && npm test && npm run docs:build && npm pack --dry-run`
  - *Quality Gate*: 100% test pass rate with zero warnings
  - *Weave*: `vine gate && vine weave`
