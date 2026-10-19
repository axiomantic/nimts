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
  nimFlags?: string[];
  nimPaths?: string[];
  clangFlags?: string[];
  linkerFlags?: string[];
  cwd?: string;
  watchGlobs?: string[];
  outDir?: string;
  publicDir?: string;
  backend?: 'standalone' | 'emscripten';
  emccBin?: string;
  emccFlags?: string[];
}

/**
 * Recursively scans a .nim file for imports and includes to find all transitive local .nim dependencies.
 */
export async function scanTransitiveNimDeps(
  entryFile: string,
  searchPaths: string[],
  visited = new Set<string>()
): Promise<string[]> {
  const normEntry = path.resolve(entryFile);
  if (visited.has(normEntry)) return [];
  visited.add(normEntry);

  let content = '';
  try {
    content = await fs.readFile(normEntry, 'utf-8');
  } catch (_) {
    return [];
  }

  const dir = path.dirname(normEntry);
  const effectiveSearchPaths = [dir, ...searchPaths];
  const deps: string[] = [];

  const lines = content.split('\n');
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#')) continue;

    const targets: string[] = [];

    if (line.startsWith('import ') || line.startsWith('include ')) {
      const rest = line.replace(/^(import|include)\s+/, '');
      const tokens = rest.split(',').map(t => t.trim());
      for (const tok of tokens) {
        let cleanTok = tok.split(/\s+/)[0];
        cleanTok = cleanTok.replace(/^["']|["']$/g, '');
        if (cleanTok && !cleanTok.startsWith('std/') && cleanTok !== 'nimts') {
          targets.push(cleanTok);
        }
      }
    } else if (line.startsWith('from ')) {
      const rest = line.slice(5).trim();
      const mod = rest.split(/\s+/)[0];
      const cleanTok = mod.replace(/^["']|["']$/g, '');
      if (cleanTok && !cleanTok.startsWith('std/') && cleanTok !== 'nimts') {
        targets.push(cleanTok);
      }
    }

    for (const target of targets) {
      for (const sp of effectiveSearchPaths) {
        const candidate = path.resolve(sp, target.endsWith('.nim') ? target : `${target}.nim`);
        if (candidate === normEntry) continue;
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) {
            if (!visited.has(candidate)) {
              deps.push(candidate);
              const subDeps = await scanTransitiveNimDeps(candidate, searchPaths, visited);
              deps.push(...subDeps);
            }
            break;
          }
        } catch (_) {}
      }
    }
  }

  return Array.from(new Set(deps));
}

/**
 * Checks if a file path matches any watch glob patterns.
 */
export function matchesWatchGlobs(file: string, globs?: string[], cwd: string = process.cwd()): boolean {
  if (!globs || globs.length === 0) return false;
  for (const pattern of globs) {
    const fullPattern = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
    if (pattern.includes('*')) {
      let s = fullPattern;
      s = s.replace(/\/\*\*\//g, '__GLOB_PATH_SEP__');
      s = s.replace(/\/\*\*$/g, '__GLOB_GLOB_END__');
      s = s.replace(/^\*\*\//g, '__GLOB_GLOB_START__');
      s = s.replace(/\*\*/g, '__GLOB_GLOB__');
      s = s.replace(/\*/g, '__GLOB_STAR__');

      s = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      s = s.replace(/__GLOB_PATH_SEP__/g, '/(?:.+/)?');
      s = s.replace(/__GLOB_GLOB_END__/g, '(?:/.*)?');
      s = s.replace(/__GLOB_GLOB_START__/g, '(?:.+/)?');
      s = s.replace(/__GLOB_GLOB__/g, '.*');
      s = s.replace(/__GLOB_STAR__/g, '[^/]*');

      const re = new RegExp('^' + s + '$');
      if (re.test(file)) return true;
    } else if (file === fullPattern || file.startsWith(fullPattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves all symbols to export from _nimts_exports.json manifest or nimcache discovery.
 */
export async function resolveExportSymbols(
  cacheDir: string,
  nimcacheDir: string,
  fileDir: string,
  baseName: string,
  root: string
): Promise<string[]> {
  const candidateManifests = [
    path.resolve(cacheDir, '_nimts_exports.json'),
    path.resolve(cacheDir, `${baseName}_nimts_exports.json`),
    path.resolve(nimcacheDir, '_nimts_exports.json'),
    path.resolve(nimcacheDir, `${baseName}_nimts_exports.json`),
    path.resolve(fileDir, '_nimts_exports.json'),
    path.resolve(fileDir, `${baseName}_nimts_exports.json`),
    path.resolve(root, '_nimts_exports.json')
  ];

  for (const manifestPath of candidateManifests) {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const symbols: string[] = [];
      if (Array.isArray(parsed)) {
        symbols.push(...parsed.filter((s: any): s is string => typeof s === 'string'));
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.symbols)) {
          symbols.push(...parsed.symbols.filter((s: any): s is string => typeof s === 'string'));
        } else if (Array.isArray(parsed.exports)) {
          symbols.push(...parsed.exports.filter((s: any): s is string => typeof s === 'string'));
        } else {
          for (const k of Object.keys(parsed)) {
            if (typeof k === 'string' && k.length > 0) symbols.push(k);
          }
        }
      }
      if (symbols.length > 0) {
        return Array.from(new Set(symbols));
      }
    } catch (_) {}
  }

  // Auto-discover exported symbols from nimcache C files if manifest not found
  const discovered = new Set<string>([
    'NimMain',
    'nimts_init',
    'nimts_alloc',
    'nimts_free',
    'nimts_alloc_aligned',
    'nimts_free_aligned',
    'nimts_get_last_result_ptr',
    'nimts_get_last_result_len',
    'nimts_get_last_error_ptr',
    'nimts_get_last_error_len',
    'nimts_destroy_handle',
    'nimts_resume_future',
    'nimts_resume_future_error',
    'nimts_iter_step',
    'nimts_iter_finished',
    'nimts_iter_dispose',
    'nimts_chan_is_closed',
    'nimts_chan_try_recv',
    'nimts_chan_read',
    'nimts_chan_close',
    'nimts_chan_send',
    'nimts_chan_get_raw_ptrs'
  ]);

  try {
    const cFiles = (await fs.readdir(nimcacheDir)).filter(f => f.endsWith('.c'));
    for (const cFile of cFiles) {
      const content = await fs.readFile(path.resolve(nimcacheDir, cFile), 'utf-8');
      const matches = content.matchAll(/\b(nimts_[a-zA-Z0-9_]+)\b/g);
      for (const m of matches) {
        discovered.add(m[1]);
      }
    }
  } catch (_) {}

  const discoveredList = Array.from(discovered);
  try {
    await fs.writeFile(
      path.resolve(cacheDir, '_nimts_exports.json'),
      JSON.stringify({ symbols: discoveredList }, null, 2),
      'utf-8'
    );
  } catch (_) {}

  return discoveredList;
}

export function nimtsPlugin(options: NimTsPluginOptions = {}): Plugin {
  let config: ResolvedConfig;
  const backend = options.backend || 'standalone';
  const nimBin = options.nimBin || process.env.NIM_BIN || 'nim';
  const clangBin = options.clangBin || process.env.CLANG_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin/clang' : 'clang');
  const wasmldBin = options.wasmldBin || process.env.WASM_LD_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/bin/wasm-ld') ? '/opt/homebrew/bin/wasm-ld' : 'wasm-ld');
  const sysroot = options.sysroot || process.env.WASI_SYSROOT || (process.platform === 'darwin' ? '/opt/homebrew/share/wasi-sysroot' : '/usr/share/wasi-sysroot');
  const emccBin = options.emccBin || process.env.EMCC_BIN || (process.platform === 'darwin' && path.isAbsolute('/opt/homebrew/bin/emcc') ? '/opt/homebrew/bin/emcc' : 'emcc');

  const depGraph = new Map<string, Set<string>>();

  return {
    name: 'vite-plugin-nimts',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async resolveId(source, importer) {
      const isWorker = source.endsWith('.nim?worker') || source.includes('.nim?worker');
      const cleanSource = source.replace(/\?.*$/, '');
      if (cleanSource.endsWith('.nim')) {
        const resolution = path.isAbsolute(cleanSource)
          ? cleanSource
          : path.resolve(importer ? path.dirname(importer) : (config?.root || process.cwd()), cleanSource);
        return isWorker ? `${resolution}?worker` : resolution;
      }
      return null;
    },

    async load(id) {
      const isWorker = id.endsWith('.nim?worker') || id.includes('.nim?worker');
      const cleanId = id.replace(/\?.*$/, '');
      if (!cleanId.endsWith('.nim')) return null;

      const nimFilePath = cleanId;
      const fileDir = path.dirname(nimFilePath);
      const baseName = path.basename(nimFilePath, '.nim');
      const effectiveCwd = options.cwd
        ? path.resolve(options.cwd)
        : (config?.root ? path.resolve(config.root) : process.cwd());

      const cacheDir = path.resolve(effectiveCwd, '.nimts-cache', `${baseName}-${backend}`);
      await fs.mkdir(cacheDir, { recursive: true });

      const wasmOutPath = path.resolve(cacheDir, `${baseName}.wasm`);
      const dtsOutPath = path.resolve(cacheDir, `${baseName}.d.ts`);
      const jsOutPath = path.resolve(cacheDir, `${baseName}.js`);

      // Track transitive .nim dependencies
      const searchPaths = [
        fileDir,
        effectiveCwd,
        ...(options.nimPaths || []).map(p => path.isAbsolute(p) ? p : path.resolve(effectiveCwd, p))
      ];
      const transitiveDeps = await scanTransitiveNimDeps(nimFilePath, searchPaths);

      // Register with Vite watcher if running in plugin context
      if (typeof (this as any)?.addWatchFile === 'function') {
        for (const dep of transitiveDeps) {
          (this as any).addWatchFile(dep);
        }
      }
      depGraph.set(nimFilePath, new Set(transitiveDeps));

      // Check cache / freshness against entry file AND all transitive dependencies
      let needBuild = true;
      try {
        const [wasmStat, allStats] = await Promise.all([
          fs.stat(wasmOutPath),
          Promise.all([nimFilePath, ...transitiveDeps].map(f => fs.stat(f).catch(() => null)))
        ]);
        const newestDepMtime = Math.max(...allStats.filter(Boolean).map(s => s!.mtimeMs));
        if (wasmStat.mtimeMs > newestDepMtime) {
          needBuild = false;
        }
      } catch (_) {
        needBuild = true;
      }

      if (needBuild) {
        // Preflight toolchain diagnostic check
        try {
          await execFileAsync(nimBin, ['--version'], { cwd: effectiveCwd });
        } catch (err: any) {
          throw new Error(`nimts: Nim compiler not found at "${nimBin}". Please install Nim or specify options.nimBin.\nDetails: ${err?.message || err}`);
        }

        if (backend === 'emscripten') {
          try {
            await execFileAsync(emccBin, ['--version'], { cwd: effectiveCwd });
          } catch (err: any) {
            throw new Error(`nimts: emcc (Emscripten compiler) not found at "${emccBin}". To use backend: 'emscripten', install Emscripten SDK (emsdk) or specify options.emccBin.\nDetails: ${err?.message || err}`);
          }
        } else {
          try {
            await execFileAsync(clangBin, ['--version'], { cwd: effectiveCwd });
          } catch (err: any) {
            throw new Error(`nimts: Clang / LLVM not found at "${clangBin}". Please install LLVM (brew install llvm on macOS, apt-get install clang on Linux) or specify options.clangBin.\nDetails: ${err?.message || err}`);
          }
          try {
            await execFileAsync(wasmldBin, ['--version'], { cwd: effectiveCwd });
          } catch (err: any) {
            throw new Error(`nimts: wasm-ld linker not found at "${wasmldBin}". Please install lld (brew install llvm or brew install lld) or specify options.wasmldBin.\nDetails: ${err?.message || err}`);
          }
          try {
            await fs.access(sysroot);
          } catch (_) {
            throw new Error(`nimts: WASI sysroot not found at "${sysroot}". Please install wasi-libc (brew install wasi-libc on macOS, apt-get install wasi-libc on Linux) or specify options.sysroot.`);
          }
        }

        // Format nimPaths arguments
        const nimPathArgs = (options.nimPaths || []).map(p => {
          const resolved = path.isAbsolute(p) ? p : path.resolve(effectiveCwd, p);
          return `--path:${resolved}`;
        });

        // Combine nimFlags and extraNimFlags
        const userNimFlags = [
          ...(options.nimFlags || []),
          ...(options.extraNimFlags || [])
        ];

        // Compile Nim to C
        const nimcacheDir = path.resolve(cacheDir, 'nimcache');
        await fs.mkdir(nimcacheDir, { recursive: true });

        const nimArgs = [
          'c',
          '-c',
          '-d:emscripten',
          '-d:useMalloc',
          '-d:release',
          '--opt:speed',
          '--cpu:wasm32',
          '--noMain:on',
          `-p:${path.resolve(__dirname, '../src')}`,
          ...nimPathArgs,
          `--nimcache:${nimcacheDir}`,
          ...userNimFlags,
          nimFilePath
        ];

        await execFileAsync(nimBin, nimArgs, { cwd: effectiveCwd });

        // Detect Nim lib directory for headers (nimbase.h)
        let nimLib = options.nimLib || process.env.NIM_LIB;
        if (!nimLib) {
          try {
            const { stdout, stderr } = await execFileAsync(nimBin, ['dump'], { cwd: effectiveCwd });
            const dumpOutput = (stdout || '') + '\n' + (stderr || '');
            const match = dumpOutput.split('\n').map(l => l.trim()).find(l => l.endsWith('/lib') || l.endsWith('\\lib') || l === 'lib');
            if (match) nimLib = match;
          } catch (_) {}
        }
        const includeFlags = nimLib ? [`-I${nimLib}`] : [];

        const publicWasmDir = path.resolve(effectiveCwd, options.publicDir || 'public/wasm');
        await fs.mkdir(publicWasmDir, { recursive: true });

        // Extract export symbols from manifest or nimcache
        const exportSymbols = await resolveExportSymbols(
          cacheDir,
          nimcacheDir,
          fileDir,
          baseName,
          config?.root || effectiveCwd
        );

        if (backend === 'emscripten') {
          const emccOutJs = path.resolve(cacheDir, `${baseName}.emscripten.js`);
          const cFiles = (await fs.readdir(nimcacheDir)).filter(f => f.endsWith('.c'));

          const userClangFlags = (options.clangFlags || []).map(f => f.startsWith('--passC:') ? f.slice(8) : f);
          const userLinkerFlags = (options.linkerFlags || []).map(f => {
            let flag = f;
            if (flag.startsWith('--passL:')) flag = flag.slice(8);
            return flag;
          });

          const emccExportFlags = exportSymbols.map(sym => `-Wl,--export=${sym}`);

          const emccArgs = [
            '-O3',
            '-sEXPORT_ALL=1',
            '-sMODULARIZE=1',
            '-sEXPORT_ES6=1',
            '-sALLOW_MEMORY_GROWTH=1',
            '-sFORCE_FILESYSTEM=1',
            ...includeFlags,
            ...userClangFlags,
            ...userLinkerFlags,
            ...emccExportFlags,
            ...(options.emccFlags || []),
            '-o', emccOutJs,
            ...cFiles.map(f => path.resolve(nimcacheDir, f))
          ];
          await execFileAsync(emccBin, emccArgs, { cwd: effectiveCwd });

          const emccWasm = path.resolve(cacheDir, `${baseName}.emscripten.wasm`);
          try {
            await fs.copyFile(emccWasm, wasmOutPath);
            await fs.copyFile(emccWasm, path.resolve(publicWasmDir, `${baseName}.wasm`));
          } catch (_) {}
        } else {
          // Standalone backend: compile generated C files to wasm objects
          const cFiles = (await fs.readdir(nimcacheDir)).filter(f => f.endsWith('.c'));
          const objFiles: string[] = [];

          const userClangFlags = (options.clangFlags || []).map(f => f.startsWith('--passC:') ? f.slice(8) : f);

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
              ...userClangFlags,
              '-c',
              '-o', objPath,
              cPath
            ], { cwd: effectiveCwd });
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
              ...userClangFlags,
              '-c',
              '-o', builtinsObj,
              builtinsPath
            ], { cwd: effectiveCwd });
            objFiles.push(builtinsObj);
          } catch (_) {
            // builtins_wasm.c optional if sysroot provides compiler-rt
          }

          // Format wasm-ld export args from _nimts_exports.json manifest
          const exportArgs = exportSymbols.map(sym => `--export=${sym}`);

          // Process user linkerFlags (normalize --passL:... and -Wl,...)
          const userLinkerFlags = (options.linkerFlags || []).map(f => {
            let flag = f;
            if (flag.startsWith('--passL:')) flag = flag.slice(8);
            if (flag.startsWith('-Wl,')) flag = flag.slice(4);
            return flag;
          });

          // Link with wasm-ld
          await execFileAsync(wasmldBin, [
            '--no-entry',
            '--export-all',
            '--allow-undefined',
            '--lto-O3',
            '--initial-memory=16777216',
            '--max-memory=2147483648',
            ...exportArgs,
            `-L${sysroot}/lib/wasm32-wasip1`,
            '-lc',
            '-lwasi-emulated-mman',
            '-lwasi-emulated-signal',
            ...userLinkerFlags,
            '-o', wasmOutPath,
            ...objFiles
          ], { cwd: effectiveCwd });

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
import { NimTsRuntime } from '@axiomantic/nimts/runtime';
const runtime = new NimTsRuntime();
export async function initNimTs(opts = {}) {
  const emModule = await createModule(opts);
  return emModule;
}
export { createModule, runtime };
`;
          } else {
            jsContent = `
import { NimTsRuntime } from '@axiomantic/nimts/runtime';
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

      if (isWorker) {
        const workerGlue = `
import { spawnWorker } from '@axiomantic/nimts/worker';

export default class NimWorker {
  static spawn(options = {}) {
    return spawnWorker(new URL('./${baseName}.js', import.meta.url), {
      wasmPath: new URL('/wasm/${baseName}.wasm', import.meta.url).href,
      ...options
    });
  }
  constructor(options = {}) {
    return spawnWorker(new URL('./${baseName}.js', import.meta.url), {
      wasmPath: new URL('/wasm/${baseName}.wasm', import.meta.url).href,
      ...options
    });
  }
}

export function spawn(options = {}) {
  return spawnWorker(new URL('./${baseName}.js', import.meta.url), {
    wasmPath: new URL('/wasm/${baseName}.wasm', import.meta.url).href,
    ...options
  });
}
`;
        return {
          code: workerGlue,
          map: null
        };
      }

      return {
        code: jsContent,
        map: null
      };
    },

    handleHotUpdate({ file, server }) {
      const isNim = file.endsWith('.nim');
      const matchesGlob = matchesWatchGlobs(file, options.watchGlobs, options.cwd || config?.root);

      if (isNim || matchesGlob) {
        server.ws.send({
          type: 'full-reload',
          path: '*'
        });
      }
    }
  };
}

export default nimtsPlugin;
