/**
 * @license MIT
 * Copyright (c) 2026 Axiomantic & Contributors
 *
 * nimts worklet - First-class WebAudio AudioWorklet support for Nim WebAssembly
 */

import { extractTransfers } from './worker.js';
import { NimTsRuntime } from './runtime.js';
export { extractTransfers };

export interface NimTsWorkletOptions {
  audioContext: any; // AudioContext | BaseAudioContext
  processorName?: string;
  wasmPath?: string | URL;
  wasmModule?: WebAssembly.Module;
  wasmBytes?: BufferSource;
  workletScriptUrl?: string | URL;
  nodeOptions?: any;
  audioProcessName?: string;
  transferBuffers?: boolean;
  sampleRate?: number;
}

export interface WorkletStats {
  sampleRate: number;
  frameCount: number;
  processCalls: number;
  cpuTimeMs: number;
  underruns: number;
}

export type Promisified<M> = M extends (...args: infer P) => infer R
  ? (...args: P) => Promise<Awaited<R>>
  : Promise<M>;

export type WorkletClient<T> = {
  [K in keyof T]: Promisified<T[K]>;
} & {
  readonly node: any; // AudioWorkletNode
  readonly port: any; // MessagePort
  setParam(name: string, value: number): Promise<void>;
  getStats(): Promise<WorkletStats>;
  on(event: string, handler: (data: any) => void): () => void;
  off(event: string, handler: (data: any) => void): void;
  subscribe(event: string, handler: (data: any) => void): () => void;
  connect(destination: any, outputIndex?: number, inputIndex?: number): any;
  disconnect(destination?: any, outputIndex?: number, inputIndex?: number): void;
  dispose(): void;
};

// Base fallback for environments outside AudioWorkletGlobalScope (e.g. Node / Vitest)
const _globalScope: any = typeof globalThis !== 'undefined' ? globalThis : {};
const AudioWorkletProcessorBase: any = _globalScope.AudioWorkletProcessor || class MockAudioWorkletProcessor {
  port: any = {
    onmessage: null,
    postMessage: () => {}
  };
  constructor(_options?: any) {}
};

/**
 * NimTsAudioWorkletProcessor runs inside AudioWorkletGlobalScope.
 * Handles synchronous WASM instantiation, port RPC, and zero-copy audio rendering.
 */
export class NimTsAudioWorkletProcessor extends AudioWorkletProcessorBase {
  public exports: any = null;
  public rawExports: any = null;
  public runtime: NimTsRuntime | null = null;
  public instance: WebAssembly.Instance | null = null;
  public memory: WebAssembly.Memory | null = null;
  public audioProcessFn: any = null;
  public sampleRate: number = 44100;
  public frameCount: number = 0;
  public processCalls: number = 0;
  public totalCpuTimeMs: number = 0;
  public underruns: number = 0;
  private processErrorLogged = false;

  constructor(options?: any) {
    super(options);

    const procOptions = options?.processorOptions || {};
    this.sampleRate = procOptions.sampleRate || _globalScope.sampleRate || 44100;

    // Initialize WASM instance synchronously if module or instance provided
    if (procOptions.wasmInstance) {
      this.initFromInstance(procOptions.wasmInstance, procOptions.audioProcessName);
    } else if (procOptions.wasmModule) {
      this.initFromModule(procOptions.wasmModule, procOptions.audioProcessName);
    }

    // Set up port RPC handling
    if (this.port) {
      this.port.onmessage = (event: any) => this.handleMessage(event.data);
    }
  }

  public initFromInstance(instance: WebAssembly.Instance, audioProcessName?: string, runtime?: NimTsRuntime): void {
    this.instance = instance;
    this.rawExports = instance.exports;
    this.runtime = runtime || new NimTsRuntime();
    if (!runtime) {
      try { this.runtime.initSync(instance); } catch (_) {}
    }

    // Wrap exports with a transparent proxy that checks raw export name, 'nimts_' prefix, or runtime
    this.exports = new Proxy(this.rawExports as any, {
      get: (target, prop: string | symbol) => {
        if (typeof prop !== 'string') return target[prop];
        if (prop in target) return target[prop];
        const prefixed = 'nimts_' + prop;
        if (prefixed in target) return target[prefixed];
        return target[prop];
      },
      has: (target, prop: string | symbol) => {
        if (typeof prop !== 'string') return prop in target;
        return prop in target || ('nimts_' + prop) in target;
      }
    });

    this.memory = (this.rawExports?.memory as WebAssembly.Memory) || null;

    if (typeof (this.rawExports as any)?.NimMain === 'function') {
      try { (this.rawExports as any).NimMain(); } catch (e) { console.warn('[NimTsWorklet] NimMain:', e); }
    }
    if (typeof (this.rawExports as any)?.nimts_init === 'function') {
      try { (this.rawExports as any).nimts_init(); } catch (e) { console.warn('[NimTsWorklet] nimts_init:', e); }
    }

    this.resolveAudioProcessFn(audioProcessName);
  }

