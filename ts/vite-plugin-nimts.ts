// ts/vite-plugin-nimts.ts - Vite plugin for seamless Nim -> TypeScript/WASM imports
// Licensed under MIT License.

import type { Plugin, ResolvedConfig } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

export interface NimTsPluginOptions {
  nimBin?: string;
  clangBin?: string;
  wasmldBin?: string;
  sysroot?: string;
  nimLib?: string;
  extraNimFlags?: string[];
  outDir?: string;
  publicDir?: string;
  backend?: 'standalone' | 'emscripten';
  emccBin?: string;
  emccFlags?: string[];
}

export function nimtsPlugin(options: NimTsPluginOptions = {}): Plugin {
  let config: ResolvedConfig;
  const backend = options.backend || 'standalone';
  const nimBin = options.nimBin || process.env.NIM_BIN || 'nim';
  const clangBin = options.clangBin || process.env.CLANG_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin/clang' : 'clang');
  const wasmldBin = options.wasmldBin || process.env.WASM_LD_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/bin/wasm-ld') ? '/opt/homebrew/bin/wasm-ld' : 'wasm-ld');
  const sysroot = options.sysroot || process.env.WASI_SYSROOT || (process.platform === 'darwin' ? '/opt/homebrew/share/wasi-sysroot' : '/usr/share/wasi-sysroot');
  const emccBin = options.emccBin || process.env.EMCC_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/bin/emcc') ? '/opt/homebrew/bin/emcc' : 'emcc');

  return {
    name: 'vite-plugin-nimts',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async resolveId(source, importer) {
      if (source.endsWith('.nim')) {
        const resolution = path.isAbsolute(source)
          ? source
          : path.resolve(importer ? path.dirname(importer) : config.root, source);
        return resolution;
      }
      return null;
    },

    async load(id) {
      if (!id.endsWith('.nim')) return null;

      const nimFilePath = id;
      const fileDir = path.dirname(nimFilePath);
      const baseName = path.basename(nimFilePath, '.nim');
      const cacheDir = path.resolve(config.root || '.', '.nimts-cache', `${baseName}-${backend}`);
      await fs.mkdir(cacheDir, { recursive: true });

      const wasmOutPath = path.resolve(cacheDir, `${baseName}.wasm`);
      const dtsOutPath = path.resolve(cacheDir, `${baseName}.d.ts`);
      const jsOutPath = path.resolve(cacheDir, `${baseName}.js`);

      // Check cache / freshness
      let needBuild = true;
      try {
        const [nimStat, wasmStat] = await Promise.all([
          fs.stat(nimFilePath),
          fs.stat(wasmOutPath)
        ]);
        if (wasmStat.mtimeMs > nimStat.mtimeMs) {
          needBuild = false;
        }
      } catch (_) {
        needBuild = true;
      }

      if (needBuild) {
        // Preflight toolchain diagnostic check
        try {
          await execFileAsync(nimBin, ['--version']);
        } catch (err: any) {
          throw new Error(`nimts: Nim compiler not found at "${nimBin}". Please install Nim or specify options.nimBin.\nDetails: ${err?.message || err}`);
        }

        if (backend === 'emscripten') {
          try {
            await execFileAsync(emccBin, ['--version']);
          } catch (err: any) {
            throw new Error(`nimts: emcc (Emscripten compiler) not found at "${emccBin}". To use backend: 'emscripten', install Emscripten SDK (emsdk) or specify options.emccBin.\nDetails: ${err?.message || err}`);
          }
        } else {
          try {
            await execFileAsync(clangBin, ['--version']);
          } catch (err: any) {
            throw new Error(`nimts: Clang / LLVM not found at "${clangBin}". Please install LLVM (brew install llvm on macOS, apt-get install clang on Linux) or specify options.clangBin.\nDetails: ${err?.message || err}`);
          }
          try {
            await execFileAsync(wasmldBin, ['--version']);
          } catch (err: any) {
            throw new Error(`nimts: wasm-ld linker not found at "${wasmldBin}". Please install lld (brew install llvm or brew install lld) or specify options.wasmldBin.\nDetails: ${err?.message || err}`);
          }
          try {
            await fs.access(sysroot);
          } catch (_) {
            throw new Error(`nimts: WASI sysroot not found at "${sysroot}". Please install wasi-libc (brew install wasi-libc on macOS, apt-get install wasi-libc on Linux) or specify options.sysroot.`);
          }
        }

        // Compile Nim to C
        const nimcacheDir = path.resolve(cacheDir, 'nimcache');
        await fs.mkdir(nimcacheDir, { recursive: true });

        const nimArgs = [
          'c',
          '-c',
          '-d:emscripten',
          '-d:release',
          '--opt:speed',
          '--cpu:wasm32',
          `-p:${path.resolve(__dirname, '../src')}`,
          `--nimcache:${nimcacheDir}`,
          ...(options.extraNimFlags || []),
          nimFilePath
        ];

        await execFileAsync(nimBin, nimArgs);

        // Detect Nim lib directory for headers (nimbase.h)
        let nimLib = options.nimLib || process.env.NIM_LIB;
        if (!nimLib) {
          try {
            const { stdout, stderr } = await execFileAsync(nimBin, ['dump']);
            const dumpOutput = (stdout || '') + '\n' + (stderr || '');
            const match = dumpOutput.split('\n').map(l => l.trim()).find(l => l.endsWith('/lib') || l.endsWith('\\lib') || l === 'lib');
            if (match) nimLib = match;
          } catch (_) {}
        }
        const includeFlags = nimLib ? [`-I${nimLib}`] : [];

        const publicWasmDir = path.resolve(config.root || '.', options.publicDir || 'public/wasm');
        await fs.mkdir(publicWasmDir, { recursive: true });

        if (backend === 'emscripten') {
          const emccOutJs = path.resolve(cacheDir, `${baseName}.emscripten.js`);
          const cFiles = (await fs.readdir(nimcacheDir)).filter(f => f.endsWith('.c'));
          const emccArgs = [
            '-O3',
            '-sEXPORT_ALL=1',
            '-sMODULARIZE=1',
            '-sEXPORT_ES6=1',
            '-sALLOW_MEMORY_GROWTH=1',
            '-sFORCE_FILESYSTEM=1',
            ...includeFlags,
            ...(options.emccFlags || []),
            '-o', emccOutJs,
            ...cFiles.map(f => path.resolve(nimcacheDir, f))
          ];
          await execFileAsync(emccBin, emccArgs);

          const emccWasm = path.resolve(cacheDir, `${baseName}.emscripten.wasm`);
          try {
            await fs.copyFile(emccWasm, wasmOutPath);
            await fs.copyFile(emccWasm, path.resolve(publicWasmDir, `${baseName}.wasm`));
          } catch (_) {}
        } else {
          // Compile generated C files to wasm objects
          const cFiles = (await fs.readdir(nimcacheDir)).filter(f => f.endsWith('.c'));
          const objFiles: string[] = [];

          for (const cFile of cFiles) {
            const cPath = path.resolve(nimcacheDir, cFile);
            const objPath = path.resolve(nimcacheDir, `${cFile}.o`);
            objFiles.push(objPath);

            await execFileAsync(clangBin, [
              '--target=wasm32-wasip1',
              `--sysroot=${sysroot}`,
              '-D_WASI_EMULATED_MMAN',
              '-D_WASI_EMULATED_SIGNAL',
              '-O3',
              '-flto',
              '-mbulk-memory',
              ...includeFlags,
              '-c',
              '-o', objPath,
              cPath
            ]);
          }

          // Compile builtins_wasm.c if available
          const builtinsPath = path.resolve(__dirname, '../c_src/builtins_wasm.c');
          try {
            await fs.access(builtinsPath);
            const builtinsObj = path.resolve(nimcacheDir, 'builtins_wasm.o');
            await execFileAsync(clangBin, [
              '--target=wasm32-wasip1',
              `--sysroot=${sysroot}`,
              '-O3',
              '-flto',
              '-mbulk-memory',
              '-c',
              '-o', builtinsObj,
              builtinsPath
            ]);
            objFiles.push(builtinsObj);
          } catch (_) {
            // builtins_wasm.c optional if sysroot provides compiler-rt
          }

          // Link with wasm-ld
          await execFileAsync(wasmldBin, [
            '--no-entry',
            '--export-all',
            '--allow-undefined',
            '--lto-O3',
            '--export=NimMain',
            '--export=nimts_init',
            `-L${sysroot}/lib/wasm32-wasip1`,
            '-lc',
            '-lwasi-emulated-mman',
            '-lwasi-emulated-signal',
            '-o', wasmOutPath,
            ...objFiles
          ]);

          // Copy wasm to public/wasm for browser dev server
          await fs.copyFile(wasmOutPath, path.resolve(publicWasmDir, `${baseName}.wasm`));
        }
      }

      // Read generated JS glue code
      let jsContent = '';
      try {
        jsContent = await fs.readFile(jsOutPath, 'utf-8');
      } catch (_) {
        try {
          const fileDirJs = path.resolve(fileDir, `${baseName}.js`);
          jsContent = await fs.readFile(fileDirJs, 'utf-8');
        } catch (__) {
          // Fallback default JS glue if static emit was not called
          if (backend === 'emscripten') {
            jsContent = `
import createModule from './${baseName}.emscripten.js';
import { NimTsRuntime } from 'nimts/runtime';
const runtime = new NimTsRuntime();
export async function initNimTs(opts = {}) {
  const emModule = await createModule(opts);
  return emModule;
}
export { createModule, runtime };
`;
          } else {
            jsContent = `
import { NimTsRuntime } from 'nimts/runtime';
const runtime = new NimTsRuntime();
export async function initNimTs(opts = {}) {
  await runtime.init({ wasmPath: '/wasm/${baseName}.wasm', ...opts });
  return runtime.exports;
}
export { runtime };
`;
          }
        }
      }

      return {
        code: jsContent,
        map: null
      };
    },

    handleHotUpdate({ file, server }) {
      if (file.endsWith('.nim')) {
        server.ws.send({
          type: 'full-reload',
          path: '*'
        });
      }
    }
  };
}

export default nimtsPlugin;
