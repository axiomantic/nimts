# AudioWorklet & Web Workers

In modern web development, compute-heavy audio DSP algorithms and CPU-intensive computations must run off the main thread—either inside an `AudioWorkletNode` for real-time audio or inside a `Worker` for background tasks.

NimTS is engineered specifically to thrive in these high-performance, multithreaded environments.

---

## Solved Gotcha: The 4KB Main-Thread Compile Limit

Browser engines (including Chrome and Chromium-based browsers) disallow synchronous WebAssembly compilation on the main thread if the binary buffer exceeds 4KB:

> `RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB`

### The NimTS Solution:
NimTS wrappers support asynchronous streaming compilation as well as pre-compiled modules:

```typescript
// 1. In your main thread: pre-compile the module once
const wasmModule = await WebAssembly.compileStreaming(fetch('/engine.wasm'));

// 2. Pass the pre-compiled WebAssembly.Module across threads via postMessage:
audioContext.audioWorklet.addModule('dsp-processor.js');

const synthNode = new AudioWorkletNode(audioContext, 'dsp-processor', {
  processorOptions: { wasmModule }
});
```

---

## AudioWorklet Processor Pattern

In your audio worklet processor script:

```typescript
// dsp-processor.ts
import { initNimTs, processAudioBlock } from './engine.js';

class NimDspProcessor extends AudioWorkletProcessor {
  private initialized = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();

    // Initialize synchronously from the pre-compiled WebAssembly.Module
    if (options.processorOptions?.wasmModule) {
      initNimTs({ wasmModule: options.processorOptions.wasmModule });
      this.initialized = true;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (!this.initialized) return true;

    const outputChannel = outputs[0][0];

    // High-speed, zero-allocation DSP processing in Nim
    processAudioBlock(outputChannel);

    return true;
  }
}

registerProcessor('dsp-processor', NimDspProcessor);
```

Because `initNimTs` accepts `wasmModule: WebAssembly.Module`, the AudioWorklet initializes instantly without any network requests or thread-blocking buffer compilation.
