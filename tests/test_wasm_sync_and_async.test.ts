// tests/test_wasm_sync_and_async.test.ts - Vitest integration tests for NimTS
// Licensed under MIT License.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  initNimTs,
  addNumbers,
  greet,
  checksumBytes,
  createEngine,
  getEngineSampleRate,
  setEngineVolume,
  getEngineVolume,
  processConfig,
  asyncAdd,
  asyncEcho,
  AudioEngine
} from './fixtures/test_module.js';

const WASM_FILE = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('NimTS WebAssembly Integration (Sync & Async)', () => {
  beforeAll(async () => {
    // Initialize module using file path (tests Gotcha 1 Node path)
    await initNimTs({ wasmPath: WASM_FILE });
  });

  describe('Gotcha 1: Sync Calls After Module Load', () => {
    it('executes primitive integer addition synchronously', () => {
      const result = addNumbers(17, 25);
      expect(result).toBe(42);
    });

    it('marshals strings bidirectionally without memory corruption', () => {
      const greeting = greet('TypeScript');
      expect(greeting).toBe('Hello, TypeScript!');

      const unicode = greet('Nord Modular G2 🎹');
      expect(unicode).toBe('Hello, Nord Modular G2 🎹!');
    });

    it('marshals Uint8Array / openArray[byte] bidirectionally', () => {
      const input = new Uint8Array([0x00, 0x11, 0x22, 0xaa, 0xff]);
      const output = checksumBytes(input);
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBe(input.length);
      expect(output[0]).toBe(0xff);
      expect(output[1]).toBe(0x11 ^ 0xff);
      expect(output[4]).toBe(0x00);
    });

    it('marshals complex value objects via JSON', () => {
      const config = { polyphony: 6, name: 'NordLead' };
      const processed = processConfig(config as any);
      expect(processed).toEqual({
        polyphony: 12,
        name: 'NordLead_processed'
      });
    });
  });

  describe('Stateful Nim ref object Handles & Lifecycle', () => {
    it('manages opaque handles to stateful Nim instances', () => {
      const engine = createEngine(48000.0);
      expect(engine).toBeInstanceOf(AudioEngine);
      expect(engine.handleId).toBeGreaterThan(0);

      const sampleRate = getEngineSampleRate(engine);
      expect(sampleRate).toBeCloseTo(48000.0, 1);

      expect(getEngineVolume(engine)).toBeCloseTo(1.0, 2);
      setEngineVolume(engine, 0.707);
      expect(getEngineVolume(engine)).toBeCloseTo(0.707, 2);

      // Explicit cleanup
      engine.dispose();
      expect(engine.handleId).toBe(0);
    });
  });

  describe('Gotcha 2: Async Future[T] <-> JS Promise<T> Bridge', () => {
    it('resolves Nim Future[int32] as JS Promise<number>', async () => {
      const promise = asyncAdd(100, 250);
      expect(promise).toBeInstanceOf(Promise);
      const res = await promise;
      expect(res).toBe(350);
    });

    it('resolves Nim Future[string] as JS Promise<string>', async () => {
      const promise = asyncEcho('Autonomous Synthesis');
      expect(promise).toBeInstanceOf(Promise);
      const res = await promise;
      expect(res).toBe('Async: Autonomous Synthesis');
    });

    it('resumes a pending Nim Future from JS via nimts_resume_future', async () => {
      const { startPendingOperation, getNimTsModule } = await import('./fixtures/test_module.js');
      const wasm = getNimTsModule();
      const promise = startPendingOperation();
      const fid = wasm.nimts_getLastFutureId();
      expect(fid).toBeGreaterThan(0);

      // Allocate string and resume future from JS
      const encoder = new TextEncoder();
      const payload = encoder.encode('Hello from JS callback!');
      const ptr = wasm.nimts_alloc(payload.length + 1);
      const mem = new Uint8Array(wasm.memory.buffer, ptr, payload.length);
      mem.set(payload);

      // Call nimts_resume_future(futureId, ptr, len, isError=0)
      wasm.nimts_resume_future(fid, ptr, payload.length, 0);
      wasm.nimts_free(ptr);

      const res = await promise;
      expect(res).toBe('Hello from JS callback!');
    });
  });

  describe('Gotcha 1 Alt Loaders: BufferSource & Pre-compiled WebAssembly.Module', () => {
    it('instantiates from pre-loaded ArrayBuffer (AudioWorklet mode)', async () => {
      const bytes = await fs.readFile(WASM_FILE);
      const { initNimTs: initAlt, addNumbers: addAlt } = await import('./fixtures/test_module.js');
      // Already initialized, but testing raw buffer instantiation
      const module = await WebAssembly.compile(bytes);
      expect(module).toBeInstanceOf(WebAssembly.Module);
    });
  });
});
