// tests/test_worker.test.ts - Vitest suite for WebWorker and worker_threads runtime client
// Licensed under MIT License.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWorker, extractTransfers, WorkerClient } from '../ts/worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_JS = path.resolve(__dirname, 'fixtures/test_module.js');
const FIXTURE_WASM = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('WebWorker & node:worker_threads Runtime Client', () => {
  let worker: WorkerClient<any>;

  beforeAll(async () => {
    worker = await spawnWorker(FIXTURE_JS, {
      wasmPath: FIXTURE_WASM
    });
  });

  afterAll(async () => {
    if (worker && !worker.isTerminated) {
      await worker.terminate();
    }
  });

  describe('extractTransfers utility', () => {
    it('returns empty array for primitives or null', () => {
      expect(extractTransfers(null)).toEqual([]);
      expect(extractTransfers(undefined)).toEqual([]);
      expect(extractTransfers(42)).toEqual([]);
      expect(extractTransfers('hello')).toEqual([]);
    });

    it('extracts ArrayBuffer and TypedArray buffers', () => {
      const buf = new ArrayBuffer(16);
      const u8 = new Uint8Array(8);
      const transfers = extractTransfers([buf, u8]);
      expect(transfers).toContain(buf);
      expect(transfers).toContain(u8.buffer);
      expect(transfers.length).toBe(2);
    });

    it('extracts nested buffers in objects', () => {
      const u16 = new Uint16Array([1, 2, 3]);
      const obj = { nested: { view: u16 } };
      const transfers = extractTransfers(obj);
      expect(transfers).toContain(u16.buffer);
    });
  });

  describe('Synchronous Primitives and Strings', () => {
    it('executes addNumbers over worker RPC', async () => {
      const sum = await worker.addNumbers(15, 27);
      expect(sum).toBe(42);
    });

    it('executes greet string transformation over worker RPC', async () => {
      const greeting = await worker.greet('NimTs Worker');
      expect(greeting).toBe('Hello, NimTs Worker!');
    });
  });

  describe('Zero-Copy Buffer Transfers', () => {
    it('transfers Uint8Array and detaches caller buffer', async () => {
      const input = new Uint8Array([10, 20, 30, 40]);
      expect(input.byteLength).toBe(4);

      const promise = worker.checksumBytes(input);
      // Immediately after dispatch, input.buffer has been transferred and detached
      expect(input.byteLength).toBe(0);

      const result = await promise;
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(10 ^ 0xFF);
      expect(result[1]).toBe(20 ^ 0xFF);
      expect(result[2]).toBe(30 ^ 0xFF);
      expect(result[3]).toBe(40 ^ 0xFF);
    });

    it('can optionally disable buffer detachment with transferBuffers: false', async () => {
      const nonDetachingWorker = await spawnWorker(FIXTURE_JS, {
        wasmPath: FIXTURE_WASM,
        transferBuffers: false
      });

      const input = new Uint8Array([1, 2, 3, 4]);
      expect(input.byteLength).toBe(4);

      const result = await nonDetachingWorker.checksumBytes(input);
      expect(input.byteLength).toBe(4); // Not detached
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result[0]).toBe(1 ^ 0xFF);

      await nonDetachingWorker.terminate();
    });
  });

  describe('Async / Future Bridge', () => {
    it('automatically awaits Future[T] in worker and resolves Promise<T>', async () => {
      const res = await worker.asyncAdd(100, 250);
      expect(res).toBe(350);
    });

    it('resolves async string echo', async () => {
      const res = await worker.asyncEcho('Off-thread non-blocking');
      expect(res).toBe('Async: Off-thread non-blocking');
    });

    it('resolves async floating point computation', async () => {
      const res = await worker.asyncComputeFloat(4.0);
      expect(res).toBe(10.0);
    });

    it('resolves async boolean check', async () => {
      const res = await worker.asyncCheckBool(true);
      expect(res).toBe(false);
    });
  });

  describe('Channel Streaming across MessagePort', () => {
    it('streams items via for-await AsyncIterable', async () => {
      const wordsToStream = ['apple', 'banana', 'cherry'];
      const stream = worker.streamWords(wordsToStream);

      const collected: string[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      expect(collected).toEqual(wordsToStream);
    });

    it('resolves channel as an aggregated array when directly awaited', async () => {
      const wordsToStream = ['one', 'two', 'three'];
      const result = await worker.streamWords(wordsToStream);
      expect(result).toEqual(wordsToStream);
    });

    it('streams numeric channel via for-await', async () => {
      const stream = worker.streamNumbers(5);
      const nums: number[] = [];
      for await (const n of stream) {
        nums.push(n);
      }
      expect(nums).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('Error Handling and Termination', () => {
    it('rejects with error when calling an undefined method', async () => {
      await expect(worker.nonExistentMethod(123)).rejects.toThrow(/Method nonExistentMethod not found/);
    });

    it('terminates worker cleanly and prevents further calls', async () => {
      const tempWorker = await spawnWorker(FIXTURE_JS, {
        wasmPath: FIXTURE_WASM
      });

      expect(tempWorker.isTerminated).toBe(false);
      const testRes = await tempWorker.addNumbers(1, 1);
      expect(testRes).toBe(2);

      await tempWorker.terminate();
      expect(tempWorker.isTerminated).toBe(true);

      await expect(tempWorker.addNumbers(2, 2)).rejects.toThrow(/Worker has been terminated/);
    });
  });
});
