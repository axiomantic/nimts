import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "NimTS",
  description: "Seamless TypeScript & WebAssembly Bridge for Nim",
  base: "/nimts/",
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    logo: { text: "⚡ NimTS" },
    siteTitle: "NimTS",

    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Type Mapping", link: "/guide/type-marshaling" },
      { text: "API Reference", link: "/reference/nim-api" },
      { text: "Vite Plugin", link: "/guide/vite-plugin" },
      { text: "Changelog", link: "/changelog" },
      {
        text: "v0.1.0",
        items: [
          { text: "v0.1.0 (Current Release)", link: "/" },
          { text: "Changelog & Release Notes", link: "/changelog" },
          { text: "GitHub Releases", link: "https://github.com/axiomantic/nimts/releases" },
          { text: "NPM Package", link: "https://www.npmjs.com/package/@axiomantic/nimts" },
          { text: "Nimble Directory", link: "https://nimble.directory/" }
        ]
      }
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Core Concepts", link: "/guide/non-invasive-exports" }
        ]
      },
      {
        text: "Guides",
        items: [
          { text: "Type Marshaling", link: "/guide/type-marshaling" },
          { text: "Memory, Handles & GC", link: "/guide/stateful-handles" },
          { text: "Async Future ↔ Promise", link: "/guide/async-bridge" },
          { text: "Vite Integration", link: "/guide/vite-plugin" },
          { text: "AudioWorklet & Workers", link: "/guide/audioworklet-workers" },
          { text: "WebGPU & GPU Compute", link: "/guide/webgpu-compute" },
          { text: "Dual-Tier Nim (JS + WASM)", link: "/guide/dual-tier-nim" }
        ]
      },
      {
        text: "Compilation Backends",
        items: [
          { text: "Standalone Micro-WASM (Default)", link: "/guide/backend-standalone" },
          { text: "Emscripten Runtime", link: "/guide/backend-emscripten" }
        ]
      },
      {
        text: "API Reference",
        items: [
          { text: "Nim Macro & Bridge API", link: "/reference/nim-api" },
          { text: "TypeScript Runtime API", link: "/reference/typescript-runtime" },
          { text: "CLI Reference", link: "/reference/cli" }
        ]
      },
      {
        text: "Project",
        items: [
          { text: "Changelog & Releases", link: "/changelog" }
        ]
      }
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/axiomantic/nimts" }
    ],

    search: {
      provider: "local"
    },

    editLink: {
      pattern: "https://github.com/axiomantic/nimts/edit/main/docs/:path",
      text: "Edit this page on GitHub"
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Axiomantic & Contributors"
    }
  }
});
