# Package

version       = "0.2.0"
author        = "Axiomantic"
description   = "Seamless TypeScript & WebAssembly bridge for Nim with Vite integration, sync/async loaders, and Future<->Promise bridge"
license       = "MIT"
srcDir        = "src"
bin           = @["nimts"]

# Dependencies

requires "nim >= 2.0.0"

task test, "Run all test suites":
  for file in listFiles("tests"):
    if file.endsWith(".nim"):
      exec "nim r -p:src --hints:off " & file

