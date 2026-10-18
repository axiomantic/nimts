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

## Binary Data & Buffers (`Uint8Array`)

For DSP audio frames, image pixels, and binary network protocols, `openArray[byte]` and `seq[byte]` map directly to JavaScript `Uint8Array`:

```nim
proc invertBytes*(data: openArray[byte]): seq[byte] {.exportts.} =
  result = newSeq[byte](data.len)
  for i in 0 ..< data.len:
    result[i] = data[i] xor 0xFF'u8
```

In TypeScript:
```typescript
const input = new Uint8Array([0x00, 0x55, 0xFF]);
const output: Uint8Array = invertBytes(input);
// output: Uint8Array [ 255, 170, 0 ]
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
