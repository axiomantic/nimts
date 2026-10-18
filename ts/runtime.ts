/**
 * @license MIT
 * Copyright (c) 2026 Axiomantic & Contributors
 *
 * nimts runtime - Core WebAssembly runtime support for TypeScript
 */

export interface NimTsExports {
  memory: WebAssembly.Memory;
  nimts_alloc(size: number): number;
  nimts_free(ptr: number): void;
  nimts_alloc_aligned?(size: number, alignment: number): number;
  nimts_free_aligned?(ptr: number): void;
  nimts_get_last_result_ptr(): number;
  nimts_get_last_result_len(): number;
  nimts_destroy_handle?(handleId: number): void;
  nimts_active_handle_count?(): number;
  nimts_resume_future?(futureId: number, dataPtr: number, dataLen: number, isError: number): void;
  [key: string]: any;
}

export class GpuBufferSlice<T = any> {
  readonly pointer: number;
  readonly byteLength: number;
  readonly alignment: number;
  readonly len: number;
  private _runtime: any;

  constructor(pointer: number, byteLength: number, alignment: number, len: number = 0, runtime?: any) {
    this.pointer = pointer;
    this.byteLength = byteLength;
    this.alignment = alignment;
    this.len = len || (byteLength > 0 ? byteLength : 0);
    this._runtime = runtime;
  }

  writeToGpuBuffer(device: any, targetGpuBuffer: any, offset = 0): void {
    if (!device) throw new Error('WebGPU device is required');
    const queue = device.queue || device;
    if (typeof queue.writeBuffer !== 'function') {
      throw new Error('WebGPU device or queue does not support writeBuffer');
    }
    let buffer: ArrayBuffer | null = null;
    if (typeof this._runtime === 'function') {
      const res = this._runtime();
      buffer = res?.buffer || res;
    } else if (this._runtime && typeof this._runtime.getMemory === 'function') {
      buffer = this._runtime.getMemory().buffer;
    } else if (this._runtime && this._runtime.buffer instanceof ArrayBuffer) {
      buffer = this._runtime.buffer;
    }
    if (!buffer) {
      throw new Error('Cannot access WebAssembly memory buffer for GpuBufferSlice');
    }
    const view = new Uint8Array(buffer, this.pointer, this.byteLength);
    queue.writeBuffer(targetGpuBuffer, offset, view.buffer, view.byteOffset, view.byteLength);
  }

  dispose(): void {
    if (this._runtime && typeof this._runtime.freeAligned === 'function' && this.pointer) {
      this._runtime.freeAligned(this.pointer);
    }
  }
}

export interface NimTsIterator<T> extends IterableIterator<T> {
  readonly handleId: number;
  next(): IteratorResult<T, undefined>;
  return(): IteratorResult<T, undefined>;
  dispose(): void;
  [Symbol.iterator](): IterableIterator<T>;
}

export interface NimTsChannel<T> extends AsyncIterable<T> {
  readonly channelId: number;
  next(): Promise<IteratorResult<T, undefined>>;
  return(): Promise<IteratorResult<T, undefined>>;
  close(): void;
  send?(item: T): boolean;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export interface NimTsOptions {
  wasmPath?: string | URL;
  wasmModule?: WebAssembly.Module;
  wasmBytes?: BufferSource;
  wasmInstance?: WebAssembly.Instance;
  imports?: WebAssembly.Imports;
}

const _globalTextDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
const _globalTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function _utf8Decode(bytes: Uint8Array): string {
  let str = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      str += String.fromCharCode(b1);
    } else if (b1 > 0xbf && b1 < 0xe0) {
      const b2 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 > 0xdf && b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      let cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      cp -= 0x10000;
      str += String.fromCharCode((cp >> 10) + 0xd800, (cp & 0x3ff) + 0xdc00);
    }
  }
  return str;
}

function _utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

export class NimTsRuntime {
  public instance: WebAssembly.Instance | null = null;
  public exports: NimTsExports | null = null;
  private pendingPromises = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  public getMemory(): WebAssembly.Memory {
    if (!this.exports) throw new Error('nimts module not initialized. Await init() first.');
    return this.exports.memory;
  }

