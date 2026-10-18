/**
 * @license MIT
 * Copyright (c) 2026 Axiomantic & Contributors
 *
 * nimts worker - Multi-threaded WebWorker and node:worker_threads runtime client
 */

export interface SpawnWorkerOptions {
  wasmPath?: string | URL;
  wasmModule?: WebAssembly.Module;
  wasmBytes?: BufferSource;
  initOptions?: Record<string, any>;
  workerOptions?: any;
  transferBuffers?: boolean;
}

export type Promisified<M> = M extends (...args: infer P) => infer R
  ? (...args: P) => Promise<Awaited<R>> & AsyncIterable<any>
  : Promise<M>;

export type WorkerClient<T> = {
  [K in keyof T]: Promisified<T[K]>;
} & {
  terminate(): Promise<void>;
  readonly isTerminated: boolean;
  readonly rawWorker: any;
};

/**
 * Extracts ArrayBuffer instances and TypedArray backing buffers for zero-copy postMessage transfers.
 */
export function extractTransfers(val: unknown, set = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (val === null || val === undefined) return Array.from(set);
  if (val instanceof ArrayBuffer) {
    set.add(val);
  } else if (ArrayBuffer.isView(val) && val.buffer instanceof ArrayBuffer) {
    set.add(val.buffer);
  } else if (Array.isArray(val)) {
    for (const item of val) {
      extractTransfers(item, set);
    }
  } else if (typeof val === 'object') {
    for (const key of Object.keys(val as Record<string, any>)) {
      try {
        extractTransfers((val as any)[key], set);
      } catch (_) {}
    }
  }
  return Array.from(set);
}

/**
 * Generates the self-contained worker thread execution script.
 */
export function createWorkerScript(): string {
  return `
(async () => {
  const isNode = typeof process !== 'undefined' && process.versions?.node && typeof self === 'undefined';
  let parentPort = null;
  if (isNode) {
    const wt = await import('node:worker_threads');
    parentPort = wt.parentPort;
  } else {
    parentPort = self;
  }

  if (!parentPort) {
    throw new Error('nimts: Worker environment not recognized (missing parentPort or self)');
  }

  function extractTransfers(val, set = new Set()) {
    if (val === null || val === undefined) return Array.from(set);
    if (val instanceof ArrayBuffer) {
      set.add(val);
    } else if (ArrayBuffer.isView(val) && val.buffer instanceof ArrayBuffer) {
      set.add(val.buffer);
    } else if (Array.isArray(val)) {
      for (const item of val) extractTransfers(item, set);
    } else if (typeof val === 'object') {
      for (const key of Object.keys(val)) {
        try { extractTransfers(val[key], set); } catch (_) {}
      }
    }
    return Array.from(set);
  }

  let exportsObj = null;

  async function handleCall(msg) {
    const { id, method, args = [], streamPort } = msg;
    if (!exportsObj) {
      parentPort.postMessage({ type: 'result', id, success: false, error: 'Module not initialized in worker' });
      return;
    }
    if (typeof exportsObj[method] !== 'function') {
      parentPort.postMessage({ type: 'result', id, success: false, error: 'Method ' + method + ' not found on worker exports' });
      return;
    }

    try {
      const rawResult = exportsObj[method](...args);
      const result = (rawResult && typeof rawResult.then === 'function') ? await rawResult : rawResult;

      const isChannel = result && (
        typeof result[Symbol.asyncIterator] === 'function' ||
        (typeof result.next === 'function' && typeof result.channelId === 'number')
      );

      if (isChannel) {
        const iter = typeof result[Symbol.asyncIterator] === 'function'
          ? result[Symbol.asyncIterator]()
          : result;
        const collected = [];
        try {
          while (true) {
            const { value, done } = await iter.next();
            if (done) break;
            collected.push(value);
            if (streamPort) {
              const transfers = extractTransfers(value);
              streamPort.postMessage({ type: 'item', value }, transfers);
            }
          }
          if (streamPort) {
            streamPort.postMessage({ type: 'done' });
          }
          parentPort.postMessage({ type: 'result', id, success: true, result: collected });
        } catch (streamErr) {
          if (streamPort) {
            streamPort.postMessage({ type: 'error', error: streamErr?.message || String(streamErr) });
          }
          parentPort.postMessage({ type: 'result', id, success: false, error: streamErr?.message || String(streamErr) });
        }
      } else {
        const transfers = extractTransfers(result);
        parentPort.postMessage({ type: 'result', id, success: true, result }, transfers);
      }
    } catch (err) {
      if (streamPort) {
        streamPort.postMessage({ type: 'error', error: err?.message || String(err) });
      }
      parentPort.postMessage({ type: 'result', id, success: false, error: err?.message || String(err) });
    }
  }

  const onMsg = async (eventOrData) => {
    const msg = isNode ? eventOrData : eventOrData.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      try {
        const { moduleUrl, initOptions } = msg;
        const mod = await import(moduleUrl);
        const initFn = mod.initNimTs || mod.default?.initNimTs || (typeof mod.default === 'function' ? mod.default : null);
        if (typeof initFn === 'function') {
          exportsObj = await initFn(initOptions || {});
        } else {
          exportsObj = mod.default || mod;
        }
        const methods = Object.keys(exportsObj).filter(k => typeof exportsObj[k] === 'function');
        parentPort.postMessage({ type: 'ready', methods });
      } catch (err) {
        parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
      }
    } else if (msg.type === 'call') {
      await handleCall(msg);
    } else if (msg.type === 'terminate') {
      if (isNode) {
        process.exit(0);
      } else {
        self.close();
      }
    }
  };

  if (isNode) {
    parentPort.on('message', onMsg);
  } else {
    self.onmessage = onMsg;
  }
})();
`;
}

