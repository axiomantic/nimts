// tests/test_vite_plugin.test.ts - Unit tests for Vite plugin for NimTS
// Licensed under MIT License.

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { nimtsPlugin } from '../ts/vite-plugin-nimts.js';

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
  });
});