  public initFromModule(module: WebAssembly.Module, audioProcessName?: string): void {
    const runtime = new NimTsRuntime();
    const importObj = runtime.createImportObject();
    try {
      const instance = new WebAssembly.Instance(module, importObj);
      runtime.initSync(instance);
      this.initFromInstance(instance, audioProcessName, runtime);
    } catch (err) {
      console.error('[NimTsWorklet] Failed to instantiate WebAssembly.Module:', err);
    }
  }

  private resolveAudioProcessFn(preferredName?: string): void {
    if (!this.exports) return;
    if (preferredName && typeof this.exports[preferredName] === 'function') {
      this.audioProcessFn = this.exports[preferredName];
      return;
    }
    const candidates = [
      'processAudio',
      'nimts_processAudio',
      'audioProcess',
      'nimts_audioProcess',
      'renderAudio',
      'nimts_renderAudio',
      'processAudioBlock',
      'renderWorkletFrame',
      'nimts_renderWorkletFrame',
      'processRealtimeAudio',
      'nimts_processRealtimeAudio'
    ];
    for (const name of candidates) {
      if (typeof this.exports[name] === 'function') {
        this.audioProcessFn = this.exports[name];
        return;
      }
    }
    for (const key of Object.keys(this.rawExports || {})) {
      if ((key.includes('processAudio') || key.includes('audioProcess') || key.includes('renderWorklet')) && typeof this.rawExports[key] === 'function') {
        this.audioProcessFn = this.rawExports[key];
        return;
      }
    }
  }

  public getStats(): WorkletStats {
    return {
      sampleRate: this.sampleRate,
      frameCount: this.frameCount,
      processCalls: this.processCalls,
      cpuTimeMs: this.totalCpuTimeMs,
      underruns: this.underruns
    };
  }

  public async handleMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const { id, type, method, args = [], name, value } = msg;

    if (type === 'ping') {
      this.port?.postMessage({ type: 'pong', id, success: true });
      return;
    }

    if (type === 'getStats') {
      this.port?.postMessage({ type: 'result', id, success: true, result: this.getStats() });
      return;
    }

    if (type === 'initWasm') {
      try {
        if (msg.wasmModule) {
          this.initFromModule(msg.wasmModule, msg.audioProcessName);
        }
        this.port?.postMessage({ type: 'result', id, success: true });
      } catch (err: any) {
        this.port?.postMessage({ type: 'result', id, success: false, error: err?.message || String(err) });
      }
      return;
    }

    if (type === 'setParam') {
      try {
        const setterName = 'set' + name.charAt(0).toUpperCase() + name.slice(1);
        if (this.exports && typeof this.exports[setterName] === 'function') {
          this.exports[setterName](value);
        } else if (this.exports && typeof this.exports[name] === 'function') {
          this.exports[name](value);
        } else if (this.exports && name in this.exports) {
          this.exports[name] = value;
        }
        this.port?.postMessage({ type: 'result', id, success: true });
      } catch (err: any) {
        this.port?.postMessage({ type: 'result', id, success: false, error: err?.message || String(err) });
      }
      return;
    }