function createStreamIterator<T>(port: any): AsyncIterable<T> {
  const queue: Array<{ value?: T; done: boolean; error?: any }> = [];
  let pendingResolve: ((res: IteratorResult<T, undefined>) => void) | null = null;
  let pendingReject: ((err: any) => void) | null = null;
  let isDone = false;

  const onMessage = (msg: any) => {
    const data = msg?.data !== undefined ? msg.data : msg;
    if (!data) return;

    if (data.type === 'item') {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve({ value: data.value, done: false });
      } else {
        queue.push({ value: data.value, done: false });
      }
    } else if (data.type === 'done') {
      isDone = true;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve({ value: undefined, done: true });
      } else {
        queue.push({ done: true });
      }
    } else if (data.type === 'error') {
      isDone = true;
      const err = new Error(data.error);
      if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        reject(err);
      } else {
        queue.push({ done: true, error: err });
      }
    }
  };

  if (typeof port.on === 'function') {
    port.on('message', onMessage);
  } else {
    port.onmessage = onMessage;
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (queue.length > 0) {
            const item = queue.shift()!;
            if (item.error) return Promise.reject(item.error);
            if (item.done) return Promise.resolve({ value: undefined, done: true });
            return Promise.resolve({ value: item.value as T, done: false });
          }
          if (isDone) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
        return(): Promise<IteratorResult<T, undefined>> {
          isDone = true;
          try {
            if (typeof port.close === 'function') port.close();
          } catch (_) {}
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
}

async function resolveModuleTarget(target: any): Promise<string> {
  if (typeof target === 'string') {
    if (typeof process !== 'undefined' && process.versions?.node && typeof (globalThis as any).Worker === 'undefined') {
      const path = await import('node:path');
      const url = await import('node:url');
      if (target.startsWith('file://') || target.startsWith('http://') || target.startsWith('https://')) {
        return target;
      }
      return url.pathToFileURL(path.resolve(target)).href;
    }
    return target;
  }
  if (target instanceof URL) {
    return target.href;
  }
  if (typeof target === 'object' && target?.moduleUrl) {
    return resolveModuleTarget(target.moduleUrl);
  }
  throw new Error(`nimts: Cannot resolve worker module from ${typeof target}`);
}

/**
 * Spawns an isolated WebWorker or node:worker_threads worker running a nimts WASM module.
 *
 * @param moduleOrUrl URL or path to the compiled nimts JS module, or an instantiable Worker class
 * @param options Worker configuration, wasmPath, and initialization options
 */
export async function spawnWorker<T = any>(
  moduleOrUrl: any,
  options: SpawnWorkerOptions = {}
): Promise<WorkerClient<T>> {
  // Check if moduleOrUrl is an instantiable Worker class or helper with static spawn
  if (typeof moduleOrUrl === 'function') {
    if (typeof moduleOrUrl.spawn === 'function') {
      return moduleOrUrl.spawn(options);
    }
    const instance = new moduleOrUrl(options);
    if (instance instanceof Promise) {
      return instance;
    }
  }

  const isNode = typeof process !== 'undefined' && process.versions?.node && typeof (globalThis as any).Worker === 'undefined';
  let rawWorker: any = null;
  const workerCode = createWorkerScript();

  if (isNode) {
    const wt = await import('node:worker_threads');
    rawWorker = new wt.Worker(workerCode, {
      eval: true,
      ...(options.workerOptions || {})
    });
  } else {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    rawWorker = new (globalThis as any).Worker(blobUrl, {
      type: 'module',
      ...(options.workerOptions || {})
    });
  }

  const resolvedModuleUrl = await resolveModuleTarget(moduleOrUrl);
  const pendingCalls = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  let callIdCounter = 1;
  let isTerminated = false;

  const onWorkerMessage = (rawMsg: any) => {
    const msg = rawMsg?.data !== undefined ? rawMsg.data : rawMsg;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'result') {
      const pending = pendingCalls.get(msg.id);
      if (pending) {
        pendingCalls.delete(msg.id);
        if (msg.success) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error));
        }
      }
    }
  };

  if (isNode) {
    rawWorker.on('message', onWorkerMessage);
    rawWorker.on('error', (err: any) => {
      for (const [, p] of pendingCalls) {
        p.reject(err);
      }
      pendingCalls.clear();
    });
  } else {
    rawWorker.addEventListener('message', onWorkerMessage);
    rawWorker.addEventListener('error', (err: any) => {
      const errorObj = new Error(err.message || 'Worker error');
      for (const [, p] of pendingCalls) {
        p.reject(errorObj);
      }
      pendingCalls.clear();
    });
  }

  // Initialize module in worker
  await new Promise<void>((resolve, reject) => {
    const readyListener = (rawMsg: any) => {
      const msg = rawMsg?.data !== undefined ? rawMsg.data : rawMsg;
      if (msg?.type === 'ready') {
        cleanup();
        resolve();
      } else if (msg?.type === 'error') {
        cleanup();
        reject(new Error(msg.error));
      }
    };

    const cleanup = () => {
      if (isNode) {
        rawWorker.off('message', readyListener);
      } else {
        rawWorker.removeEventListener('message', readyListener);
      }
    };

    if (isNode) {
      rawWorker.on('message', readyListener);
    } else {
      rawWorker.addEventListener('message', readyListener);
    }

    const initPayload = {
      wasmPath: options.wasmPath ? String(options.wasmPath) : undefined,
      wasmModule: options.wasmModule,
      wasmBytes: options.wasmBytes,
      ...(options.initOptions || {})
    };

    rawWorker.postMessage({
      type: 'init',
      moduleUrl: resolvedModuleUrl,
      initOptions: initPayload
    });
  });

  const client = {
    isTerminated: false,
    rawWorker,
    async terminate(): Promise<void> {
      if (isTerminated) return;
      isTerminated = true;
      (client as any).isTerminated = true;

      for (const [, p] of pendingCalls) {
        p.reject(new Error('Worker terminated'));
      }
      pendingCalls.clear();

      try {
        rawWorker.postMessage({ type: 'terminate' });
      } catch (_) {}

      if (typeof rawWorker.terminate === 'function') {
        await rawWorker.terminate();
      }
    }
  };

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in target) {
        return (target as any)[prop];
      }
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined;
      }

      return (...args: any[]) => {
        if (isTerminated) {
          return Promise.reject(new Error('Worker has been terminated'));
        }

        const id = callIdCounter++;
        const shouldTransfer = options.transferBuffers !== false;
        const transfers = shouldTransfer ? extractTransfers(args) : [];

        let channel: any = null;
        let streamPort: any = null;
        let streamIter: AsyncIterable<any> | null = null;

        if (typeof globalThis.MessageChannel !== 'undefined') {
          channel = new globalThis.MessageChannel();
          streamPort = channel.port2;
          streamIter = createStreamIterator(channel.port1);
          transfers.push(channel.port2);
        }

        const callPromise = new Promise((resolve, reject) => {
          pendingCalls.set(id, { resolve, reject });
          rawWorker.postMessage({
            type: 'call',
            id,
            method: prop,
            args,
            streamPort
          }, transfers);
        });

        if (streamIter) {
          (callPromise as any)[Symbol.asyncIterator] = () => streamIter![Symbol.asyncIterator]();
        }

        return callPromise;
      };
    }
  });

  return proxy as unknown as WorkerClient<T>;
}
