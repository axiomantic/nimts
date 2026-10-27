/**
 * Types and interfaces for nimts WASM bridge.
 */

export interface WasmModuleExports {
  memory?: WebAssembly.Memory;
  hello?: () => number;
  add?: (a: number, b: number) => number;
  [key: string]: unknown;
}

export interface BridgeOptions {
  wasmPath?: string;
  wasmBinary?: ArrayBufferView | ArrayBuffer;
}

export interface NimtsInstance {
  readonly ready: boolean;
  hello(): string;
  add(a: number, b: number): number;
}
