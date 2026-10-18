# nimts.nim - Main entry point for nimts (TypeScript / WebAssembly bridge for Nim)
# Licensed under MIT License.

import std/json
import nimts/types
import nimts/memory
import nimts/async_bridge
import nimts/channels
import nimts/codegen
import nimts/macros

export json
export types
export memory
export async_bridge
export channels
export codegen
export macros

when defined(js):
  import nimts/js_client
  export js_client

when isMainModule:
  import std/os
  import std/osproc
  import std/strutils

  const Version = "0.1.0"

  proc printHelp() =
    echo "NimTS: Seamless TypeScript & WebAssembly Bridge for Nim (v", Version, ")"
    echo ""
    echo "Usage:"
    echo "  nimts [command] [options]"
    echo ""
    echo "Commands:"
    echo "  compile <input.nim> [output.wasm] [options]   Compile a Nim module to WebAssembly"
    echo "    Options:"
    echo "      --backend:standalone                      Standalone micro-WASM via clang + wasm-ld (default)"
    echo "      --backend:emscripten                      Emscripten-powered WASM with POSIX/FS runtime"
    echo "  version, -v, --version                        Display the NimTS version"
    echo "  help, -h, --help                              Display this help message"
    echo ""
    echo "For Vite applications, use '@axiomantic/nimts/vite' to import .nim files directly."

  let args = commandLineParams()
  if args.len == 0 or args[0] in ["-h", "--help", "help"]:
    printHelp()
  elif args[0] in ["-v", "--version", "version"]:
    echo "nimts ", Version
  elif args[0] == "compile":
    var backend = "standalone"
    var positional: seq[string] = @[]
    var i = 1
    while i < args.len:
      let arg = args[i]
      if arg.startsWith("--backend:"):
        backend = arg["--backend:".len .. ^1]
      elif arg.startsWith("--backend="):
        backend = arg["--backend=".len .. ^1]
      elif arg == "--backend" and i + 1 < args.len:
        inc i
        backend = args[i]
      else:
        positional.add(arg)
      inc i

    if backend notin ["standalone", "emscripten"]:
      echo "Error: Unknown backend '", backend, "'. Supported backends are 'standalone' (default) and 'emscripten'."
      quit(1)

    if positional.len < 1:
      echo "Error: 'nimts compile' requires an input .nim file."
      echo "Usage: nimts compile <input.nim> [output.wasm] [--backend:standalone|emscripten]"
      quit(1)

    let inputNim = positional[0]
    let outputWasm = if positional.len >= 2: positional[1] else: changeFileExt(inputNim, "wasm")
    let scriptPath = getAppDir() / "scripts" / "compile_wasm.sh"
    var cmd = ""
    let backendArg = "--backend:" & backend
    if fileExists(scriptPath):
      cmd = quoteShell(scriptPath) & " " & quoteShell(backendArg) & " " & quoteShell(inputNim) & " " & quoteShell(outputWasm)
    else:
      cmd = "scripts/compile_wasm.sh " & quoteShell(backendArg) & " " & quoteShell(inputNim) & " " & quoteShell(outputWasm)
    let code = execCmd(cmd)
    quit(code)
  else:
    echo "Unknown command: ", args[0]
    printHelp()
    quit(1)


