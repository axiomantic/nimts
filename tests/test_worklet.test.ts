// tests/test_worklet.test.ts - Vitest suite for WebAudio AudioWorklet support
// Licensed under MIT License.

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createNimTsWorklet,
  createWorkletProcessorScript,
  NimTsAudioWorkletProcessor,
  extractTransfers
} from '../ts/worklet.js';
import { nimtsPlugin } from '../ts/vite-plugin-nimts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_WASM = path.resolve(__dirname, 'fixtures/test_module.wasm');

describe('WebAudio AudioWorklet Runtime & Client (Task 8.3)', () => {
  let wasmModule: WebAssembly.Module;

  beforeAll(async () => {
    const wasmBytes = await fs.readFile(FIXTURE_WASM);
    wasmModule = await WebAssembly.compile(wasmBytes);
  });

  describe('createWorkletProcessorScript', () => {
    it('generates self-contained processor bundle with registerProcessor', () => {
      const script = createWorkletProcessorScript({ processorName: 'my-custom-synth' });
      expect(script).toContain('class NimTsAudioWorkletProcessor extends AudioWorkletProcessor');
      expect(script).toContain('registerProcessor(\'my-custom-synth\', NimTsAudioWorkletProcessor);');
      expect(script).toContain('process(inputs, outputs, parameters)');
    });
  });

  describe('NimTsAudioWorkletProcessor in AudioWorkletGlobalScope', () => {
    it('instantiates synchronously from compiled WebAssembly.Module', () => {
      const processor = new NimTsAudioWorkletProcessor({
        processorOptions: {
          wasmModule,
          sampleRate: 48000
        }
      });

      expect(processor.exports).toBeDefined();
      expect(typeof processor.exports.addNumbers).toBe('function');
      expect(processor.sampleRate).toBe(48000);
      expect(processor.getStats().processCalls).toBe(0);
    });

    it('renders audio frames zero-copy and updates frameCount and processCalls', () => {
      const processor = new NimTsAudioWorkletProcessor({
        processorOptions: {
          wasmModule,
          sampleRate: 44100
        }
      });

      // Provide custom audioProcessFn
      let customRenderCalled = false;
      processor.audioProcessFn = (outChan: Float32Array, inChan: Float32Array | null, frames: number) => {
        customRenderCalled = true;
        for (let i = 0; i < frames; i++) {
          outChan[i] = 0.5;
        }
      };

      const outBuffer = new Float32Array(128);
      const inputs: Float32Array[][] = [];
      const outputs: Float32Array[][] = [[outBuffer]];

      const keepAlive = processor.process(inputs, outputs, {});
      expect(keepAlive).toBe(true);
      expect(customRenderCalled).toBe(true);
      expect(outBuffer[0]).toBe(0.5);
      expect(processor.getStats().processCalls).toBe(1);
      expect(processor.getStats().frameCount).toBe(128);
    });

    it('handles port RPC messages for ping, getStats, and methods', async () => {
      const processor = new NimTsAudioWorkletProcessor({
        processorOptions: { wasmModule }
      });

      const messages: any[] = [];
      processor.port = {
        postMessage: (msg: any) => messages.push(msg)
      };

      // 1. Ping
      await processor.handleMessage({ type: 'ping', id: 101 });
      expect(messages).toContainEqual({ type: 'pong', id: 101, success: true });

      // 2. getStats
      await processor.handleMessage({ type: 'getStats', id: 102 });
      const statsMsg = messages.find(m => m.id === 102);
      expect(statsMsg).toBeDefined();
      expect(statsMsg.success).toBe(true);
      expect(statsMsg.result.sampleRate).toBeDefined();

      // 3. Method call
      await processor.handleMessage({ type: 'call', id: 103, method: 'addNumbers', args: [25, 17] });
      const callMsg = messages.find(m => m.id === 103);
      expect(callMsg).toBeDefined();
      expect(callMsg.success).toBe(true);
      expect(callMsg.result).toBe(42);
    });
  });

  describe('createNimTsWorklet & NimTsWorkletClient', () => {
    it('creates client with strongly typed RPC proxy', async () => {
      const mockAudioContext: any = {
        sampleRate: 44100,
        audioWorklet: {
          addModule: async () => {}
        }
      };

      const client = await createNimTsWorklet<any>({
        audioContext: mockAudioContext,
        wasmModule
      });

      expect(client.node).toBeDefined();
      expect(client.port).toBeDefined();

      // RPC execution
      const sum = await client.addNumbers(100, 250);
      expect(sum).toBe(350);

      const greeting = await client.greet('AudioWorklet');
      expect(greeting).toBe('Hello, AudioWorklet!');

      // setParam
      await client.setParam('volume', 0.85);

      // getStats
      const stats = await client.getStats();
      expect(stats).toBeDefined();
      expect(stats.sampleRate).toBe(44100);

      // WebAudio connection delegation
      const mockDest = { id: 'destination-node' };
      const connected = client.connect(mockDest);
      expect(connected).toBeDefined();

      client.disconnect();
      client.dispose();
    });

    it('manages event subscriptions on worklet client', async () => {
      const mockAudioContext: any = {
        sampleRate: 44100,
        audioWorklet: { addModule: async () => {} }
      };

      const client = await createNimTsWorklet<any>({
        audioContext: mockAudioContext,
        wasmModule
      });

      const telemetryEvents: any[] = [];
      const unsubscribe = client.on('telemetry', (data: any) => {
        telemetryEvents.push(data);
      });

      // Simulate telemetry incoming from processor
      (client as any).node.port.onmessage?.({
        data: { type: 'telemetry', data: { cpuTimeMs: 0.12, underruns: 0 } }
      });

      expect(telemetryEvents.length).toBe(1);
      expect(telemetryEvents[0].cpuTimeMs).toBe(0.12);

      unsubscribe();
      (client as any).node.port.onmessage?.({
        data: { type: 'telemetry', data: { cpuTimeMs: 0.15 } }
      });
      expect(telemetryEvents.length).toBe(1);

      client.dispose();
    });
  });

  describe('Vite Plugin .nim?worklet Query Integration', () => {
    it('resolves .nim?worklet to path with ?worklet', async () => {
      const plugin = nimtsPlugin();
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: '/mock/project' });
      }

      const resolve = plugin.resolveId as Function;
      const res = await resolve.call({}, './synth.nim?worklet', '/mock/project/src/app.ts');
      expect(res).toBe(path.resolve('/mock/project/src', 'synth.nim') + '?worklet');
    });

    it('emits instantiable NimWorkletNode and createWorklet in load hook', async () => {
      const plugin = nimtsPlugin();
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: path.resolve(__dirname, '..') });
      }

      const load = plugin.load as Function;
      const fixturePath = path.resolve(__dirname, 'fixtures/test_module.nim') + '?worklet';
      const res = await load.call({}, fixturePath);

      expect(res).toBeDefined();
      expect(res.code).toContain('createNimTsWorklet');
      expect(res.code).toContain('class NimWorkletNode');
      expect(res.code).toContain('export async function createWorklet');
      expect(res.code).toContain('@axiomantic/nimts/worklet');
    });
  });
});
