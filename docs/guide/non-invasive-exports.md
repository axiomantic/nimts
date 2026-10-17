# Non-Invasive Exports

One of the central design principles of **NimTS** is **non-invasiveness**.

In many WebAssembly bridging systems, marking a procedure for export modifies its signature, forces the use of foreign C types (`cstring`, raw pointer offsets, manual memory allocations), or couples the implementation to a specific runtime target.

NimTS takes the opposite approach: **your native Nim code remains 100% standard Nim**.

---

## Zero Signature Perturbation

When you annotate a procedure with `{.exportts.}`:

```nim
proc calculateResonance*(cutoff: float32, q: float32): float32 {.exportts.} =
  cutoff * (1.0'f32 + q * 0.5'f32)
```

1. **Native Signature Remains Intact**:
   The procedure `calculateResonance` retains its natural signature: `(cutoff: float32, q: float32): float32`.
2. **Zero Runtime Overhead for Native Callers**:
   Native Nim CLI tools, VST/CLAP audio plugins, and native unit tests call `calculateResonance` directly as a native function with no wrapper overhead, no indirection, and no runtime conversion costs.
3. **Companion C-ABI Export (`nimts_*`)**:
   Under the hood, the macro generates a companion procedure exported to the C-ABI:
   ```nim
   proc nimts_calculateResonance(cutoff: float32, q: float32): float32 {.exportc, cdecl.} =
     calculateResonance(cutoff, q)
   ```

---

## Freestanding Type & Proc Export (`exportTs`)

If you want to keep your library code entirely clean of any `nimts` imports or annotations, you can define a separate bridge module and export existing types or procedures using the freestanding `exportTs` macro:

```nim
# core_dsp.nim (clean, zero nimts dependencies)
type
  Oscillator* = ref object
    frequency*: float32

proc setFrequency*(osc: Oscillator, freq: float32) =
  osc.frequency = freq
```

```nim
# wasm_bridge.nim (imports core_dsp and exports to TypeScript)
import nimts
import core_dsp

exportTs(Oscillator)
exportTs(setFrequency)

static:
  emitTsGlueFiles("core_dsp", ".")
```

This pattern is especially valuable when:
- Exporting existing 3rd-party Nim libraries or submodules.
- Multi-targeting native desktop applications (e.g. C/C++ FFI) and WebAssembly frontends from the same shared codebase.

---

## Native Testability

Because `{.exportts.}` never alters the native function, you can write standard `unittest` or `testament` test suites that execute natively on macOS, Linux, or Windows without requiring a WebAssembly runtime, Node.js, or browser host:

```nim
# tests/test_dsp.nim
import std/unittest
import core_dsp

suite "DSP Native Tests":
  test "frequency calculation works natively":
    let osc = Oscillator(frequency: 440.0'f32)
    setFrequency(osc, 880.0'f32)
    check osc.frequency == 880.0'f32
```

Run natively:
```bash
nim r tests/test_dsp.nim
```
