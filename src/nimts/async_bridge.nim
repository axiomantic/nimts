when defined(nimtsChronos):
  import chronos
else:
  import std/asyncdispatch

import std/tables
import std/json
import types
import memory

type
  ResumeCallback = proc(dataPtr: pointer, dataLen: int32, isError: bool)

  AnyFuture*[F] = concept f
    (f.finished is bool) or (f.completed() is bool)

template isFinishedCompat*(f: auto): bool =
  when compiles(f.finished):
    f.finished
  elif compiles(f.completed()):
    f.completed()
  else:
    false

template isFailedCompat*(f: auto): bool =
  when compiles(f.failed):
    f.failed
  elif compiles(f.failed()):
    f.failed()
  else:
    false

template readErrorMsgCompat*(f: auto): string =
  when compiles(f.readError.msg):
    if f.readError != nil: f.readError.msg else: "Unknown error"
  elif compiles(f.error.msg):
    f.error.msg
  else:
    "Async operation failed"

template readValueCompat*[T](f: auto): T =
  when compiles(f.read()):
    f.read()
  elif compiles(f.read):
    f.read
  else:
    default(T)

var
  gPromiseCounter: PromiseId = 1
  gFutureCounter: FutureId = 1

  gPendingFutures*: Table[FutureId, ResumeCallback]

when defined(wasm) or defined(emscripten) or defined(nimtsWasm):
  proc nimts_js_resolve_promise*(promiseId: int32, dataPtr: pointer, dataLen: int32) {.importc, cdecl.}
  proc nimts_js_reject_promise*(promiseId: int32, errPtr: pointer, errLen: int32) {.importc, cdecl.}
  proc nimts_js_call_async*(funcId: int32, futureId: int32, argsPtr: pointer, argsLen: int32) {.importc, cdecl.}
else:
  # Native host stubs (for running test_native without WASM JS host)
  type MockResolveHandler* = proc(promiseId: int32, dataPtr: pointer, dataLen: int32, isError: bool) {.gcsafe.}
  var gMockHandler*: MockResolveHandler = nil

  proc nimts_js_resolve_promise*(promiseId: int32, dataPtr: pointer, dataLen: int32) {.gcsafe.} =
    {.cast(gcsafe).}:
      if gMockHandler != nil:
        gMockHandler(promiseId, dataPtr, dataLen, false)

  proc nimts_js_reject_promise*(promiseId: int32, errPtr: pointer, errLen: int32) {.gcsafe.} =
    {.cast(gcsafe).}:
      if gMockHandler != nil:
        gMockHandler(promiseId, errPtr, errLen, true)

  proc nimts_js_call_async*(funcId: int32, futureId: int32, argsPtr: pointer, argsLen: int32) {.gcsafe.} =
    discard

proc nextPromiseId*(): PromiseId =
  result = gPromiseCounter
  inc gPromiseCounter

proc nextFutureId*(): FutureId =
  result = gFutureCounter
  inc gFutureCounter

proc nimts_resume_future*(futureId: int32, dataPtr: pointer, dataLen: int32, isError: int32) {.exportc: "nimts_resume_future", cdecl.} =
  let fid = futureId.FutureId
  if gPendingFutures.hasKey(fid):
    let cb = gPendingFutures[fid]
    gPendingFutures.del(fid)
    cb(dataPtr, dataLen, isError != 0)

