# Dual-Tier Nim Architecture: Nim JS + Nim WASM

Nim has a unique superpower among programming languages: it can compile both directly to **JavaScript** (`nim js`) and directly to **WebAssembly** via C/LLVM (`nim c -d:wasm` or NimTS).

The **Dual-Tier Nim Architecture** combines these two compilation targets into a single, cohesive full-stack frontend:
- **Tier 1 (Nim JS)**: Powers reactive DOM rendering, UI components (via Karax or standard DOM APIs), event handling, browser APIs, and routing.
- **Tier 2 (Nim WASM via NimTS)**: Powers the compute-heavy engine: simulations, physics solvers, audio DSP, cryptography, neural nets, and WebGPU pipelines.

NimTS bridges these two tiers seamlessly: you write your compute core in Nim, compile it to WebAssembly with NimTS, and consume it directly from your Nim JavaScript frontend using `nimts/js_client`—without writing a single line of handwritten JavaScript or TypeScript glue code.

---

## 7-Point Empirical Limitations: Nim JS vs. Nim WASM

Why not write everything in `nim js` or everything in `nim wasm`? Each target has distinct empirical performance characteristics and hardware capabilities:

| Dimension | Nim JS (`nim js`) | Nim WASM (via NimTS) | Architecture Recommendation |
| :--- | :--- | :--- | :--- |
| **1. Linear Memory & Pointers** | High-level JS arrays & TypedArrays. No contiguous address space or unchecked pointer arithmetic; `cast[ptr T]` is restricted or emulated. | True 32-bit linear address space (`ptr T`, `cast[ptr T]`, `alloc0`, unchecked arrays). Identical memory model to C. | **Tier 1** for DOM tree management; **Tier 2** for dense buffers, matrix math, and custom allocators. |
| **2. Atomics & SPSC Channels** | Single-threaded JavaScript event loop. Multi-threading requires separate Workers; `atomicThreadFence` and hardware atomics are unavailable. | First-class WASM atomics (`i32.atomic.rmw.*`), `SharedArrayBuffer`, and lock-free SPSC channels across threads. | **Tier 1** for UI event coordination; **Tier 2** for lock-free audio/simulation pipelines. |
| **3. Native C FFI** | Cannot link C libraries (`.c`, `.h`). All external bindings must be JavaScript Web APIs or npm packages. | Direct Clang/LLVM compilation allows linking native C libraries (`stb_image`, `miniaudio`, `sqlite`) directly into WASM. | **Tier 2** whenever linking existing C audio/crypto libraries. |
| **4. SIMD Vectorization** | No explicit SIMD operations. Relies on browser JIT engines to auto-vectorize heuristically and unpredictably. | Deterministic 128-bit WASM SIMD (`wasm_simd128`), vector registers, and explicit vector math instructions. | **Tier 2** for signal processing, physics, and graphics. |
| **5. GC & Deterministic Memory** | Managed by browser V8/SpiderMonkey garbage collector; susceptible to unpredictable GC pauses and frame drops. | Deterministic ARC/ORC reference counting and destructor cleanup; zero GC pauses, custom arenas, and pools. | **Tier 1** for UI objects; **Tier 2** for real-time 60/120 FPS loops and audio worklets. |
| **6. 64-bit Integers (`int64`)** | JavaScript `Number` is an IEEE-754 53-bit float. `int64` requires emulated `BigInt` or 32-bit word pairs with substantial overhead. | Native hardware 64-bit integers (`i64`), zero emulation penalty or performance loss. | **Tier 2** for 64-bit hashing, timestamps, and precision math. |
| **7. Binary Bitcasting & Casting** | Memory reinterpretation requires creating multiple TypedArrays or `DataView`, adding allocation overhead and bounds checks. | Instantaneous zero-cost pointer casting (`cast[ptr MyStruct](addr data[0])`) with zero runtime overhead. | **Tier 2** for binary protocols, packet parsing, and WebGPU struct packing. |

---

## Consuming NimTS WASM from Nim JS (`nimts/js_client`)

When compiling to the JavaScript backend (`nim js`), importing `nimts` or `nimts/js_client` gives you a dedicated client module for loading and interacting with NimTS WebAssembly modules:

