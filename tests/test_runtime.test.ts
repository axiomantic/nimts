// tests/test_runtime.test.ts - Unit tests for NimTsRuntime TypeScript core
// Licensed under MIT License.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NimTsRuntime } from '../ts/runtime.js';

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
  });
});
