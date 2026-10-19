# Type Marshaling & Memory

NimTS handles data conversion between Nim and TypeScript through compile-time code generation and low-overhead WebAssembly memory marshaling.

---

## Type Mapping Reference

| Nim Type | TypeScript Type | WebAssembly Mechanism |
| :--- | :--- | :--- |
| `int32`, `int16`, `int8`, `uint32` | `number` | Direct WebAssembly register integer pass / return (`i32`) |
| `int64`, `uint64` | `bigint` | 64-bit WebAssembly integer register (`i64`) |
| `float32` | `number` | 32-bit WebAssembly float register (`f32`) |
| `float64` | `number` | 64-bit WebAssembly float register (`f64`) |
| `bool` | `boolean` | Converted to `0` or `1` (`i32`) $\leftrightarrow$ `boolean` |
| `string`, `cstring` | `string` | Allocated via `nimts_alloc`, UTF-8 decoded / encoded |
| `openArray[byte]`, `seq[byte]` | `Uint8Array` | Direct view copy via `allocBytesResult` / `readBytes` |
| `ref object` | `Class` | Opaque `HandleId` with `FinalizationRegistry` binding |
| `object`, `tuple` | `interface` | Automatic JSON serialization / deserialization |
| `Future[T]` | `Promise<T>` | Bidirectional non-blocking `PromiseId` bridge |
| `NimTsIterator[T]` | `NimTsIterator<T>` (`IterableIterator<T>`) | Closure iterator handle stepping via monotonic slot registry |
| `Channel[T]` / `NimTsChannel[T]` | `NimTsChannel<T>` (`AsyncIterable<T>`) | Lock-free SPSC circular queue with backpressure |

---

## Strings (UTF-8)

When passing a string from JavaScript to Nim, the generated glue code encodes the string into UTF-8 using the browser's built-in `TextEncoder`, allocates memory in WASM via `nimts_alloc`, and passes the pointer and length:

```nim
proc greet*(name: string): string {.exportts.} =
  "Hello, " & name & "!"
```

In TypeScript:
```typescript
const message = greet("World"); // Returns "Hello, World!"
```

Memory allocated for passing input arguments is freed immediately in the wrapper's `finally` block, preventing memory leaks.

---

## Binary Data & TypedArray ABI (`Uint8Array`, `Float32Array`, etc.)

NimTS provides **direct binary TypedArray ABI marshaling** for all numeric slices (`openArray[T]` and `seq[T]`), completely bypassing JSON serialization:

| Nim Type | TypeScript TypedArray |
| :--- | :--- |
| `openArray[byte]`, `seq[byte]`, `seq[uint8]` | `Uint8Array` |
| `openArray[int8]`, `seq[int8]` | `Int8Array` |
| `openArray[int16]`, `seq[int16]` | `Int16Array` |
| `openArray[uint16]`, `seq[uint16]` | `Uint16Array` |
| `openArray[int32]`, `seq[int32]` | `Int32Array` |
| `openArray[uint32]`, `seq[uint32]` | `Uint32Array` |
| `openArray[float32]`, `seq[float32]` | `Float32Array` |
| `openArray[float64]`, `seq[float64]` | `Float64Array` |

```nim
# Direct numeric arrays pass and return at native speeds
proc scaleFloats*(samples: openArray[float32], factor: float32): seq[float32] {.exportts.} =
  result = newSeq[float32](samples.len)
  for i in 0 ..< samples.len:
    result[i] = samples[i] * factor
```

In TypeScript:
```typescript
const input = new Float32Array([0.1, 0.5, 0.9]);
const scaled = scaleFloats(input, 2.0); // Float32Array [ 0.2, 1.0, 1.8 ]
```

---

## Zero-Copy Pinned Views (`NimTsView[T]`)

When copying or allocating new buffers per call is too expensive (e.g. 60 FPS graphics, 44.1kHz audio buffers, or large tensor matrices), NimTS provides **zero-copy pinned views**:

```nim
import nimts

var gAudioFrame: array[512, float32]

# Expose a live view into the global buffer without allocation
proc getAudioView*(): NimTsView[float32] {.exportts.} =
  initNimTsView(addr gAudioFrame[0], gAudioFrame.len)

proc processAudio*(view: NimTsView[float32]) {.exportts.} =
  for i in 0 ..< view.len:
    view[i] = view[i] * 0.95'f32
```

In TypeScript, `NimTsView<T>` behaves like a standard `TypedArray`:
```typescript
const view = getAudioView(); // Instance of NimTsView & Float32Array

// 1. Array index access and live mutations
console.log(view[0]);
view[0] = 1.0; // Immediately mutates WASM linear memory zero-copy!

// 2. Direct processing in Nim
processAudio(view);
console.log(view[0]); // 0.95

// 3. Dynamic detachment resilience
// If WebAssembly memory grows (memory.grow()), NimTsView automatically
// re-binds to the new ArrayBuffer without throwing "detached ArrayBuffer" errors.
```

---

## Complex Value Objects (`object` / `tuple`)

Nim value objects and tuples are marshaled across the WebAssembly boundary via JSON serialization:

```nim
type
  PatchConfig* = object
    name*: string
    polyphony*: int32
    tuning*: float32

proc updateConfig*(cfg: PatchConfig): PatchConfig {.exportts.} =
  result = cfg
  result.polyphony = cfg.polyphony * 2
  result.name = cfg.name & "_doubled"
```

The generated TypeScript declarations output a matching interface:
```typescript
export interface PatchConfig {
  name: string;
  polyphony: number;
  tuning: number;
}

export declare function updateConfig(cfg: PatchConfig): PatchConfig;
```

---

## 64-bit Integers (`BigInt`)

Modern WebAssembly runtimes support native 64-bit integers (`i64`). NimTS automatically maps `int64` and `uint64` to JavaScript `bigint`:

```nim
proc combineIds*(a: int64, b: int64): int64 {.exportts.} =
  a + b
```

In TypeScript:
```typescript
const result: bigint = combineIds(1000000000000n, 2000000000000n);
console.log(result); // 3000000000000n
```

---

## SPSC Channels (`Channel[T]` / `NimTsChannel[T]`)

For asynchronous streaming between Nim and TypeScript, NimTS exports lock-free single-producer single-consumer circular buffers as ES2018 `AsyncIterable<T>`:

```nim
proc streamTelemetry*(): Channel[float32] {.exportts.} =
  let ch = newChannel[float32](64)
  for i in 0 ..< 10:
    discard ch.send(i.float32 * 0.1'f32)
  return ch
```

In TypeScript, iterate asynchronously with `for await`:

```typescript
for await (const sample of streamTelemetry()) {
  console.log("Telemetry sample:", sample);
}
```

The idiomatic `type Channel*[T] = NimTsChannel[T]` and `newChannel[T]()` allow writing clean, standard Nim code while compiling directly to the high-performance WASM ring buffer.
