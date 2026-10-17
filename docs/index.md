---
layout: home

hero:
  name: "NimTS"
  text: "Seamless TypeScript & WebAssembly Bridge for Nim"
  tagline: "Zero-friction exports, non-blocking async coroutines, GC-bound stateful handles, and instant Vite integration."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/axiomantic/nimts

features:
  - icon: ⚡
    title: Non-Invasive Exports
    details: Applying {.exportts.} preserves 100% native Nim signatures. Your procedures remain callable in native CLI tools, VST/CLAP audio plugins, and native unit tests with zero overhead.
  - icon: 🔄
    title: Bidirectional Async Bridge
    details: Automatically bridges Nim Future[T] to JavaScript Promise<T> and vice-versa without blocking the single-threaded WebAssembly runtime.
  - icon: 🎛️
    title: Stateful Handles with Automatic GC
    details: Opaque type-safe handles for ref object instances with automatic JavaScript FinalizationRegistry integration and deterministic manual .dispose().
  - icon: 📦
    title: Direct Vite Plugin
    details: Import .nim files directly into your frontend code with automated on-the-fly compilation, bundle caching, and hot module reloading.
  - icon: 🎵
    title: AudioWorklet & Worker Ready
    details: Streaming instantiation, pre-compiled WebAssembly.Module cross-thread sharing, and BufferSource loaders designed for real-time audio synthesis.
  - icon: 🛡️
    title: Type-Safe Marshaling
    details: Automatic compile-time .d.ts and .js glue generation for numbers, bigints, strings, byte arrays, complex value objects, and classes.
---
