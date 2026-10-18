# src/nimts/js_client.nim - Nim-to-JS client module for consuming NimTS WebAssembly modules from Nim JS
# Licensed under MIT License.

when not defined(js):
  {.fatal: "nimts/js_client is only available when compiling Nim to the JavaScript backend (nim js).".}

import std/asyncjs
import std/jsffi

export asyncjs
export jsffi

type
  NimTsJsModule* = ref object
    ## Client wrapper representing an initialized NimTS WebAssembly module in JavaScript.
    rawModule*: JsObject
    exports*: JsObject

converter toJsObject*(m: NimTsJsModule): JsObject =
  ## Allows transparently passing a `NimTsJsModule` to any API or function expecting a `JsObject`.
  if m == nil: jsNull else: m.exports

proc newJsObject*(): JsObject =
  ## Creates a new empty JavaScript object `{}`.
  {.emit: "`result` = {};".}

proc jsImport*(modulePath: cstring): Future[JsObject] =
  ## Dynamically imports an ES module in JavaScript (`import(modulePath)`).
  var p: Future[JsObject]
  {.emit: "`p` = import(`modulePath`);".}
  return p

proc toFuture*[T](promise: JsObject): Future[T] {.importjs: "(#)".}
  ## Converts a JavaScript Promise or Thenable `JsObject` into a typed Nim JS `Future[T]`.

proc loadNimTsModule*(modulePath: cstring, wasmPath: cstring = ""): Future[NimTsJsModule] {.async.} =
  ## Dynamically imports a compiled NimTS JavaScript glue module, initializes the WebAssembly
  ## instance via `initNimTs({ wasmPath })`, and returns a `NimTsJsModule`.
  let jsMod = await jsImport(modulePath)
  let opts = newJsObject()
  if wasmPath.len > 0:
    opts.wasmPath = wasmPath
  let exportsObj = await toFuture[JsObject](jsMod.initNimTs(opts))
  return NimTsJsModule(rawModule: jsMod, exports: exportsObj)

proc loadNimTsExports*(modulePath: cstring, wasmPath: cstring = ""): Future[JsObject] {.async.} =
  ## Convenience helper that dynamically imports a NimTS module and returns its `exports` JsObject directly.
  let client = await loadNimTsModule(modulePath, wasmPath)
  return client.exports

proc toUint8Array*(data: openArray[byte]): JsObject =
  ## Converts a Nim openArray[byte] or seq[byte] into a JavaScript `Uint8Array`.
  var arr: JsObject
  {.emit: "`arr` = new Uint8Array(`data`);".}
  return arr

proc toSeqByte*(arr: JsObject): seq[byte] =
  ## Copies elements from a JavaScript `Uint8Array` or typed array into a Nim `seq[byte]`.
  var res: seq[byte]
  var len: int
  {.emit: "`len` = `arr`.length;".}
  res = newSeq[byte](len)
  for i in 0 ..< len:
    var b: byte
    {.emit: "`b` = `arr`[`i`];".}
    res[i] = b
  return res
