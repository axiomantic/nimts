# Vite Integration (`vite-plugin-nimts`)

NimTS includes a Vite plugin that enables direct imports of `.nim` files into modern frontend projects, eliminating manual build scripts.

---

## Configuration

In your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { nimtsPlugin } from '@axiomantic/nimts/vite';

export default defineConfig({
  plugins: [
    nimtsPlugin({
      extraNimFlags: ['-d:release']
    })
  ]
});
```

---

## Usage in Frontend Code

Once configured, import your `.nim` file directly as an ES module:

```typescript
// src/main.ts
import { initNimTs, processAudio, greet } from './dsp/engine.nim';

// 1. Initialize the module
await initNimTs();

// 2. Call exported functions directly
console.log(greet("Browser"));
```

### Worker Imports with `?worker`

You can also import any Nim module directly as a Web Worker using Vite's `?worker` query parameter:

```typescript
// src/main.ts
import EngineWorker from './dsp/engine.nim?worker';

// Instantiate the worker client
const worker = await new EngineWorker();
// or: const worker = await EngineWorker.spawn();

// All calls are proxied asynchronously to the worker thread
const sum = await worker.addNumbers(10, 20);
console.log('Result from worker:', sum);
```

### AudioWorklet Imports with `?worklet`

You can import any Nim module directly as a WebAudio `AudioWorkletNode` using Vite's `?worklet` query parameter:

```typescript
// src/audio.ts
import { createWorklet } from './dsp/synth.nim?worklet';

const audioCtx = new AudioContext();
const synth = await createWorklet(audioCtx);

// Connect into WebAudio signal chain
synth.connect(audioCtx.destination);

// Call exported Nim RPC methods over the worklet message port
await synth.setParam('cutoff', 2500);
```

---

## Plugin Options

`nimtsPlugin(options)` accepts the following configuration:

```typescript
export interface NimTsPluginOptions {
  /** Compilation backend: 'standalone' (default: clang + wasm-ld) or 'emscripten' (emcc) */
  backend?: 'standalone' | 'emscripten';

  /** Path to the nim compiler executable (default: 'nim' or process.env.NIM_BIN) */
  nimBin?: string;

  /** Path to the clang compiler (default: auto-detected from Homebrew or PATH) */
  clangBin?: string;

  /** Path to wasm-ld (default: auto-detected from Homebrew or PATH) */
  wasmldBin?: string;

  /** Path to wasi-sysroot directory */
  sysroot?: string;

  /** Path to emcc executable when using backend: 'emscripten' (default: 'emcc') */
  emccBin?: string;

  /** Additional flags passed to emcc when using backend: 'emscripten' */
  emccFlags?: string[];

  /** Additional flags passed to the Nim compiler, e.g. ['-d:danger', '--opt:speed'] */
  extraNimFlags?: string[];
  nimFlags?: string[];

  /** Additional search paths for the Nim compiler (--path:...), ideal for monorepos and multi-repo setups */
  nimPaths?: string[];

  /** Additional flags passed to clang compiler (--passC:...) */
  clangFlags?: string[];

  /** Additional flags passed to wasm-ld linker (--passL:...) */
  linkerFlags?: string[];

  /** Working directory for nim compilation */
  cwd?: string;

  /** Additional glob patterns to watch for HMR invalidation */
  watchGlobs?: string[];

  /** Public directory where generated .wasm binaries are copied (default: 'public/wasm') */
  publicDir?: string;
}
```

### Multi-Repo & Monorepo Support

When working across multiple repositories or packages (e.g. sharing core libraries like `rg2` or `green-rabbit`):
- **`nimPaths`**: Automatically adds `--path:...` search flags to the Nim compiler so external dependencies resolve without needing local installation.
- **Transitive Dependency Tracking**: The plugin recursively parses `import` and `include` statements in `.nim` files, invalidating the Vite HMR cache whenever upstream packages change.
- **`watchGlobs`**: Configures custom watch glob patterns for external directories to trigger automatic recompilation.
- **Automatic Linker Export Discovery**: Symbols recorded in `_nimts_exports.json` are automatically exported via `-Wl,--export=...` / wasm-ld, ensuring all C-ABI procedures are accessible to the runtime.

---

## Hot Module Replacement (HMR)

The Vite plugin automatically watches all imported `.nim` files. When you modify and save a `.nim` file in your editor:
1. The Vite dev server detects the file change.
2. It recompiles the changed Nim module to WebAssembly in the background cache directory (`.nimts-cache/`).
3. It sends a full reload event through Vite's WebSocket (`server.ws.send`), refreshing your browser application instantly with the updated WASM binary.
