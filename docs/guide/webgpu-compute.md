# WebGPU Compute & Zero-Copy Storage Buffers

Modern web applications increasingly leverage **WebGPU** for compute-intensive workloads: physical simulations, N-body particle dynamics, audio visualizers, neural network inference, and matrix transformations.

When pairing Nim with WebGPU, the primary performance bottleneck is data marshaling: repeatedly allocating, copying, and converting typed arrays between WebAssembly linear memory and GPU storage buffers creates high CPU overhead and triggers aggressive JavaScript garbage collection (GC) pauses.

NimTS eliminates this bottleneck with **WebGPU-aligned memory allocators** and **`GpuBufferSlice[T]`**, enabling **zero-copy uploads** directly from Nim WebAssembly linear memory to WebGPU storage and uniform buffers via `device.queue.writeBuffer`.

---

## The WebGPU Alignment Constraint

WebGPU hardware adapters enforce strict memory alignment rules for buffers bound to shaders:

1. **Uniform Buffer Offsets (`minUniformBufferOffsetAlignment`)**:
   Standard WebGPU hardware requires dynamic uniform buffer offsets to be aligned to **256 bytes**. Binding a buffer with an unaligned offset throws a WebGPU validation error:
   ```text
   ValidationError: Offset (X) does not satisfy the minimum uniform buffer offset alignment (256)
   ```
2. **Storage Buffer Struct Boundaries**:
   Storage buffers containing arrays of structs or vectors require minimum **4-byte** (scalar) or **16-byte** (`vec4<f32>`) alignment for each element.
