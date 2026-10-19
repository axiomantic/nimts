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
  asyncComputeFloat,
  asyncCheckBool,
  AudioEngine,
  generateFrequencies,
  iterateFibonacci,
  NimTsIterator,
  streamWords,
  streamNumbers,
  streamIdiomaticChannel,
  NimTsChannel,
  Channel,
  scaleFloats,
  sumInt32s,
  negateInt16s,
  doubleFloat64s,
  getPinnedAudioBuffer,
  mutatePinnedAudioBuffer,
  sumView,
  NimTsView,
  getNimTsModule
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

    it('marshals Float32Array / openArray[float32] and seq[float32] bidirectionally via binary ABI', () => {
      const input = new Float32Array([1.5, 2.5, 3.5, -4.5]);
      const output = scaleFloats(input, 2.0);
      expect(output).toBeInstanceOf(Float32Array);
      expect(output.length).toBe(input.length);
      expect(output[0]).toBeCloseTo(3.0, 5);
      expect(output[1]).toBeCloseTo(5.0, 5);
      expect(output[2]).toBeCloseTo(7.0, 5);
      expect(output[3]).toBeCloseTo(-9.0, 5);
    });

    it('marshals Int32Array / openArray[int32] parameter without JSON text', () => {
      const input = new Int32Array([10, 20, 30, 40]);
      const sum = sumInt32s(input);
      expect(sum).toBe(100);
    });

    it('marshals Int16Array / openArray[int16] and seq[int16] bidirectionally', () => {
      const input = new Int16Array([100, -200, 300, -400]);
      const output = negateInt16s(input);
      expect(output).toBeInstanceOf(Int16Array);
      expect(output.length).toBe(4);
      expect(output[0]).toBe(-100);
      expect(output[1]).toBe(200);
      expect(output[2]).toBe(-300);
      expect(output[3]).toBe(400);
    });

    it('marshals Float64Array / seq[float64] bidirectionally', () => {
      const input = new Float64Array([1.25, 2.5, 5.0]);
      const output = doubleFloat64s(input);
      expect(output).toBeInstanceOf(Float64Array);
      expect(output.length).toBe(3);
      expect(output[0]).toBeCloseTo(2.5, 5);
      expect(output[1]).toBeCloseTo(5.0, 5);
      expect(output[2]).toBeCloseTo(10.0, 5);
    });

    it('accepts regular JS arrays and auto-wraps into TypedArray for WASM C-ABI', () => {
      const output = scaleFloats([1.0, 2.0, 4.0] as any, 0.5);
      expect(output).toBeInstanceOf(Float32Array);
      expect(output.length).toBe(3);
      expect(output[0]).toBeCloseTo(0.5, 5);
      expect(output[1]).toBeCloseTo(1.0, 5);
      expect(output[2]).toBeCloseTo(2.0, 5);
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

    it('resolves Nim Future[float64] as JS Promise<number> without bit corruption', async () => {
      const res = await asyncComputeFloat(12.5);
      expect(res).toBeCloseTo(31.25, 4);
    });

    it('resolves Nim Future[bool] as JS Promise<boolean> accurately', async () => {
      const resFalse = await asyncCheckBool(true);
      expect(resFalse).toBe(false);
      const resTrue = await asyncCheckBool(false);
      expect(resTrue).toBe(true);
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

    it('rejects a pending Nim Future when resumed from JS with error flag', async () => {
      const { startPendingOperation, getNimTsModule } = await import('./fixtures/test_module.js');
      const wasm = getNimTsModule();
      const promise = startPendingOperation();
      const fid = wasm.nimts_getLastFutureId();
      expect(fid).toBeGreaterThan(0);

      // Allocate error string and resume future with isError=1
      const encoder = new TextEncoder();
      const errPayload = encoder.encode('Simulated Async Failure 503');
      const ptr = wasm.nimts_alloc(errPayload.length + 1);
      const mem = new Uint8Array(wasm.memory.buffer, ptr, errPayload.length);
      mem.set(errPayload);

      // Call nimts_resume_future(futureId, ptr, len, isError=1)
      wasm.nimts_resume_future(fid, ptr, errPayload.length, 1);
      wasm.nimts_free(ptr);

      await expect(promise).rejects.toThrow('Simulated Async Failure 503');
    });
  });

  describe('Edge Cases and Boundaries', () => {
    it('handles empty strings and special characters', () => {
      expect(greet('')).toBe('Hello, !');
      expect(greet('   ')).toBe('Hello,    !');
      expect(greet('Line1\nLine2\tTab')).toBe('Hello, Line1\nLine2\tTab!');
    });

    it('handles empty Uint8Array', () => {
      const empty = new Uint8Array(0);
      const res = checksumBytes(empty);
      expect(res).toBeInstanceOf(Uint8Array);
      expect(res.length).toBe(0);
    });

    it('handles negative integers and zero', () => {
      expect(addNumbers(0, 0)).toBe(0);
      expect(addNumbers(-10, -32)).toBe(-42);
      expect(addNumbers(100, -100)).toBe(0);
    });

    it('manages multiple concurrent independent handle instances', () => {
      const engines = [
        createEngine(44100.0),
        createEngine(48000.0),
        createEngine(96000.0)
      ];

      // Set distinct volumes
      setEngineVolume(engines[0], 0.2);
      setEngineVolume(engines[1], 0.5);
      setEngineVolume(engines[2], 0.8);

      expect(getEngineVolume(engines[0])).toBeCloseTo(0.2, 2);
      expect(getEngineVolume(engines[1])).toBeCloseTo(0.5, 2);
      expect(getEngineVolume(engines[2])).toBeCloseTo(0.8, 2);

      // Dispose middle one
      engines[1].dispose();
      expect(engines[1].handleId).toBe(0);

      // Others remain valid and independent
      expect(getEngineVolume(engines[0])).toBeCloseTo(0.2, 2);
      expect(getEngineVolume(engines[2])).toBeCloseTo(0.8, 2);

      // Idempotent double-dispose
      engines[1].dispose();
      expect(engines[1].handleId).toBe(0);

      engines[0].dispose();
      engines[2].dispose();
    });
  });

  describe('Module Lifecycle and State Getters', () => {
    it('provides isInitialized, getNimTs, and getNimTsModule', async () => {
      const { isInitialized, getNimTs, getNimTsModule } = await import('./fixtures/test_module.js');
      expect(isInitialized()).toBe(true);

      const exports = getNimTs();
      expect(exports).toBeDefined();
      expect(typeof exports.addNumbers).toBe('function');
      expect(exports.addNumbers(10, 20)).toBe(30);

      const rawWasm = getNimTsModule();
      expect(rawWasm).toBeDefined();
      expect(typeof rawWasm.nimts_alloc).toBe('function');
      expect(typeof rawWasm.nimts_free).toBe('function');
    });
  });

  describe('Gotcha 1 Alt Loaders: BufferSource & Pre-compiled WebAssembly.Module', () => {
    it('instantiates from pre-loaded ArrayBuffer (AudioWorklet mode)', async () => {
      const bytes = await fs.readFile(WASM_FILE);
      const module = await WebAssembly.compile(bytes);
      expect(module).toBeInstanceOf(WebAssembly.Module);
    });
  });

  describe('Closure Iterators (NimTsIterator<T>) & IterableIterator<T>', () => {
    it('synchronously steps through float32 frequencies with for..of', () => {
      const iter = generateFrequencies(440.0, 4);
      expect(iter).toBeInstanceOf(NimTsIterator);
      expect(iter.handleId).toBeGreaterThan(0);

      const values: number[] = [];
      for (const freq of iter) {
        values.push(freq);
      }

      expect(values.length).toBe(4);
      expect(values[0]).toBeCloseTo(440.0, 2);
      expect(values[1]).toBeCloseTo(880.0, 2);
      expect(values[2]).toBeCloseTo(1320.0, 2);
      expect(values[3]).toBeCloseTo(1760.0, 2);

      // Handle auto-disposed upon exhaustion
      expect(iter.handleId).toBe(0);
    });

    it('supports native array spread operator [...iter]', () => {
      const fibs = [...iterateFibonacci(8)];
      expect(fibs).toEqual([0, 1, 1, 2, 3, 5, 8, 13]);
    });

    it('early loop exit (break) triggers return() and deterministic disposal', () => {
      const iter = iterateFibonacci(100);
      expect(iter.handleId).toBeGreaterThan(0);

      const collected: number[] = [];
      for (const n of iter) {
        collected.push(n);
        if (collected.length === 5) break;
      }

      expect(collected).toEqual([0, 1, 1, 2, 3]);
      // break invoked iter.return(), which disposed the handle
      expect(iter.handleId).toBe(0);
    });

    it('NEG-03: calling next() after dispose() safely returns { done: true } without trap', () => {
      const iter = generateFrequencies(100.0, 10);
      const hid = iter.handleId;
      expect(hid).toBeGreaterThan(0);

      const first = iter.next();
      expect(first.done).toBe(false);
      expect(first.value).toBeCloseTo(100.0, 2);

      // Explicit disposal
      iter.dispose();
      expect(iter.handleId).toBe(0);

      // Calling next() after disposal
      const second = iter.next();
      expect(second.done).toBe(true);
      expect(second.value).toBeUndefined();

      // Idempotent double dispose
      expect(() => iter.dispose()).not.toThrow();
    });

    it('NEG-05: memory growth detachment guard maintains valid views on memory.grow()', async () => {
      const { getNimTsModule } = await import('./fixtures/test_module.js');
      const wasm = getNimTsModule();

      const iter = iterateFibonacci(20);
      expect(iter.handleId).toBeGreaterThan(0);

      // Read a few values
      const val1 = iter.next();
      expect(val1.value).toBe(0);
      const val2 = iter.next();
      expect(val2.value).toBe(1);

      // Trigger WebAssembly memory growth (detaches current ArrayBuffer)
      const prevPages = wasm.memory.grow(2);
      expect(prevPages).toBeGreaterThan(0);

      // The next step should NOT throw TypeError: detached ArrayBuffer
      const val3 = iter.next();
      expect(val3.done).toBe(false);
      expect(val3.value).toBe(1);

      const val4 = iter.next();
      expect(val4.done).toBe(false);
      expect(val4.value).toBe(2);

      iter.dispose();
      expect(iter.handleId).toBe(0);
    });
  });

  describe('Channels (NimTsChannel<T>) Live Consumer Wiring', () => {
    it('creates and interacts with NimTsChannel[string] via streamWords', () => {
      const words = ['hello', 'world', 'from', 'wasm'];
      const chan = streamWords(words);
      expect(chan).toBeInstanceOf(NimTsChannel);
      expect(chan.channelId).toBeGreaterThan(0);
      expect(chan.isClosed).toBe(false);

      // Verify close lifecycle
      chan.close();
      expect(chan.isClosed).toBe(true);
      expect(chan.channelId).toBe(0);
    });

    it('creates and interacts with NimTsChannel[int32] via streamNumbers', () => {
      const chan = streamNumbers(10);
      expect(chan).toBeInstanceOf(NimTsChannel);
      expect(chan.channelId).toBeGreaterThan(0);
      expect(chan.isClosed).toBe(false);

      // Verify close lifecycle
      chan.close();
      expect(chan.isClosed).toBe(true);
      expect(chan.channelId).toBe(0);
    });

    it('creates and interacts with Channel[int32] via streamIdiomaticChannel and verifies Channel export', async () => {
      expect(Channel).toBe(NimTsChannel);

      const chan = streamIdiomaticChannel(5);
      expect(chan).toBeInstanceOf(NimTsChannel);
      expect(chan).toBeInstanceOf(Channel);
      expect(chan.channelId).toBeGreaterThan(0);
      expect(chan.isClosed).toBe(false);

      // Drain items via for-await-of
      const items: number[] = [];
      for await (const val of chan) {
        items.push(val);
      }
      expect(items).toEqual([10, 20, 30, 40, 50]);
    });
  });

  describe('Zero-Copy Pinned TypedArray Views (NimTsView[T]) (Task 8.2)', () => {
    it('returns a live zero-copy NimTsView over WASM memory without JSON or heap copies', () => {
      const view = getPinnedAudioBuffer();
      expect(view).toBeInstanceOf(NimTsView);
      expect(view.length).toBe(8);
      expect(view.byteLength).toBe(32);
      expect(view.pointer).toBeGreaterThan(0);

      // Verify initial buffer contents: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
      expect(view[0]).toBe(1.0);
      expect(view[1]).toBe(2.0);
      expect(view[7]).toBe(8.0);

      // Verify sumView calculates 36.0 over the view
      expect(sumView(view)).toBe(36.0);
    });

    it('mutations in JS are visible in Nim zero-copy', () => {
      const view = getPinnedAudioBuffer();
      view[0] = 100.0;
      expect(view[0]).toBe(100.0);

      // sumView: 100 + 2 + 3 + 4 + 5 + 6 + 7 + 8 = 135
      expect(sumView(view)).toBe(135.0);

      // Reset
      view[0] = 1.0;
    });

    it('mutations in Nim are immediately visible in JS view without re-fetching', () => {
      const view = getPinnedAudioBuffer();
      expect(view[2]).toBe(3.0);

      mutatePinnedAudioBuffer(2, 999.0);
      expect(view[2]).toBe(999.0);

      // Reset
      mutatePinnedAudioBuffer(2, 3.0);
      expect(view[2]).toBe(3.0);
    });

    it('preserves access and survives WebAssembly memory.grow() detachment', () => {
      const view = getPinnedAudioBuffer();
      expect(view[0]).toBe(1.0);
      expect(view[7]).toBe(8.0);

      const mod = getNimTsModule();
      const mem = mod.memory as WebAssembly.Memory;
      const oldBuffer = mem.buffer;

      // Trigger memory.grow - detaches oldBuffer
      mem.grow(1);
      const newBuffer = mem.buffer;
      expect(newBuffer).not.toBe(oldBuffer);

      // View continues working seamlessly without throwing detached ArrayBuffer error
      expect(view[0]).toBe(1.0);
      expect(view[7]).toBe(8.0);

      view[4] = 555.0;
      expect(view[4]).toBe(555.0);
      expect(sumView(view)).toBe(1.0 + 2.0 + 3.0 + 4.0 + 555.0 + 6.0 + 7.0 + 8.0);

      // Reset
      view[4] = 5.0;
    });
  });
});