proc bridgeAnyFutureToPromise*[F, T](fut: F): PromiseId =
  let pid = nextPromiseId()

  proc notify() {.gcsafe.} =
    if isFailedCompat(fut):
      let msg = readErrorMsgCompat(fut)
      nimts_js_reject_promise(pid.int32, cast[pointer](msg.cstring), msg.len.int32)
    else:
      when T is void:
        nimts_js_resolve_promise(pid.int32, nil, 0)
      elif T is string:
        let s = readValueCompat[string](fut)
        nimts_js_resolve_promise(pid.int32, cast[pointer](s.cstring), s.len.int32)
      elif T is seq[byte]:
        let b = readValueCompat[seq[byte]](fut)
        let p = if b.len > 0: unsafeAddr b[0] else: nil
        nimts_js_resolve_promise(pid.int32, cast[pointer](p), b.len.int32)
      elif T is int32:
        var val = readValueCompat[int32](fut)
        nimts_js_resolve_promise(pid.int32, addr val, sizeof(val).int32)
      elif T is int64:
        var val = readValueCompat[int64](fut)
        nimts_js_resolve_promise(pid.int32, addr val, sizeof(val).int32)
      elif T is bool:
        var val: int32 = if readValueCompat[bool](fut): 1 else: 0
        nimts_js_resolve_promise(pid.int32, addr val, sizeof(val).int32)
      elif T is float32:
        var val = readValueCompat[float32](fut)
        nimts_js_resolve_promise(pid.int32, addr val, sizeof(val).int32)
      elif T is float64:
        var val = readValueCompat[float64](fut)
        nimts_js_resolve_promise(pid.int32, addr val, sizeof(val).int32)
      else:
        let val = readValueCompat[T](fut)
        let jsonStr = $(%*(val))
        nimts_js_resolve_promise(pid.int32, cast[pointer](jsonStr.cstring), jsonStr.len.int32)

  if isFinishedCompat(fut):
    notify()
  else:
    when compiles(fut.addCallback(proc(f: auto) {.gcsafe.} = notify())):
      fut.addCallback(proc(f: auto) {.gcsafe.} = notify())
    elif compiles(fut.addCallback(proc(p: pointer) {.gcsafe.} = notify())):
      fut.addCallback(proc(p: pointer) {.gcsafe.} = notify())
    else:
      fut.addCallback(proc() {.gcsafe.} = notify())
  return pid

proc bridgeFutureToPromise*[T](fut: Future[T]): PromiseId =
  bridgeAnyFutureToPromise[Future[T], T](fut)

proc registerPendingFuture*[T](fid: FutureId, fut: Future[T]) =
  gPendingFutures[fid] = proc(dataPtr: pointer, dataLen: int32, isError: bool) =
    if isError:
      fut.fail(newException(NimTsError, readString(cast[ptr char](dataPtr), dataLen)))
    else:
      when T is void:
        fut.complete()
      elif T is string:
        fut.complete(readString(cast[ptr char](dataPtr), dataLen))
      elif T is seq[byte]:
        fut.complete(readBytes(cast[ptr uint8](dataPtr), dataLen))
      elif T is int32:
        if dataLen >= sizeof(int32) and dataPtr != nil:
          var val: int32
          copyMem(addr val, dataPtr, sizeof(int32))
          fut.complete(val)
        else:
          fut.complete(0)
      elif T is int64:
        if dataLen >= sizeof(int64) and dataPtr != nil:
          var val: int64
          copyMem(addr val, dataPtr, sizeof(int64))
          fut.complete(val)
        else:
          fut.complete(0'i64)
      elif T is bool:
        if dataLen >= sizeof(int32) and dataPtr != nil:
          var val: int32
          copyMem(addr val, dataPtr, sizeof(int32))
          fut.complete(val != 0)
        else:
          fut.complete(false)
      elif T is float32:
        if dataLen >= sizeof(float32) and dataPtr != nil:
          var val: float32
          copyMem(addr val, dataPtr, sizeof(float32))
          fut.complete(val)
        else:
          fut.complete(0.0'f32)
      elif T is float64:
        if dataLen >= sizeof(float64) and dataPtr != nil:
          var val: float64
          copyMem(addr val, dataPtr, sizeof(float64))
          fut.complete(val)
        else:
          fut.complete(0.0'f64)
      else:
        let s = readString(cast[ptr char](dataPtr), dataLen)
        let jsonNode = parseJson(s)
        var obj: T
        obj = to(jsonNode, T)
        fut.complete(obj)
