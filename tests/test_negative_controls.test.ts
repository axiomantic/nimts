// tests/test_negative_controls.test.ts - Vitest integration negative control suites (NEG-01 to NEG-06)
// Licensed under MIT License.

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  initNimTs,
  createEngine,
  getEngineVolume,
  setEngineVolume,
  getNimTsModule,
  AudioEngine,
  streamWords,
  streamNumbers
} from './fixtures/test_module.js';

const WASM_FILE = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('Adversarial Negative Control Suites (NEG-01 to NEG-06)', () => {
  beforeAll(async () => {
    await initNimTs({ wasmPath: WASM_FILE });
  });

  describe('NEG-01: Real Channel Early-Break Memory Reclamation', () => {
    it('ensures early break in for-await loop closes channel and reclaims WASM resources', async () => {
      const channel = streamWords(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
      expect(channel.channelId).toBeGreaterThan(0);
      expect(channel.isClosed).toBe(false);

      const consumed: string[] = [];
      for await (const item of channel) {
        consumed.push(item);
        if (consumed.length === 2) {
          break; // Early break triggers .return()
        }
      }

      expect(consumed).toEqual(['alpha', 'beta']);
      expect(channel.isClosed).toBe(true);
      expect(channel.channelId).toBe(0);

      // Subsequent iterations yield done
      const res = await channel.next();
      expect(res.done).toBe(true);
      expect(res.value).toBeUndefined();
    });
  });

  describe('NEG-02: Real WASM Ring-Buffer Capacity Saturation Backpressure', () => {
    it('rejects pushes when channel capacity is saturated without corrupting ring buffer', async () => {
      // streamNumbers creates a real WASM NimTsChannel with capacity 32
      const channel = streamNumbers(32);
      expect(channel.channelId).toBeGreaterThan(0);
      expect(channel.isClosed).toBe(false);

      // Attempting to send into a saturated channel returns false (backpressure)
      const pushRejected = channel.send(999);
      expect(pushRejected).toBe(false);

      // Drain one item from the channel
      const first = await channel.next();
      expect(first.done).toBe(false);
      expect(first.value).toBe(1);

      // Now sending into the drained slot succeeds
      const pushAccepted = channel.send(999);
      expect(pushAccepted).toBe(true);

      channel.close();
      expect(channel.isClosed).toBe(true);
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
    it('verifies distinct module-namespaced C-ABI exports do not collide', () => {
      const wasm = getNimTsModule();
      expect(wasm).toBeDefined();

      // Check both module-namespaced exports are present and distinct
      expect(typeof wasm.nimts_audio_audioInit).toBe('function');
      expect(typeof wasm.nimts_video_videoInit).toBe('function');
      expect(wasm.nimts_audio_audioInit).not.toBe(wasm.nimts_video_videoInit);

      // Call each namespaced function and verify distinct behavior
      const audioRes = wasm.nimts_audio_audioInit(44100);
      expect(audioRes).toBe(88200);

      const videoRes = wasm.nimts_video_videoInit(60);
      expect(videoRes).toBe(70);
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

  describe('NEG-06: Automated TypeScript Type Validity (tsc --noEmit)', () => {
    it('validates that all generated .d.ts files compile cleanly with zero TypeScript errors', () => {
      const fixturesDts = path.resolve(__dirname, 'fixtures/test_module.d.ts');
      const output = execSync(`npx tsc --noEmit ${fixturesDts}`, {
        encoding: 'utf-8',
        cwd: path.resolve(__dirname, '..')
      });
      expect(output.trim()).toBe('');
    });
  });
});
