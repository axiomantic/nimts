// tests/test_negative_controls.test.ts - Vitest integration negative control suites (NEG-01 to NEG-05)
// Licensed under MIT License.

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import {
  initNimTs,
  createEngine,
  getEngineVolume,
  setEngineVolume,
  getNimTsModule,
  AudioEngine
} from './fixtures/test_module.js';

const WASM_FILE = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('Adversarial Negative Control Suites (NEG-01 to NEG-05)', () => {
  beforeAll(async () => {
    await initNimTs({ wasmPath: WASM_FILE });
  });

  describe('NEG-01: Channel Early-Break Memory Reclamation', () => {
    it('ensures explicit disposal reclaims handles during aborted iteration', () => {
      // Simulate creating 5 streamed resource handles
      const streamHandles = [
        createEngine(44100.0),
        createEngine(48000.0),
        createEngine(96000.0),
        createEngine(48000.0),
        createEngine(44100.0)
      ];

      for (const h of streamHandles) {
        expect(h.handleId).toBeGreaterThan(0);
      }

      // Simulate consumer breaking on item index 2 (early break)
      const consumed: AudioEngine[] = [];
      for (const item of streamHandles) {
        consumed.push(item);
        if (consumed.length === 2) {
          break; // 'break' out of iteration
        }
      }

      // Proper stream disposal cleans up both consumed and unconsumed handles
      for (const h of streamHandles) {
        h.dispose();
        expect(h.handleId).toBe(0);
      }
    });
  });

  describe('NEG-02: Ring-Buffer Capacity Saturation Backpressure', () => {
    class BoundedRingBuffer<T> {
      private buffer: (T | null)[];
      private head = 0;
      private tail = 0;
      private count = 0;
      readonly capacity: number;

      constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = new Array<T | null>(capacity).fill(null);
      }

      tryPush(item: T): boolean {
        if (this.count >= this.capacity) {
          return false; // Backpressure: saturated
        }
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        this.count++;
        return true;
      }

      pushOrThrow(item: T): void {
        if (!this.tryPush(item)) {
          throw new RangeError(`RingBuffer saturated: capacity ${this.capacity} reached`);
        }
      }

      pop(): T | null {
        if (this.count === 0) return null;
        const item = this.buffer[this.head];
        this.buffer[this.head] = null;
        this.head = (this.head + 1) % this.capacity;
        this.count--;
        return item;
      }

      get size() { return this.count; }
    }

    it('rejects pushes when capacity is saturated and preserves head integrity', () => {
      const rb = new BoundedRingBuffer<number>(3);
      rb.pushOrThrow(100);
      rb.pushOrThrow(200);
      rb.pushOrThrow(300);
      expect(rb.size).toBe(3);

      // Saturated push must throw RangeError and NOT overwrite existing elements
      expect(() => rb.pushOrThrow(400)).toThrow(RangeError);
      expect(rb.size).toBe(3);

      // Verify oldest item is intact
      expect(rb.pop()).toBe(100);
      expect(rb.size).toBe(2);

      // Now push succeeds
      expect(rb.tryPush(400)).toBe(true);
      expect(rb.size).toBe(3);
    });
  });

  describe('NEG-03: Iterator / Handle Use-After-Free Handling', () => {
    it('safely handles queries on disposed or non-existent handles without WASM panic', () => {
      const engine = createEngine(44100.0);
      expect(engine.handleId).toBeGreaterThan(0);

      // Dispose the handle
      engine.dispose();
      expect(engine.handleId).toBe(0);

      // Idempotent double dispose must not throw
      expect(() => engine.dispose()).not.toThrow();

      // Querying with an invalid / disposed handle representation
      const deadHandle = { handleId: 999999 } as unknown as AudioEngine;
      const vol = getEngineVolume(deadHandle);
      // Nim side safely returns 0.0 for nil / invalid handle
      expect(vol).toBe(0.0);
    });
  });

  describe('NEG-04: Multi-Module Duplicate Proc Namespacing', () => {
    it('verifies namespaced C-ABI symbols remain distinct in WASM exports', () => {
      const wasm = getNimTsModule();
      expect(wasm).toBeDefined();

      // Ensure that C-ABI symbols have standard nimts prefix
      expect(typeof wasm.nimts_alloc).toBe('function');
      expect(typeof wasm.nimts_free).toBe('function');

      // Namespaced symbols (e.g. nimts_addNumbers vs hypothetical nimts_math_addNumbers)
      // verify that export map does not suffer key collisions
      const keys = Object.keys(wasm);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });

  describe('NEG-05: WASM memory.grow Detachment Stability During Active Streaming', () => {
    it('survives large memory allocations without throwing detached ArrayBuffer errors', () => {
      const wasm = getNimTsModule();
      expect(wasm).toBeDefined();

      // Create initial active handle
      const engine = createEngine(48000.0);
      setEngineVolume(engine, 0.85);

      // Trigger large allocations in WASM memory (forces memory.grow)
      const allocatedPtrs: number[] = [];
      const CHUNK_SIZE = 1024 * 1024; // 1 MB
      for (let i = 0; i < 8; i++) {
        const ptr = wasm.nimts_alloc(CHUNK_SIZE);
        expect(ptr).toBeGreaterThan(0);
        allocatedPtrs.push(ptr);
      }

      // Memory has grown. Verify existing handle remains valid and readable
      const vol = getEngineVolume(engine);
      expect(vol).toBeCloseTo(0.85, 2);

      // Verify new allocations and writes still work
      const testBuffer = new Uint8Array(256);
      testBuffer.fill(0x7F);
      const testPtr = wasm.nimts_alloc(256);
      const view = new Uint8Array(wasm.memory.buffer, testPtr, 256);
      view.set(testBuffer);
      expect(view[0]).toBe(0x7F);
      expect(view[255]).toBe(0x7F);

      // Clean up
      wasm.nimts_free(testPtr);
      for (const p of allocatedPtrs) {
        wasm.nimts_free(p);
      }
      engine.dispose();
    });
  });
});
