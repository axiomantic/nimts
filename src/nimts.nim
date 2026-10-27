# nimts - Seamless TypeScript & WebAssembly bridge for Nim with Vite integration, sync/async loaders, and Future<->Promise bridge

const projectVersion* = "0.0.1"

const greetingMsg* = "hello from nimts"

proc hello*(): string =
  ## Returns standard project greeting string.
  greetingMsg

proc add*(a, b: int): int {.exportc: "add", cdecl.} =
  ## Adds two integers (exported to WebAssembly).
  a + b
