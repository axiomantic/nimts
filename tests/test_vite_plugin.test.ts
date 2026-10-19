// tests/test_vite_plugin.test.ts - Unit tests for Vite plugin for NimTS
// Licensed under MIT License.

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  nimtsPlugin,
  scanTransitiveNimDeps,
  matchesWatchGlobs,
  resolveExportSymbols
} from '../ts/vite-plugin-nimts.js';

describe('Vite Plugin (vite-plugin-nimts)', () => {
  it('creates plugin with correct name and pre enforcement', () => {
    const plugin = nimtsPlugin();
    expect(plugin.name).toBe('vite-plugin-nimts');
    expect(plugin.enforce).toBe('pre');
  });

  describe('resolveId hook', () => {
    it('returns null for non-.nim files', async () => {
      const plugin = nimtsPlugin();
      // Configure resolvedConfig mock
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: '/mock/project' });
      }

      const resolve = plugin.resolveId as Function;
      const resJs = await resolve.call({}, './utils.ts', '/mock/project/src/main.ts');
      expect(resJs).toBeNull();

      const resCss = await resolve.call({}, './styles.css', '/mock/project/src/main.ts');
      expect(resCss).toBeNull();
    });

    it('resolves relative .nim import paths to absolute paths', async () => {
      const plugin = nimtsPlugin();
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: '/mock/project' });
      }

      const resolve = plugin.resolveId as Function;
      const res = await resolve.call({}, './engine.nim', '/mock/project/src/main.ts');
      expect(res).toBe(path.resolve('/mock/project/src', 'engine.nim'));
    });

    it('resolves absolute .nim paths directly', async () => {
      const plugin = nimtsPlugin();
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: '/mock/project' });
      }

      const resolve = plugin.resolveId as Function;
      const absPath = '/absolute/path/to/module.nim';
      const res = await resolve.call({}, absPath, '/mock/project/src/main.ts');
      expect(res).toBe(absPath);
    });

    it('resolves .nim?worker query to path?worker', async () => {
      const plugin = nimtsPlugin();
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: '/mock/project' });
      }

      const resolve = plugin.resolveId as Function;
      const res = await resolve.call({}, './engine.nim?worker', '/mock/project/src/main.ts');
      expect(res).toBe(path.resolve('/mock/project/src', 'engine.nim') + '?worker');
    });
  });

  describe('handleHotUpdate hook', () => {
    it('sends full-reload when a .nim file changes', () => {
      const plugin = nimtsPlugin();
      const sendMock = vi.fn();
      const serverMock = {
        ws: { send: sendMock }
      };

      const handleHotUpdate = plugin.handleHotUpdate as Function;
      handleHotUpdate.call({}, {
        file: '/path/to/dsp.nim',
        server: serverMock
      });

      expect(sendMock).toHaveBeenCalledWith({
        type: 'full-reload',
        path: '*'
      });
    });

    it('does not send full-reload when a non-.nim file changes', () => {
      const plugin = nimtsPlugin();
      const sendMock = vi.fn();
      const serverMock = {
        ws: { send: sendMock }
      };

      const handleHotUpdate = plugin.handleHotUpdate as Function;
      handleHotUpdate.call({}, {
        file: '/path/to/styles.css',
        server: serverMock
      });

      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('load hook', () => {
    it('returns null for non-.nim files', async () => {
      const plugin = nimtsPlugin();
      const load = plugin.load as Function;
      const res = await load.call({}, '/path/to/app.tsx');
      expect(res).toBeNull();
    });

    it('compiles a real .nim file to WebAssembly and returns JS glue code', async () => {
      const plugin = nimtsPlugin({
        clangBin: process.env.CLANG_BIN || '/opt/homebrew/opt/llvm/bin/clang',
        wasmldBin: process.env.WASM_LD_BIN || '/opt/homebrew/bin/wasm-ld',
        sysroot: process.env.WASI_SYSROOT || '/opt/homebrew/share/wasi-sysroot'
      });
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: path.resolve(__dirname, '..') });
      }
      const load = plugin.load as Function;
      const fixturePath = path.resolve(__dirname, 'fixtures/test_module.nim');
      const res = await load.call({}, fixturePath);

      expect(res).toBeDefined();
      expect(res.code).toBeDefined();
      expect(res.code).toContain('initNimTs');
      expect(res.code).toContain('addNumbers');
      expect(res.code).toContain('createEngine');
    }, 30000);

    it('emits instantiable NimWorker class when id contains ?worker', async () => {
      const plugin = nimtsPlugin({
        clangBin: process.env.CLANG_BIN || '/opt/homebrew/opt/llvm/bin/clang',
        wasmldBin: process.env.WASM_LD_BIN || '/opt/homebrew/bin/wasm-ld',
        sysroot: process.env.WASI_SYSROOT || '/opt/homebrew/share/wasi-sysroot'
      });
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: path.resolve(__dirname, '..') });
      }
      const load = plugin.load as Function;
      const fixturePath = path.resolve(__dirname, 'fixtures/test_module.nim') + '?worker';
      const res = await load.call({}, fixturePath);

      expect(res).toBeDefined();
      expect(res.code).toContain('spawnWorker');
      expect(res.code).toContain('class NimWorker');
      expect(res.code).toContain('export function spawn');
    });

    it('throws actionable diagnostic error when backend: emscripten is selected but emcc is missing', async () => {
      const plugin = nimtsPlugin({
        backend: 'emscripten',
        emccBin: '/path/to/nonexistent/emcc'
      });
      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: path.resolve(__dirname, '..') });
      }
      const load = plugin.load as Function;
      const fixturePath = path.resolve(__dirname, 'fixtures/test_module.nim');
      await expect(load.call({}, fixturePath)).rejects.toThrow(/emcc \(Emscripten compiler\) not found.*emsdk/);
    });
  });

  describe('Multi-Repo & Transitive Dependency Tracking (Task 8.4)', () => {
    it('scans transitive .nim imports across multiple repository directories', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimts-multirepo-'));
      const repoADir = path.join(tmpDir, 'repoA');
      const repoBDir = path.join(tmpDir, 'repoB');
      const repoCSubDir = path.join(repoBDir, 'subpkg');

      await fs.mkdir(repoADir, { recursive: true });
      await fs.mkdir(repoCSubDir, { recursive: true });

      const leafNim = path.join(repoCSubDir, 'leaf.nim');
      await fs.writeFile(leafNim, 'proc leafProc*(): int = 42\n');

      const middleNim = path.join(repoBDir, 'middle.nim');
      await fs.writeFile(middleNim, 'import std/strutils\nimport subpkg/leaf\nproc middleProc*(): int = leafProc() * 2\n');

      const entryNim = path.join(repoADir, 'entry.nim');
      await fs.writeFile(entryNim, 'import nimts\nimport middle\nproc main*(): int = middleProc()\n');

      const deps = await scanTransitiveNimDeps(entryNim, [repoADir, repoBDir]);

      expect(deps).toContain(path.resolve(middleNim));
      expect(deps).toContain(path.resolve(leafNim));
      expect(deps).not.toContain(path.resolve(entryNim));

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('handles cyclic and self imports without infinite recursion', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimts-cycle-'));
      const modA = path.join(tmpDir, 'modA.nim');
      const modB = path.join(tmpDir, 'modB.nim');

      await fs.writeFile(modA, 'import modB\nproc a*(): int = 1\n');
      await fs.writeFile(modB, 'import modA\nproc b*(): int = 2\n');

      const deps = await scanTransitiveNimDeps(modA, [tmpDir]);
      expect(deps).toContain(path.resolve(modB));
      expect(deps.length).toBe(1);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('matches watch globs correctly for HMR invalidation', () => {
      const cwd = '/workspace/project';
      expect(matchesWatchGlobs('/workspace/project/src/dsp.nim', ['src/**/*.nim'], cwd)).toBe(true);
      expect(matchesWatchGlobs('/workspace/project/sub/core.nim', ['sub/*.nim'], cwd)).toBe(true);
      expect(matchesWatchGlobs('/external/repo/lib.nim', ['/external/repo/**/*.nim'], cwd)).toBe(true);
      expect(matchesWatchGlobs('/workspace/project/src/dsp.ts', ['src/**/*.nim'], cwd)).toBe(false);
      expect(matchesWatchGlobs('/workspace/project/other/file.nim', ['src/**/*.nim'], cwd)).toBe(false);
    });

    it('triggers HMR full-reload on watchGlob matches in handleHotUpdate', () => {
      const plugin = nimtsPlugin({
        watchGlobs: ['../shared-repo/**/*.nim']
      });
      const sendMock = vi.fn();
      const serverMock = { ws: { send: sendMock } };
      const handleHotUpdate = plugin.handleHotUpdate as Function;

      handleHotUpdate.call({}, {
        file: '/Users/eek/Development/shared-repo/utils.nim',
        server: serverMock
      });

      expect(sendMock).toHaveBeenCalledWith({
        type: 'full-reload',
        path: '*'
      });
    });
  });

  describe('Manifest Symbol Discovery (_nimts_exports.json)', () => {
    it('discovers and extracts symbols from _nimts_exports.json manifest', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimts-manifest-'));
      const manifestPath = path.join(tmpDir, '_nimts_exports.json');
      await fs.writeFile(manifestPath, JSON.stringify({
        module: 'my_module',
        symbols: ['NimMain', 'nimts_init', 'nimts_mySpecialProc', 'customSymbol']
      }, null, 2));

      const symbols = await resolveExportSymbols(tmpDir, tmpDir, tmpDir, 'my_module', tmpDir);
      expect(symbols).toContain('NimMain');
      expect(symbols).toContain('nimts_init');
      expect(symbols).toContain('nimts_mySpecialProc');
      expect(symbols).toContain('customSymbol');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('auto-discovers exported symbols from nimcache C files if manifest is absent', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimts-c-discovery-'));
      const nimcacheDir = path.join(tmpDir, 'nimcache');
      await fs.mkdir(nimcacheDir, { recursive: true });

      const cFile = path.join(nimcacheDir, '@mtest.nim.c');
      await fs.writeFile(cFile, `
N_LIB_PRIVATE N_CDECL(void, nimts_computeTensor)(void) {
}
N_LIB_PRIVATE N_CDECL(int, nimts_matrixMultiply)(int a, int b) {
  return a * b;
}
`);

      const symbols = await resolveExportSymbols(tmpDir, nimcacheDir, tmpDir, 'test', tmpDir);
      expect(symbols).toContain('NimMain');
      expect(symbols).toContain('nimts_init');
      expect(symbols).toContain('nimts_computeTensor');
      expect(symbols).toContain('nimts_matrixMultiply');

      // Verify that _nimts_exports.json was written to cacheDir
      const writtenManifest = await fs.readFile(path.join(tmpDir, '_nimts_exports.json'), 'utf-8');
      const parsed = JSON.parse(writtenManifest);
      expect(parsed.symbols).toContain('nimts_computeTensor');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Multi-Repo Plugin Options (nimFlags, nimPaths, clangFlags, linkerFlags, cwd)', () => {
    it('initializes plugin with multi-repo options without error', () => {
      const plugin = nimtsPlugin({
        cwd: '/path/to/my-repo',
        nimPaths: ['/path/to/rg2/src', '../green-rabbit/src'],
        nimFlags: ['-d:release', '--threads:off'],
        clangFlags: ['-O3', '-DENABLE_SIMD=1'],
        linkerFlags: ['-Wl,--export=mySpecialCustomSymbol'],
        watchGlobs: ['../**/*.nim']
      });

      expect(plugin.name).toBe('vite-plugin-nimts');
      expect(plugin.enforce).toBe('pre');
    });

    it('compiles with multi-repo nimPaths and linkerFlags successfully', async () => {
      const plugin = nimtsPlugin({
        clangBin: process.env.CLANG_BIN || '/opt/homebrew/opt/llvm/bin/clang',
        wasmldBin: process.env.WASM_LD_BIN || '/opt/homebrew/bin/wasm-ld',
        sysroot: process.env.WASI_SYSROOT || '/opt/homebrew/share/wasi-sysroot',
        nimPaths: [path.resolve(__dirname, 'fixtures')],
        nimFlags: ['-d:release'],
        linkerFlags: ['-Wl,--export=NimMain', '--passL:-Wl,--export=nimts_init']
      });

      if (typeof plugin.configResolved === 'function') {
        (plugin.configResolved as any)({ root: path.resolve(__dirname, '..') });
      }

      const load = plugin.load as Function;
      const fixturePath = path.resolve(__dirname, 'fixtures/test_module.nim');
      const res = await load.call({}, fixturePath);

      expect(res).toBeDefined();
      expect(res.code).toContain('initNimTs');
      expect(res.code).toContain('addNumbers');
    }, 30000);
  });
});

