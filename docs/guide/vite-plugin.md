# Vite Integration (`vite-plugin-nimts`)

NimTS includes a Vite plugin that enables direct imports of `.nim` files into modern frontend projects, eliminating manual build scripts.

---

## Configuration

In your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { nimtsPlugin } from 'nimts/vite';

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

---

## Plugin Options

`nimtsPlugin(options)` accepts the following configuration:

```typescript
export interface NimTsPluginOptions {
  /** Path to the nim compiler executable (default: 'nim' or process.env.NIM_BIN) */
  nimBin?: string;

  /** Path to the clang compiler (default: auto-detected from Homebrew or PATH) */
  clangBin?: string;

  /** Path to wasm-ld (default: auto-detected from Homebrew or PATH) */
  wasmldBin?: string;

  /** Path to wasi-sysroot directory */
  sysroot?: string;

  /** Additional flags passed to the Nim compiler, e.g. ['-d:danger', '--opt:speed'] */
  extraNimFlags?: string[];

  /** Public directory where generated .wasm binaries are copied (default: 'public/wasm') */
  publicDir?: string;
}
```

---

## Hot Module Replacement (HMR)

The Vite plugin automatically watches all imported `.nim` files. When you modify and save a `.nim` file in your editor:
1. The Vite dev server detects the file change.
2. It recompiles the changed Nim module to WebAssembly in the background cache directory (`.nimts-cache/`).
3. It sends a full reload event through Vite's WebSocket (`server.ws.send`), refreshing your browser application instantly with the updated WASM binary.
