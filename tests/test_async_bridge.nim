# tests/test_async_bridge.nim - Unit tests for Future <-> Promise bridge
# Licensed under MIT License.

import std/unittest
import std/asyncdispatch
import nimts/types
import nimts/memory
import nimts/async_bridge

var
  gResolvedPid: int32 = -1
  gResolvedVal: int32 = -1
  gResolvedStr: string = ""
  gErrMsg: string = ""
  gResolvedIsErr: bool = false

suite "NimTS Async Bridge Verification":

  test "PromiseId and FutureId allocation is monotonic":
    let p1 = nextPromiseId()
    let p2 = nextPromiseId()
    check p2 > p1

    let f1 = nextFutureId()
    let f2 = nextFutureId()
    check f2 > f1

  test "bridgeFutureToPromise resolves completed Future[int32]":
    gResolvedPid = -1
    gResolvedVal = -1
    gResolvedIsErr = true

    gMockHandler = proc(pid: int32, dataPtr: pointer, dataLen: int32, isError: bool) {.gcsafe.} =
      {.cast(gcsafe).}:
        gResolvedPid = pid
        gResolvedIsErr = isError
        if dataPtr != nil and dataLen >= sizeof(int32):
          gResolvedVal = cast[ptr int32](dataPtr)[]

    let fut = newFuture[int32]("testIntFuture")
    fut.complete(42'i32)

    let pid = bridgeFutureToPromise(fut)
    check gResolvedPid == pid.int32
    check gResolvedIsErr == false
    check gResolvedVal == 42'i32

  test "bridgeFutureToPromise resolves completed Future[string]":
    gResolvedPid = -1
    gResolvedStr = ""
    gResolvedIsErr = true

    gMockHandler = proc(pid: int32, dataPtr: pointer, dataLen: int32, isError: bool) {.gcsafe.} =
      {.cast(gcsafe).}:
        gResolvedPid = pid
        gResolvedIsErr = isError
        if dataPtr != nil and dataLen > 0:
          gResolvedStr = readString(cast[ptr char](dataPtr), dataLen)

    let fut = newFuture[string]("testStrFuture")
    fut.complete("Bridge Success")

    let pid = bridgeFutureToPromise(fut)
    check gResolvedPid == pid.int32
    check gResolvedIsErr == false
    check gResolvedStr == "Bridge Success"

  test "bridgeFutureToPromise notifies on Future failure":
    gResolvedPid = -1
    gErrMsg = ""
    gResolvedIsErr = false

    gMockHandler = proc(pid: int32, dataPtr: pointer, dataLen: int32, isError: bool) {.gcsafe.} =
      {.cast(gcsafe).}:
        gResolvedPid = pid
        gResolvedIsErr = isError
        if dataPtr != nil and dataLen > 0:
          gErrMsg = readString(cast[ptr char](dataPtr), dataLen)

    let fut = newFuture[string]("testFailFuture")
    fut.fail(newException(ValueError, "Explicit async failure"))

    let pid = bridgeFutureToPromise(fut)
    check gResolvedPid == pid.int32
    check gResolvedIsErr == true
    check gErrMsg == "Explicit async failure"

  test "registerPendingFuture and nimts_resume_future with success":
    let fid = nextFutureId()
    let fut = newFuture[string]("pendingResumed")
    registerPendingFuture(fid, fut)

    let testMsg = "Resumed from JS"
    let p = nimts_alloc(testMsg.len.int32 + 1)
    copyMem(p, unsafeAddr testMsg[0], testMsg.len)

    nimts_resume_future(fid.int32, p, testMsg.len.int32, 0'i32)
    nimts_free(p)

    check fut.finished
    check not fut.failed
    check fut.read == testMsg

  test "registerPendingFuture and nimts_resume_future with error":
    let fid = nextFutureId()
    let fut = newFuture[string]("pendingErr")
    registerPendingFuture(fid, fut)

    let errPayload = "Network error 500"
    let p = nimts_alloc(errPayload.len.int32 + 1)
    copyMem(p, unsafeAddr errPayload[0], errPayload.len)

    nimts_resume_future(fid.int32, p, errPayload.len.int32, 1'i32)
    nimts_free(p)

    check fut.finished
    check fut.failed
    expect NimTsError:
      discard fut.read
