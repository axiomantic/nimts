# Stateful Handles & Garbage Collection

In WebAssembly, passing raw pointers of long-lived, heap-allocated data structures to JavaScript is dangerous. It exposes applications to use-after-free bugs, pointer corruption, and prevents the language's native garbage collector from tracking references.

NimTS solves this with **Opaque Stateful Handles** (`NimTsHandle[T]`).

---

## How Handles Work

When a Nim procedure returns or accepts a `ref object`:

```nim
type
  AudioEngine* {.exportts.} = ref object
    sampleRate*: float32
    voiceCount*: int32

proc createEngine*(sampleRate: float32, voices: int32): AudioEngine {.exportts.} =
  AudioEngine(sampleRate: sampleRate, voiceCount: voices)

proc getVoiceCount*(engine: AudioEngine): int32 {.exportts.} =
  if engine == nil: return 0
  engine.voiceCount
```

1. **Handle Allocation**:
   When `createEngine` returns an instance, NimTS increments a monotonic `HandleId`, registers the object in an internal handle table, and increments Nim's internal reference count via `GC_ref(obj)`.
2. **TypeScript Class Wrapper**:
   The generated TypeScript code exports a class wrapping the handle:
   ```typescript
   export class AudioEngine {
     readonly handleId: number;
     constructor(handleId: number);
     dispose(): void;
   }
   ```
3. **Handle Id Passing**:
   When `getVoiceCount(engine)` is called from TypeScript, the wrapper extracts `engine.handleId` and passes it to WebAssembly. The WASM runtime looks up the `AudioEngine` instance from the handle table, safely unboxing it.

---

## Deterministic Release (`.dispose()`)

For predictable latency in games, audio synthesis, and graphics, you can explicitly release the instance:

```typescript
const engine = createEngine(48000.0, 16);
console.log(getVoiceCount(engine)); // 16

// Deterministic immediate cleanup
engine.dispose();
```

When `.dispose()` is called:
- `nimts_destroy_handle(handleId)` is called in WebAssembly.
- Nim calls `GC_unref` on the tracked instance, allowing Nim's ORC/ARC garbage collector to reclaim the memory immediately.
- The TypeScript wrapper zeroes out `handleId` to prevent dangling calls. Calling `.dispose()` multiple times is safe and idempotent.

---

## Automatic GC via `FinalizationRegistry`

If a developer forgets to call `.dispose()`, NimTS provides a safety net:

The generated JavaScript wrappers automatically register active handles with JavaScript's native [`FinalizationRegistry`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry). When the JavaScript engine collects the wrapper instance, the finalizer automatically invokes `nimts_destroy_handle(handleId)` in the background, preventing memory leaks across the WASM boundary.