  public readString(ptr: number, len: number): string {
    if (!ptr || len <= 0) return '';
    const bytes = new Uint8Array(this.getMemory().buffer, ptr, len);
    return _globalTextDecoder ? _globalTextDecoder.decode(bytes) : _utf8Decode(bytes);
  }

  public readBytes(ptr: number, len: number): Uint8Array {
    if (!ptr || len <= 0) return new Uint8Array(0);
    return new Uint8Array(new Uint8Array(this.getMemory().buffer, ptr, len));
  }

  public passString(str: string): { ptr: number; len: number } {
    if (!this.exports) throw new Error('nimts module not initialized.');
    const encoded = _globalTextEncoder ? _globalTextEncoder.encode(str) : _utf8Encode(str);
    const ptr = this.exports.nimts_alloc(encoded.length + 1);
    new Uint8Array(this.getMemory().buffer, ptr, encoded.length).set(encoded);
    return { ptr, len: encoded.length };
  }

  public passBytes(buf: Uint8Array | ArrayBuffer): { ptr: number; len: number } {
    if (!this.exports) throw new Error('nimts module not initialized.');
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const ptr = this.exports.nimts_alloc(bytes.length);
    new Uint8Array(this.getMemory().buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  public free(ptr: number): void {
    if (this.exports && ptr) {
      this.exports.nimts_free(ptr);
    }
  }

  public allocAligned(size: number, alignment: number): number {
    if (!this.exports) throw new Error('nimts module not initialized.');
    if (typeof this.exports.nimts_alloc_aligned === 'function') {
      return this.exports.nimts_alloc_aligned(size, alignment);
    }
    return this.exports.nimts_alloc(size);
  }

  public freeAligned(ptr: number): void {
    if (this.exports && ptr) {
      if (typeof this.exports.nimts_free_aligned === 'function') {
        this.exports.nimts_free_aligned(ptr);
      } else {
        this.exports.nimts_free(ptr);
      }
    }
  }

  public createGpuBufferSlice<T = any>(byteLength: number, alignment: number = 256, len: number = 0): GpuBufferSlice<T> {
    const ptr = this.allocAligned(byteLength, alignment);
    return new GpuBufferSlice<T>(ptr, byteLength, alignment, len, this);
  }

  public destroyHandle(handleId: number): void {
    if (this.exports && this.exports.nimts_destroy_handle && handleId > 0) {
      this.exports.nimts_destroy_handle(handleId);
    }
  }

  public getActiveHandleCount(): number {
    if (this.exports && typeof this.exports.nimts_active_handle_count === 'function') {
      return this.exports.nimts_active_handle_count();
    }
    return 0;
  }

  public createImportObject(): WebAssembly.Imports {
    return {
      env: {
        abort: () => console.error('[nimts] WASM abort called'),
        nimts_js_resolve_promise: (promiseId: number, ptr: number, len: number) => {
          const p = this.pendingPromises.get(promiseId);
          if (p) {
            this.pendingPromises.delete(promiseId);
            p.resolve({ ptr, len });
          }
        },
        nimts_js_reject_promise: (promiseId: number, errPtr: number, errLen: number) => {
          const p = this.pendingPromises.get(promiseId);
          if (p) {
            this.pendingPromises.delete(promiseId);
            p.reject(new Error(this.readString(errPtr, errLen)));
          }
        }
      },
      wasi_snapshot_preview1: new Proxy({}, {
        get: (_target, prop) => {
          if (prop === 'fd_prestat_get') return () => 8;
          if (prop === 'environ_sizes_get' || prop === 'args_sizes_get') {
            return (count_ptr: number, buf_size_ptr: number) => {
              const mem = (this.instance?.exports?.memory || (this.exports as any)?.memory) as WebAssembly.Memory | undefined;
              if (mem && mem.buffer) {
                const view = new DataView(mem.buffer);
                view.setUint32(count_ptr, 0, true);
                view.setUint32(buf_size_ptr, 0, true);
              }
              return 0;
            };
          }
          if (prop === 'fd_fdstat_get') {
            return (_fd: number, stat: number) => {
              const mem = (this.instance?.exports?.memory || (this.exports as any)?.memory) as WebAssembly.Memory | undefined;
              if (mem && mem.buffer) {
                const view = new DataView(mem.buffer);
                view.setUint8(stat, 2);
              }
              return 0;
            };
          }
          if (prop === 'fd_write') {
            return (_fd: number, iovs: number, iovs_len: number, nwritten: number) => {
              const mem = (this.instance?.exports?.memory || (this.exports as any)?.memory) as WebAssembly.Memory | undefined;
              if (mem && mem.buffer) {
                const view = new DataView(mem.buffer);
                let total = 0;
                for (let i = 0; i < iovs_len; i++) {
                  total += view.getUint32(iovs + i * 8 + 4, true);
                }
                view.setUint32(nwritten, total, true);
              }
              return 0;
            };
          }
          if (prop === 'proc_exit') {
            return (code: number) => {
              if (code !== 0) console.error('[WASI proc_exit]:', code);
            };
          }
          return () => 0;
        }
      })
    };
  }

  public async init(source?: string | Uint8Array | WebAssembly.Module): Promise<NimTsExports> {
    if (this.exports) return this.exports;

    let module: WebAssembly.Module | null = null;
    if (source instanceof WebAssembly.Module) {
      module = source;
    } else if (source instanceof Uint8Array) {
      module = await WebAssembly.compile(source as any);
    } else if (typeof source === 'string') {
      const resp = await fetch(source);
      const buf = await resp.arrayBuffer();
      module = await WebAssembly.compile(buf);
    }

    if (!module) {
      throw new Error('No valid WebAssembly source provided to NimTsRuntime');
    }

    const importObj = this.createImportObject();
    const instantiated = await WebAssembly.instantiate(module, importObj);
    const actualInstance = (instantiated instanceof WebAssembly.Instance) ? instantiated : (instantiated as any).instance;
    this.instance = actualInstance;
    this.exports = (actualInstance ? actualInstance.exports : null) as unknown as NimTsExports;
    if (typeof (this.exports as any).NimMain === 'function') {
      try {
        (this.exports as any).NimMain();
      } catch (e) {
        console.warn('[NimTsRuntime] NimMain error:', e);
      }
    }
    if (typeof (this.exports as any).nimts_init === 'function') {
      try {
        (this.exports as any).nimts_init();
      } catch (e) {
        console.warn('[NimTsRuntime] nimts_init error:', e);
      }
    }
    return this.exports;
  }

  public initSync(options: NimTsOptions | WebAssembly.Module | WebAssembly.Instance): NimTsExports {
    if (this.exports) return this.exports;

    let actualInstance: WebAssembly.Instance | null = null;
    let importObj = this.createImportObject();

    if (options instanceof WebAssembly.Instance) {
      actualInstance = options;
    } else if (options instanceof WebAssembly.Module) {
      actualInstance = new WebAssembly.Instance(options, importObj);
    } else if (options && typeof options === 'object') {
      if (options.imports) {
        importObj = { ...importObj, ...options.imports };
      }
      if (options.wasmInstance) {
        actualInstance = options.wasmInstance;
      } else if (options.wasmModule) {
        actualInstance = new WebAssembly.Instance(options.wasmModule, importObj);
      }
    }

    if (!actualInstance) {
      throw new Error('initSync requires options.wasmModule (compiled WebAssembly.Module) or options.wasmInstance');
    }

    this.instance = actualInstance;
    this.exports = actualInstance.exports as unknown as NimTsExports;

    if (typeof (this.exports as any).NimMain === 'function') {
      try {
        (this.exports as any).NimMain();
      } catch (e) {
        console.warn('[NimTsRuntime] NimMain error:', e);
      }
    }
    if (typeof (this.exports as any).nimts_init === 'function') {
      try {
        (this.exports as any).nimts_init();
      } catch (e) {
        console.warn('[NimTsRuntime] nimts_init error:', e);
      }
    }

    return this.exports;
  }
}