3. **The WASM Heap Challenge**:
   Standard heap allocators (`malloc`, Nim's standard `alloc`) typically guarantee only 8-byte or 16-byte alignment. If Nim allocates a simulation buffer at offset `0x10008`, passing this buffer directly as an aligned WebGPU slice will fail or cause GPU transfer misalignment.

---

## The NimTS Solution: Aligned Allocators & Slices

NimTS provides built-in low-level aligned allocators and high-level slice abstractions specifically designed for WebGPU zero-copy workflows:

### 1. `nimts_alloc_aligned` & `nimts_free_aligned`
NimTS implements a deterministic aligned allocator in WebAssembly:

```nim
proc nimts_alloc_aligned*(size: int32, alignment: int32): pointer {.exportc, cdecl.}
proc nimts_free_aligned*(p: pointer) {.exportc, cdecl.}
```

- **Power-of-Two Enforcement**: Validates that `alignment` is a power of 2 (e.g. 4, 16, 64, 128, 256).
- **Zero-Leak Prefix Tracking**: Over-allocates by `size + alignment + sizeof(pointer)`, calculates the aligned offset, and stores the raw base pointer in the 4 bytes immediately preceding the aligned address. When `nimts_free_aligned` is invoked, the original heap block is recovered and safely freed.

### 2. `GpuBufferSlice[T]` in Nim
In `nimts/types.nim` and `nimts/memory.nim`, NimTS provides `GpuBufferSlice[T]`:

```nim
type
  GpuBufferSlice*[T] = object
    data*: ptr UncheckedArray[T]
    len*: int32
    byteLength*: int32
    alignment*: int32

proc newGpuBufferSlice*[T](len: int32, alignment: int32 = 256): GpuBufferSlice[T]
proc free*[T](slice: var GpuBufferSlice[T])
```

- Allocates contiguous memory aligned to `alignment` bytes (defaulting to 256 for WebGPU compatibility).
- Exposes `data` as an unchecked array for high-speed SIMD or pointer math inside Nim.
- Provides explicit `.free()` for deterministic deallocation.

---

## Zero-Copy Uploads in TypeScript

When exposed to TypeScript, `GpuBufferSlice<T>` wraps the WASM memory pointer and provides direct upload to WebGPU buffers:

```typescript
import { GpuBufferSlice } from '@axiomantic/nimts/runtime';

export class GpuBufferSlice<T = any> {
  readonly pointer: number;     // Byte offset into WASM linear memory
  readonly byteLength: number;  // Total size in bytes
  readonly alignment: number;   // Alignment (e.g. 256)
  readonly len: number;         // Element count

  // Zero-copy transfer into WebGPU
  writeToGpuBuffer(device: GPUDevice, targetGpuBuffer: GPUBuffer, offset = 0): void;

  // Release memory back to WASM heap
  dispose(): void;
}
```

### How `writeToGpuBuffer` Works Under the Hood
Instead of copying bytes into an intermediate JavaScript array, `writeToGpuBuffer` creates a temporary `Uint8Array` view spanning `[pointer, pointer + byteLength]` directly on the live WebAssembly `ArrayBuffer` and passes it immediately to WebGPU:

```typescript
const view = new Uint8Array(wasmMemory.buffer, this.pointer, this.byteLength);
device.queue.writeBuffer(targetGpuBuffer, offset, view.buffer, view.byteOffset, view.byteLength);
```

The browser's underlying C++ WebGPU implementation copies the bytes directly from WebAssembly linear memory into GPU staging memory without creating any JavaScript heap objects!

---

## Complete Working Example: Particle Simulation

Here is a complete, working example of a 2D particle simulation computed in Nim WebAssembly and rendered/computed with WebGPU.

### 1. The Nim Compute Core (`src/particles.nim`)

```nim
# src/particles.nim
import nimts

type
  Particle* = object
    x*, y*: float32
    vx*, vy*: float32
    color*: uint32

var gParticles: GpuBufferSlice[Particle]

proc initParticles*(count: int32): int32 {.exportts.} =
  ## Allocates 256-byte aligned particle buffer
  if gParticles.data != nil:
    free(gParticles)

  gParticles = newGpuBufferSlice[Particle](count, alignment = 256)

  # Initialize initial positions
  for i in 0 ..< count:
    gParticles.data[i] = Particle(
      x: (i.float32 / count.float32) * 2.0'f32 - 1.0'f32,
      y: 0.0'f32,
      vx: 0.001'f32,
      vy: 0.002'f32,
      color: 0xFF00FFFF'u32
    )

  return gParticles.byteLength

proc stepParticles*(dt: float32) {.exportts.} =
  ## High-performance physics update in Nim
  if gParticles.data == nil: return

  for i in 0 ..< gParticles.len:
    gParticles.data[i].x += gParticles.data[i].vx * dt
    gParticles.data[i].y += gParticles.data[i].vy * dt

    # Bounce off boundaries
    if gParticles.data[i].x > 1.0'f32 or gParticles.data[i].x < -1.0'f32:
      gParticles.data[i].vx = -gParticles.data[i].vx
    if gParticles.data[i].y > 1.0'f32 or gParticles.data[i].y < -1.0'f32:
      gParticles.data[i].vy = -gParticles.data[i].vy

proc getParticleBufferPtr*(): int32 {.exportts.} =
  cast[int32](gParticles.data)

proc getParticleCount*(): int32 {.exportts.} =
  gParticles.len

proc cleanupParticles*() {.exportts.} =
  if gParticles.data != nil:
    free(gParticles)
```

---

### 2. The TypeScript WebGPU Pipeline (`src/main.ts`)

```typescript
// src/main.ts
import { initNimTs, GpuBufferSlice } from '@axiomantic/nimts/runtime';
import {
  initParticles,
  stepParticles,
  getParticleBufferPtr,
  getParticleCount,
  cleanupParticles
} from './particles.nim';

async function run() {
  // 1. Initialize WebGPU
  if (!navigator.gpu) throw new Error('WebGPU not supported');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No GPU adapter found');
  const device = await adapter.requestDevice();

  // 2. Initialize Nim WebAssembly module
  const wasmRuntime = await initNimTs();

  const PARTICLE_COUNT = 100_000;
  const byteLength = initParticles(PARTICLE_COUNT);

  // 3. Create WebGPU Storage Buffer
  const gpuBuffer = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
  });

  // 4. Wrap the WASM pointer in a GpuBufferSlice
  const ptr = getParticleBufferPtr();
  const slice = new GpuBufferSlice(
    ptr,
    byteLength,
    256, // 256-byte alignment guaranteed by newGpuBufferSlice
    PARTICLE_COUNT,
    wasmRuntime
  );

  // 5. Simulation & Render Loop
  let lastTime = performance.now();

  function frame(now: number) {
    const dt = (now - lastTime) / 1000.0;
    lastTime = now;

    // Run physics simulation in Nim WASM
    stepParticles(dt);

    // Direct Zero-Copy upload into WebGPU storage buffer!
    // No JS array allocation or copying.
    slice.writeToGpuBuffer(device, gpuBuffer);

    // Dispatch WebGPU compute or draw passes here...
    // const commandEncoder = device.createCommandEncoder();
    // ...
    // device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Clean up on exit
  window.addEventListener('beforeunload', () => {
    slice.dispose();
    cleanupParticles();
  });
}

run();
```

---

## Best Practices & Memory Safety

1. **Avoid Double-Frees**:
   If you call `slice.dispose()` in TypeScript, it invokes `nimts_free_aligned` in WASM. Do not also call `cleanupParticles()` if both reference the same pointer. Choose either TypeScript management via `.dispose()` or Nim lifecycle management via `free()`.
2. **WebAssembly Memory Growth (`memory.grow`)**:
   In WebAssembly, when memory grows, the underlying `ArrayBuffer` is detached and reallocated. `GpuBufferSlice.writeToGpuBuffer` dynamically accesses the current `wasmRuntime.getMemory().buffer` on every call, preventing stale detached buffer crashes (`TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer`).
3. **Pairing with Off-Thread Web Workers**:
   For maximum framerate stability, compute simulation steps inside a Web Worker using `@axiomantic/nimts/worker` and transfer or stream data without blocking the browser UI thread.
