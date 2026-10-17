# nimts.nim - Main entry point for nimts (nimpy for TypeScript / WebAssembly)
# Licensed under MIT License.

import std/json
import nimts/types
import nimts/memory
import nimts/async_bridge
import nimts/codegen
import nimts/macros

export json
export types
export memory
export async_bridge
export codegen
export macros

when isMainModule:
  import std/os
  import std/osproc

  const Version = "0.1.0"

  proc printHelp() =
    echo "NimTS: nimpy for TypeScript & WebAssembly (v", Version, ")"
    echo ""
    echo "Usage:"
    echo "  nimts [command] [options]"
    echo ""
    echo "Commands:"
    echo "  compile <input.nim> [output.wasm]   Compile a Nim module to standalone WebAssembly"
    echo "  version, -v, --version              Display the NimTS version"
    echo "  help, -h, --help                    Display this help message"
    echo ""
    echo "For Vite applications, use 'nimts/vite' to import .nim files directly."

  let args = commandLineParams()
  if args.len == 0 or args[0] in ["-h", "--help", "help"]:
    printHelp()
  elif args[0] in ["-v", "--version", "version"]:
    echo "nimts ", Version
  elif args[0] == "compile":
    if args.len < 2:
      echo "Error: 'nimts compile' requires an input .nim file."
      echo "Usage: nimts compile <input.nim> [output.wasm]"
      quit(1)
    let inputNim = args[1]
    let outputWasm = if args.len >= 3: args[2] else: changeFileExt(inputNim, "wasm")
    let scriptPath = getAppDir() / "scripts" / "compile_wasm.sh"
    var cmd = ""
    if fileExists(scriptPath):
      cmd = quoteShell(scriptPath) & " " & quoteShell(inputNim) & " " & quoteShell(outputWasm)
    else:
      cmd = "scripts/compile_wasm.sh " & quoteShell(inputNim) & " " & quoteShell(outputWasm)
    let code = execCmd(cmd)
    quit(code)
  else:
    echo "Unknown command: ", args[0]
    printHelp()
    quit(1)