```nim
# When compiling with: nim js my_app.nim
import nimts/js_client

# Core Types:
# - NimTsJsModule: represents an initialized WASM module
# - rawModule: the imported JS ES-module wrapper
# - exports: the initialized WebAssembly exports table

# Core Helpers:
proc loadNimTsModule*(modulePath: cstring, wasmPath: cstring = ""): Future[NimTsJsModule] {.async.}
proc loadNimTsExports*(modulePath: cstring, wasmPath: cstring = ""): Future[JsObject] {.async.}
proc toFuture*[T](promise: JsObject): Future[T]
proc toUint8Array*(data: openArray[byte]): JsObject
proc toSeqByte*(arr: JsObject): seq[byte]
```

---

## Complete Working Example: Dual-Tier Audio Synthesizer

Here is a complete, working example of a full-stack Dual-Tier Nim application:
1. **Tier 2 (Compute Core)**: A high-performance audio synthesis oscillator compiled to WebAssembly.
2. **Tier 1 (UI Frontend)**: A Nim JavaScript UI that loads the WASM module, triggers audio synthesis, and renders the waveform to an HTML5 Canvas.

### 1. The Compute Core (`src/audio_dsp.nim` - Compiled to WASM)

```nim
# src/audio_dsp.nim
import std/math
import nimts

type
  Oscillator* {.exportts.} = ref object
    frequency*: float32
    phase*: float32
    sampleRate*: float32

proc createOscillator*(freq: float32, sampleRate: float32 = 44100.0'f32): Oscillator {.exportts.} =
  Oscillator(frequency: freq, phase: 0.0'f32, sampleRate: sampleRate)

proc generateSamples*(osc: Oscillator, count: int32): seq[byte] {.exportts.} =
  ## Generates float32 audio samples serialized as raw binary bytes
  if osc == nil or count <= 0: return @[]

  result = newSeq[byte](count * sizeof(float32))
  let floatView = cast[ptr UncheckedArray[float32]](addr result[0])
  let phaseInc = 2.0'f32 * PI * (osc.frequency / osc.sampleRate)

  for i in 0 ..< count:
    floatView[i] = sin(osc.phase)
    osc.phase += phaseInc
    if osc.phase > 2.0'f32 * PI:
      osc.phase -= 2.0'f32 * PI
```

Compile the compute core to WebAssembly and TypeScript wrappers:
```bash
nimts compile src/audio_dsp.nim dist/audio_dsp.wasm
```
This generates `dist/audio_dsp.wasm` and `dist/audio_dsp.js`.

---

### 2. The UI & Controller (`src/app.nim` - Compiled to JavaScript)

```nim
# src/app.nim
# Compile with: nim js -d:nimExperimentalAsyncjsText -o:dist/app.js src/app.nim
import std/dom
import std/asyncjs
import std/jsffi
import nimts/js_client

proc main() {.async.} =
  echo "Loading NimTS Audio DSP WebAssembly Core..."

  # 1. Dynamically load the NimTS module from Nim JS
  let dsp = await loadNimTsModule("./audio_dsp.js", "./audio_dsp.wasm")
  echo "NimTS WASM Module Loaded Successfully!"

  # 2. Call exported WASM procs through the exports object
  let oscHandle = dsp.exports.createOscillator(440.0) # 440 Hz (A4)
  echo "Oscillator handle created: ", oscHandle

  # 3. Generate 128 samples of audio data
  let rawJsBytes: JsObject = dsp.exports.generateSamples(oscHandle, 128)

  # 4. Convert JS Uint8Array back to Nim seq[byte]
  let nimBytes: seq[byte] = toSeqByte(rawJsBytes)
  echo "Generated ", nimBytes.len, " bytes of sample data from WASM!"

  # 5. Render to HTML DOM
  let statusDiv = document.getElementById("status")
  if statusDiv != nil:
    statusDiv.innerHTML = "Generated " & $nimBytes.len & " bytes of audio from WASM core!"

# Run entry point
discard main()
```

---

## Build & Run Workflow

You can automate the build using a simple `config.nims` or Makefile:

```nim
# config.nims
task build_wasm, "Build Tier 2 WASM compute core":
  exec "nimts compile src/audio_dsp.nim dist/audio_dsp.wasm"

task build_ui, "Build Tier 1 JS UI frontend":
  exec "nim js -o:dist/app.js src/app.nim"

task build_all, "Build complete Dual-Tier application":
  build_wasmTask()
  build_uiTask()
```

When integrating with Vite, configure `vite.config.ts` with the official `@axiomantic/nimts/vite` plugin so changes to `.nim` files automatically trigger incremental compilation and hot-reloading for both tiers.
