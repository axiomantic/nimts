// tests/test_runtime.test.ts - Unit tests for NimTsRuntime TypeScript core
// Licensed under MIT License.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NimTsRuntime, GpuBufferSlice } from '../ts/runtime.js';

const WASM_FILE = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('NimTsRuntime Unit Tests', () => {
  let wasmBytes: Uint8Array;

  beforeAll(async () => {
    wasmBytes = await fs.readFile(WASM_FILE);
  });

  describe('Uninitialized Guards', () => {
    it('throws error when accessing memory before init', () => {
      const runtime = new NimTsRuntime();
      expect(() => runtime.getMemory()).toThrow(/nimts module not initialized/);
    });

    it('throws error when calling passString before init', () => {
      const runtime = new NimTsRuntime();
      expect(() => runtime.passString('hello')).toThrow(/nimts module not initialized/);
    });

    it('throws error when calling passBytes before init', () => {
      const runtime = new NimTsRuntime();
      expect(() => runtime.passBytes(new Uint8Array([1, 2, 3]))).toThrow(/nimts module not initialized/);
    });

    it('free() does not throw when uninitialized', () => {
      const runtime = new NimTsRuntime();
      expect(() => runtime.free(0)).not.toThrow();
      expect(() => runtime.free(1234)).not.toThrow();
    });

    it('readString returns empty string for null pointer or zero length', () => {
      const runtime = new NimTsRuntime();
      expect(runtime.readString(0, 0)).toBe('');
      expect(runtime.readString(0, 10)).toBe('');
    });

    it('readBytes returns empty Uint8Array for null pointer or zero length', () => {
      const runtime = new NimTsRuntime();
      expect(runtime.readBytes(0, 0)).toEqual(new Uint8Array(0));
      expect(runtime.readBytes(0, 10)).toEqual(new Uint8Array(0));
    });

    it('throws when init() is called with no source', async () => {
      const runtime = new NimTsRuntime();
      await expect(runtime.init()).rejects.toThrow(/No valid WebAssembly source provided/);
    });
  });

  describe('createImportObject', () => {
    it('provides env with abort, promise resolvers, and wasi preview proxy', () => {
      const runtime = new NimTsRuntime();
      const imports = runtime.createImportObject() as any;

      expect(imports.env).toBeDefined();
      expect(typeof imports.env.abort).toBe('function');
      expect(typeof imports.env.nimts_js_resolve_promise).toBe('function');
      expect(typeof imports.env.nimts_js_reject_promise).toBe('function');

      // WASI preview1 proxy catches any call and returns 0
      expect(imports.wasi_snapshot_preview1).toBeDefined();
      expect(typeof imports.wasi_snapshot_preview1.fd_write).toBe('function');
      expect(imports.wasi_snapshot_preview1.fd_write()).toBe(0);
      expect(imports.wasi_snapshot_preview1.random_get()).toBe(0);
    });
  });

  describe('Initialized Runtime Operations', () => {
    it('initializes from Uint8Array bytes and allocates/reads memory', async () => {
      const runtime = new NimTsRuntime();
      const exports = await runtime.init(wasmBytes);
      expect(exports).toBeDefined();
      expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);

      // passString and readString roundtrip
      const testStr = 'Nim + TypeScript + WebAssembly = 🚀';
      const { ptr: strPtr, len: strLen } = runtime.passString(testStr);
      expect(strPtr).toBeGreaterThan(0);
      expect(strLen).toBeGreaterThan(0);

      const readBackStr = runtime.readString(strPtr, strLen);
      expect(readBackStr).toBe(testStr);
      runtime.free(strPtr);

      // passBytes and readBytes roundtrip
      const testBytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
      const { ptr: bytePtr, len: byteLen } = runtime.passBytes(testBytes);
      expect(bytePtr).toBeGreaterThan(0);
      expect(byteLen).toBe(testBytes.length);

      const readBackBytes = runtime.readBytes(bytePtr, byteLen);
      expect(readBackBytes).toEqual(testBytes);
      runtime.free(bytePtr);
    });

    it('initializes from pre-compiled WebAssembly.Module', async () => {
      const runtime = new NimTsRuntime();
      const module = await WebAssembly.compile(wasmBytes as any);
      const exports = await runtime.init(module);
      expect(exports).toBeDefined();
      expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);

      // Calling init again returns the cached exports
      const cached = await runtime.init(module);
      expect(cached).toBe(exports);
    });

    it('verifies NimMain and nimts_init are exported and callable in compiled WASM', async () => {
      const runtime = new NimTsRuntime();
      const exports = await runtime.init(wasmBytes);
      expect(typeof exports.NimMain).toBe('function');
      expect(typeof exports.nimts_init).toBe('function');
      expect(() => exports.NimMain()).not.toThrow();
      expect(() => exports.nimts_init()).not.toThrow();
    });

    it('synchronously initializes from WebAssembly.Module via initSync', async () => {
      const runtime = new NimTsRuntime();
      const module = await WebAssembly.compile(wasmBytes as any);
      const exports = runtime.initSync({ wasmModule: module });
      expect(exports).toBeDefined();
      expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);
      expect(typeof exports.nimts_alloc).toBe('function');

      // Test passString and readString on synchronously initialized runtime
      const testStr = 'AudioWorklet Synchronous DSP 🎛️';
      const { ptr, len } = runtime.passString(testStr);
      expect(ptr).toBeGreaterThan(0);
      expect(runtime.readString(ptr, len)).toBe(testStr);
      runtime.free(ptr);
    });

    it('synchronously initializes via fixture initNimTsSync', async () => {
      const { initNimTsSync, addNumbers, greet } = await import('./fixtures/test_module.js');
      const module = await WebAssembly.compile(wasmBytes as any);
      const exports = initNimTsSync({ wasmModule: module });
      expect(exports).toBeDefined();

      expect(addNumbers(40, 2)).toBe(42);
      expect(greet('AudioWorklet')).toBe('Hello, AudioWorklet!');
    });
  });

  describe('WebGPU Aligned Allocator & GpuBufferSlice', () => {
    it('allocates aligned memory and creates GpuBufferSlice with power-of-two alignments', async () => {
      const runtime = new NimTsRuntime();
      await runtime.init(wasmBytes);

      // WebGPU uniform buffer alignment: 256 bytes
      const slice256 = runtime.createGpuBufferSlice(1024, 256, 256);
      expect(slice256).toBeInstanceOf(GpuBufferSlice);
      expect(slice256.pointer).toBeGreaterThan(0);
      expect(slice256.pointer % 256).toBe(0);
      expect(slice256.byteLength).toBe(1024);
      expect(slice256.alignment).toBe(256);
      expect(slice256.len).toBe(256);

      // WebGPU storage buffer alignment: 4 bytes
      const slice4 = runtime.createGpuBufferSlice(64, 4, 16);
      expect(slice4.pointer).toBeGreaterThan(0);
      expect(slice4.pointer % 4).toBe(0);
      expect(slice4.byteLength).toBe(64);

      slice256.dispose();
      slice4.dispose();
    });

    it('GpuBufferSlice.writeToGpuBuffer invokes queue.writeBuffer zero-copy', async () => {
      const runtime = new NimTsRuntime();
      await runtime.init(wasmBytes);

      const slice = runtime.createGpuBufferSlice(128, 256, 32);
      const mockWriteBuffer = vi.fn();
      const mockDevice = {
        queue: {
          writeBuffer: mockWriteBuffer
        }
      };
      const mockGpuBuffer = { label: 'uniformBuffer' };

      slice.writeToGpuBuffer(mockDevice, mockGpuBuffer, 0);

      expect(mockWriteBuffer).toHaveBeenCalledTimes(1);
      const [targetBuf, offset, srcBuffer, srcOffset, byteLength] = mockWriteBuffer.mock.calls[0];
      expect(targetBuf).toBe(mockGpuBuffer);
      expect(offset).toBe(0);
      expect(srcBuffer).toBeInstanceOf(ArrayBuffer);
      expect(srcOffset).toBe(slice.pointer);
      expect(byteLength).toBe(slice.byteLength);

      slice.dispose();
    });

    it('GpuBufferSlice throws when device or queue is invalid', async () => {
      const slice = new GpuBufferSlice(100, 64, 256);
      expect(() => slice.writeToGpuBuffer(null, {})).toThrow(/WebGPU device is required/);
      expect(() => slice.writeToGpuBuffer({}, {})).toThrow(/does not support writeBuffer/);
    });
  });
});