    if (type === 'call') {
      if (!this.exports) {
        this.port?.postMessage({ type: 'result', id, success: false, error: 'WASM exports not initialized in worklet' });
        return;
      }

      let fn = this.exports[method];
      if (typeof fn !== 'function' && typeof method === 'string') {
        fn = this.exports['nimts_' + method];
      }
      if (typeof fn !== 'function') {
        this.port?.postMessage({ type: 'result', id, success: false, error: `Method "${method}" not found on worklet exports` });
        return;
      }

      try {
        let callArgs = args;
        const allocatedPtrs: number[] = [];

        if (this.runtime && method in this.exports && !('nimts_' + method in (this.rawExports || {}))) {
          callArgs = args;
        } else if (this.runtime) {
          const newArgs: any[] = [];
          for (const arg of args) {
            if (typeof arg === 'string') {
              const { ptr, len } = this.runtime.passString(arg);
              allocatedPtrs.push(ptr);
              newArgs.push(ptr, len);
            } else if (arg instanceof Uint8Array || arg instanceof ArrayBuffer) {
              const { ptr, len } = this.runtime.passBytes(arg);
              allocatedPtrs.push(ptr);
              newArgs.push(ptr, len);
            } else {
              newArgs.push(arg);
            }
          }
          callArgs = newArgs;
        }

        let result = fn(...callArgs);
        if (result && typeof result.then === 'function') {
          result = await result;
        }

        for (const ptr of allocatedPtrs) {
          try { this.runtime?.free(ptr); } catch (_) {}
        }

        // If returned pointer or void with last result
        if (this.rawExports?.nimts_get_last_result_ptr && this.runtime) {
          const resPtr = (this.rawExports.nimts_get_last_result_ptr as Function)();
          const resLen = (this.rawExports.nimts_get_last_result_len as Function)();
          if (resPtr && resLen > 0) {
            result = this.runtime.readString(resPtr, resLen);
          }
        }

        const transfers = extractTransfers(result);
        this.port?.postMessage({ type: 'result', id, success: true, result }, transfers);
      } catch (err: any) {
        this.port?.postMessage({ type: 'result', id, success: false, error: err?.message || String(err) });
      }
    }
  }

  public process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const startTime = typeof performance !== 'undefined' ? performance.now() : 0;
    this.processCalls++;

    const numOutputs = outputs.length;
    if (numOutputs > 0 && outputs[0].length > 0) {
      const outChannel0 = outputs[0][0];
      const inChannel0 = (inputs.length > 0 && inputs[0].length > 0) ? inputs[0][0] : null;
      const frames = outChannel0.length;
      this.frameCount += frames;

      if (typeof this.audioProcessFn === 'function') {
        try {
          this.audioProcessFn(outChannel0, inChannel0, frames);
        } catch (err) {
          this.underruns++;
          if (!this.processErrorLogged) {
            console.error('[NimTsWorkletProcessor] Audio process error:', err);
            this.processErrorLogged = true;
          }
        }
      }
    }

    if (startTime > 0 && typeof performance !== 'undefined') {
      this.totalCpuTimeMs += (performance.now() - startTime);
    }

    return true; // Keep processor alive in audio render loop
  }
}

/**
 * Returns the self-contained source string for the AudioWorkletProcessor script.
 */
