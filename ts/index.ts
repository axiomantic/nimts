/**
 * nimts - Seamless TypeScript & WebAssembly bridge for Nim with Vite integration, sync/async loaders, and Future<->Promise bridge
 * TypeScript + WebAssembly Entrypoint
 */

export * from './types.js';
export * from './runtime.js';
import { NimtsBridge } from './runtime.js';

export async function createNimts(): Promise<NimtsBridge> {
  const bridge = new NimtsBridge();
  return await bridge.init();
}

export default createNimts;
