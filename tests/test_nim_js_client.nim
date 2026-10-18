# tests/test_nim_js_client.nim - Integration test for Nim-to-JS client consuming NimTS WASM
# Licensed under MIT License.

when not defined(js):
  echo "[SKIP] tests/test_nim_js_client.nim requires JavaScript backend (run via npm run test:nim-js)"
else:
  import std/asyncjs
  import std/jsffi
  import ../src/nimts/js_client

  proc getPaths(): tuple[modPath: cstring, wasmPath: cstring] =
    var mPath: cstring
    var wPath: cstring
    {.emit: """
      const cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '.';
      `mPath` = cwd + '/tests/fixtures/test_module.js';
      `wPath` = cwd + '/tests/fixtures/test_module.wasm';
    """.}
    return (mPath, wPath)

  proc assertEqual[T](actual, expected: T, desc: string) =
    if actual != expected:
      echo "[FAIL] ", desc, ": expected ", expected, ", but got ", actual
      {.emit: "process.exit(1);".}
    else:
      echo "[OK] ", desc

  proc runIntegrationTests(): Future[void] {.async.} =
    echo "=== Running Nim-to-JS Client Integration Test ==="
    let (modPath, wasmPath) = getPaths()

    echo "Loading NimTS module from: ", modPath
    let client = await loadNimTsModule(modPath, wasmPath)
    echo "[OK] Module initialized"

    # Test 1: Synchronous primitive pass and return
    let sum = client.exports.addNumbers(15, 27).to(int32)
    assertEqual(sum, 42'i32, "addNumbers(15, 27)")

    # Test 2: Synchronous string marshaling
    let greeting = client.exports.greet(cstring("Nim JS Client")).to(cstring)
    assertEqual($greeting, "Hello, Nim JS Client!", "greet('Nim JS Client')")

    # Test 3: Byte buffer marshaling (Uint8Array <-> seq[byte])
    let inputBytes: seq[byte] = @[10'u8, 20'u8, 30'u8, 40'u8]
    let jsInput = toUint8Array(inputBytes)
    let jsOutput = client.exports.checksumBytes(jsInput)
    let outputBytes = toSeqByte(jsOutput)
    assertEqual(outputBytes.len, 4, "checksumBytes length")
    assertEqual(outputBytes[0], 10'u8 xor 0xFF'u8, "checksumBytes[0]")
    assertEqual(outputBytes[1], 20'u8 xor 0xFF'u8, "checksumBytes[1]")
    assertEqual(outputBytes[2], 30'u8 xor 0xFF'u8, "checksumBytes[2]")
    assertEqual(outputBytes[3], 40'u8 xor 0xFF'u8, "checksumBytes[3]")

    # Test 4: Asynchronous Future bridging
    let asyncSum = await toFuture[int32](client.exports.asyncAdd(100, 250))
    assertEqual(asyncSum, 350'i32, "asyncAdd(100, 250)")

    let asyncEcho = await toFuture[cstring](client.exports.asyncEcho(cstring("Client Test")))
    assertEqual($asyncEcho, "Async: Client Test", "asyncEcho('Client Test')")

    # Test 5: loadNimTsExports convenience helper
    let directExports = await loadNimTsExports(modPath, wasmPath)
    let directSum = directExports.addNumbers(50, 50).to(int32)
    assertEqual(directSum, 100'i32, "directExports.addNumbers(50, 50)")

    echo "=== All Nim-to-JS Client Integration Tests Passed! ==="

  discard runIntegrationTests()