export function createWorkletProcessorScript(options: { processorName?: string } = {}): string {
  const processorName = options.processorName || 'nimts-worklet-processor';
  return `
// nimts AudioWorkletProcessor bundle
class NimTsAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.exports = null;
    this.rawExports = null;
    this.audioProcessFn = null;
    this.sampleRate = options?.processorOptions?.sampleRate || sampleRate || 44100;
    this.frameCount = 0;
    this.processCalls = 0;
    this.cpuTimeMs = 0;

    const procOpts = options?.processorOptions || {};
    if (procOpts.wasmModule) {
      try {
        const importObj = {
          env: {
            memory: new WebAssembly.Memory({ initial: 256, maximum: 32768 }),
            abort: () => {}
          },
          wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 })
        };
        const instance = new WebAssembly.Instance(procOpts.wasmModule, importObj);
        this.rawExports = instance.exports;
        this.exports = new Proxy(this.rawExports, {
          get: (target, prop) => {
            if (prop in target) return target[prop];
            if (typeof prop === 'string' && ('nimts_' + prop) in target) return target['nimts_' + prop];
            return target[prop];
          }
        });

        if (typeof this.rawExports.NimMain === 'function') this.rawExports.NimMain();
        if (typeof this.rawExports.nimts_init === 'function') this.rawExports.nimts_init();

        const pName = procOpts.audioProcessName;
        if (pName && typeof this.exports[pName] === 'function') {
          this.audioProcessFn = this.exports[pName];
        } else {
          for (const k of ['processAudio', 'nimts_processAudio', 'audioProcess', 'nimts_audioProcess', 'renderAudio', 'processAudioBlock']) {
            if (typeof this.exports[k] === 'function') { this.audioProcessFn = this.exports[k]; break; }
          }
        }
      } catch (err) {
        console.error('[NimTsWorklet] Instantiation error:', err);
      }
    }

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, type, method, args = [], name, value } = msg;

    if (type === 'ping') {
      this.port.postMessage({ type: 'pong', id, success: true });
      return;
    }
    if (type === 'getStats') {
      this.port.postMessage({
        type: 'result',
        id,
        success: true,
        result: { sampleRate: this.sampleRate, frameCount: this.frameCount, processCalls: this.processCalls, cpuTimeMs: this.cpuTimeMs }
      });
      return;
    }
    if (type === 'setParam') {
      const setter = 'set' + name.charAt(0).toUpperCase() + name.slice(1);
      if (this.exports && typeof this.exports[setter] === 'function') this.exports[setter](value);
      else if (this.exports && typeof this.exports[name] === 'function') this.exports[name](value);
      this.port.postMessage({ type: 'result', id, success: true });
      return;
    }
    if (type === 'call') {
      if (!this.exports) {
        this.port.postMessage({ type: 'result', id, success: false, error: 'WASM exports not initialized' });
        return;
      }
      let fn = this.exports[method];
      if (typeof fn !== 'function' && typeof method === 'string') fn = this.exports['nimts_' + method];
      if (typeof fn !== 'function') {
        this.port.postMessage({ type: 'result', id, success: false, error: 'Method ' + method + ' not found' });
        return;
      }
      try {
        let res = fn(...args);
        if (res && typeof res.then === 'function') res = await res;
        this.port.postMessage({ type: 'result', id, success: true, result: res });
      } catch (err) {
        this.port.postMessage({ type: 'result', id, success: false, error: err?.message || String(err) });
      }
    }
  }

  process(inputs, outputs, parameters) {
    this.processCalls++;
    if (outputs.length > 0 && outputs[0].length > 0) {
      const outChan = outputs[0][0];
      const inChan = (inputs.length > 0 && inputs[0].length > 0) ? inputs[0][0] : null;
      this.frameCount += outChan.length;
      if (typeof this.audioProcessFn === 'function') {
        try {
          this.audioProcessFn(outChan, inChan, outChan.length);
        } catch (_) {}
      }
    }
    return true;
  }
}

registerProcessor('${processorName}', NimTsAudioWorkletProcessor);
`;
}

/**
 * Main-Thread strongly-typed NimTsWorkletClient wrapping AudioWorkletNode.
 */
export class NimTsWorkletClient<T = any> {
  public readonly node: any;
  public readonly port: any;
  private pendingCalls = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  private callId = 1;
  private transferBuffers: boolean;
  public proxy: WorkletClient<T>;

  constructor(node: any, options: { transferBuffers?: boolean } = {}) {
    this.node = node;
    this.port = node.port;
    this.transferBuffers = options.transferBuffers !== false;

    if (this.port) {
      this.port.onmessage = (event: any) => this.handleMessage(event.data);
    }

    this.proxy = new Proxy(this as any, {
      get: (target: any, prop: string | symbol) => {
        if (typeof prop === 'symbol' || prop in target || prop === 'then') {
          return target[prop];
        }
        return (...args: any[]) => this.call(prop as string, ...args);
      }
    });
  }

  private handleMessage(data: any): void {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'result' || data.type === 'pong') {
      const pending = this.pendingCalls.get(data.id);
      if (pending) {
        this.pendingCalls.delete(data.id);
        if (data.success) {
          pending.resolve(data.result);
        } else {
          pending.reject(new Error(data.error || 'Worklet call failed'));
        }
      }
      return;
    }

