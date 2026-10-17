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
  nimts_get_last_result_ptr(): number;
  nimts_get_last_result_len(): number;
  nimts_resume_future?(futureId: number, dataPtr: number, dataLen: number, isError: number): void;
  [key: string]: any;
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

export class NimTsRuntime {
  public instance: WebAssembly.Instance | null = null;
  public exports: NimTsExports | null = null;
  private textDecoder = new TextDecoder('utf-8');
  private textEncoder = new TextEncoder();
  private pendingPromises = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  public getMemory(): WebAssembly.Memory {
    if (!this.exports) throw new Error('nimts module not initialized. Await init() first.');
    return this.exports.memory;
  }

  public readString(ptr: number, len: number): string {
    if (!ptr || len <= 0) return '';
    return this.textDecoder.decode(new Uint8Array(this.getMemory().buffer, ptr, len));
  }

  public readBytes(ptr: number, len: number): Uint8Array {
    if (!ptr || len <= 0) return new Uint8Array(0);
    return new Uint8Array(new Uint8Array(this.getMemory().buffer, ptr, len));
  }

  public passString(str: string): { ptr: number; len: number } {
    if (!this.exports) throw new Error('nimts module not initialized.');
    const encoded = this.textEncoder.encode(str);
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
      wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 })
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

    this.instance = new WebAssembly.Instance(module, this.createImportObject());
    this.exports = this.instance.exports as unknown as NimTsExports;
    return this.exports;
  }
}