    if (data.type === 'event' || data.type === 'telemetry') {
      const eventName = data.event || data.type;
      const handlers = this.listeners.get(eventName);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(data.data !== undefined ? data.data : data); } catch (e) { console.error(e); }
        }
      }
    }
  }

  public call(method: string, ...args: any[]): Promise<any> {
    const id = this.callId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      const transfers = this.transferBuffers ? extractTransfers(args) : [];
      try {
        this.port.postMessage({ type: 'call', id, method, args }, transfers);
      } catch (err) {
        this.pendingCalls.delete(id);
        reject(err);
      }
    });
  }

  public setParam(name: string, value: number): Promise<void> {
    const id = this.callId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      this.port.postMessage({ type: 'setParam', id, name, value });
    });
  }

  public getStats(): Promise<WorkletStats> {
    const id = this.callId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      this.port.postMessage({ type: 'getStats', id });
    });
  }

  public ping(): Promise<void> {
    const id = this.callId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      this.port.postMessage({ type: 'ping', id });
    });
  }

  public on(event: string, handler: (data: any) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  public off(event: string, handler: (data: any) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  public subscribe(event: string, handler: (data: any) => void): () => void {
    return this.on(event, handler);
  }

  public connect(destination: any, outputIndex?: number, inputIndex?: number): any {
    if (this.node && typeof this.node.connect === 'function') {
      return this.node.connect(destination, outputIndex, inputIndex);
    }
    return destination;
  }

  public disconnect(destination?: any, outputIndex?: number, inputIndex?: number): void {
    if (this.node && typeof this.node.disconnect === 'function') {
      this.node.disconnect(destination, outputIndex, inputIndex);
    }
  }

  public dispose(): void {
    this.disconnect();
    for (const [id, pending] of this.pendingCalls.entries()) {
      pending.reject(new Error('Worklet client disposed'));
    }
    this.pendingCalls.clear();
    this.listeners.clear();
  }
}

/**
 * Creates and initializes a NimTS AudioWorklet node connected to an AudioContext.
 */
export async function createNimTsWorklet<T = any>(options: NimTsWorkletOptions): Promise<WorkletClient<T>> {
  const {
    audioContext,
    processorName = 'nimts-worklet-processor',
    wasmPath,
    wasmBytes,
    workletScriptUrl,
    nodeOptions = {},
    audioProcessName,
    transferBuffers = true
  } = options;

  if (!audioContext) {
    throw new Error('nimts: audioContext (AudioContext | BaseAudioContext) is required');
  }

  let wasmModule = options.wasmModule;

  // Compile WebAssembly.Module if bytes or path provided
  if (!wasmModule) {
    if (wasmBytes) {
      wasmModule = await WebAssembly.compile(wasmBytes);
    } else if (wasmPath) {
      if (typeof fetch !== 'undefined') {
        const resp = await fetch(wasmPath);
        wasmModule = await WebAssembly.compileStreaming(resp).catch(async () => {
          const buf = await resp.arrayBuffer();
          return WebAssembly.compile(buf);
        });
      }
    }
  }

  // Register AudioWorklet processor module
  if (audioContext.audioWorklet && typeof audioContext.audioWorklet.addModule === 'function') {
    let scriptUrl = workletScriptUrl;
    let blobUrlToRevoke: string | null = null;
    if (!scriptUrl) {
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const code = createWorkletProcessorScript({ processorName });
        const blob = new Blob([code], { type: 'application/javascript' });
        scriptUrl = URL.createObjectURL(blob);
        blobUrlToRevoke = scriptUrl;
      }
    }
    if (scriptUrl) {
      try {
        await audioContext.audioWorklet.addModule(scriptUrl);
      } catch (err) {
        console.warn('[NimTsWorklet] audioWorklet.addModule warning:', err);
      } finally {
        if (blobUrlToRevoke) {
          try { URL.revokeObjectURL(blobUrlToRevoke); } catch (_) {}
        }
      }
    }
  }

  // Create AudioWorkletNode
  let node: any = null;
  const mergedProcessorOptions = {
    wasmModule,
    sampleRate: options.sampleRate || audioContext.sampleRate || 44100,
    audioProcessName,
    ...(nodeOptions.processorOptions || {})
  };

  const finalNodeOptions = {
    ...nodeOptions,
    processorOptions: mergedProcessorOptions
  };

  if (typeof _globalScope.AudioWorkletNode !== 'undefined') {
    node = new _globalScope.AudioWorkletNode(audioContext, processorName, finalNodeOptions);
  } else if (typeof audioContext.createAudioWorkletNode === 'function') {
    node = audioContext.createAudioWorkletNode(processorName, finalNodeOptions);
  } else {
    // Mock node fallback for Node / headless tests
    const mockPortA: any = { onmessage: null, postMessage: null };
    const mockPortB: any = { onmessage: null, postMessage: null };
    mockPortA.postMessage = (msg: any) => setTimeout(() => mockPortB.onmessage?.({ data: msg }), 0);
    mockPortB.postMessage = (msg: any) => setTimeout(() => mockPortA.onmessage?.({ data: msg }), 0);

    const mockProcessor = new NimTsAudioWorkletProcessor(finalNodeOptions);
    mockProcessor.port = mockPortB;
    mockPortB.onmessage = (e: any) => mockProcessor.handleMessage(e.data);

    node = {
      port: mockPortA,
      processor: mockProcessor,
      connect: (dest: any) => dest,
      disconnect: () => {}
    };
  }

  const client = new NimTsWorkletClient<T>(node, { transferBuffers });
  return client.proxy;
}

export default createNimTsWorklet;
