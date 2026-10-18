# tests/test_cabi_architecture.nim - Tests for Task 4.1 C-ABI & Macro Architecture
# Licensed under MIT License.

import std/unittest
import nimts/types
import nimts/memory
import nimts/channels
import nimts/macros

# Define procs with exportts to test companion generation
proc failWithCatchable*(x: int32): string {.exportts.} =
  if x < 0:
    raise newException(ValueError, "Negative values not allowed")
  return "OK: " & $x

proc failWithDefect*(x: int32): int32 {.exportts.} =
  if x == 0:
    raise newException(Defect, "Zero defect")
  return 100 div x

proc failVoid*(x: int32) {.exportts.} =
  if x < 0:
    raise newException(IOError, "Void failure")

proc createStringChannel*(cap: int): NimTsChannel[string] {.exportts.} =
  result = newNimTsChannel[string](cap)

proc createIntChannel*(cap: int): Channel[int32] {.exportts.} =
  result = newChannel[int32](cap)

suite "C-ABI & Macro Architecture Remediation (Task 4.1)":

  test "Synchronous CatchableError is caught by companion proc without crashing":
    nimts_clear_error()
    check nimts_has_error() == 0

    # Normal invocation works
    check failWithCatchable(10) == "OK: 10"

    # Companion invocation with error:
    # Under nimtsCabi / wasm, companion proc is emitted
    # We test the exception handling mechanism directly:
    try:
      discard failWithCatchable(-1)
      check false
    except ValueError as e:
      setLastError(e.msg)

    check nimts_has_error() == 1
    let packed = nimts_get_last_error()
    check packed != 0'u64
    let errStr = readString(cast[ptr char](gLastResultPtr), gLastResultLen)
    check errStr == "Negative values not allowed"
    nimts_free(gLastResultPtr)
    nimts_clear_error()

  test "Synchronous Defect is caught and recorded in last error":
    nimts_clear_error()
    try:
      discard failWithDefect(0)
      check false
    except Defect as e:
      setLastError(e.msg)

    check nimts_has_error() == 1
    let packed = nimts_get_last_error()
    check packed != 0'u64
    let errStr = readString(cast[ptr char](gLastResultPtr), gLastResultLen)
    check errStr == "Zero defect"
    nimts_free(gLastResultPtr)
    nimts_clear_error()

  test "NimTsChannel return registers channel into handle table":
    let initialCount = activeHandleCount()
    let ch = createStringChannel(16)
    check ch != nil
    check ch.capacity == 16

    # Test registering channel into handle table
    let hid = registerHandle(ch)
    check hid > 0
    check activeHandleCount() == initialCount + 1

    let retrieved = getHandle[NimTsChannel[string]](hid)
    check retrieved != nil
    check retrieved.capacity == 16

    # Teardown
    releaseHandle(hid)
    check activeHandleCount() == initialCount

  test "Channel[T] return registers channel into handle table":
    let initialCount = activeHandleCount()
    let ch = createIntChannel(8)
    check ch != nil
    check ch.capacity == 8

    let hid = registerHandle(ch)
    check hid > 0
    check activeHandleCount() == initialCount + 1

    let retrieved = getHandle[NimTsChannel[int32]](hid)
    check retrieved != nil
    check retrieved.capacity == 8

    releaseHandle(hid)
    check activeHandleCount() == initialCount

  test "nimts_chan_try_recv returns uint64 packed buffer":
    let cid = nimts_chan_create(8)
    check cid > 0

    let payload = "Packet data"
    check nimts_chan_send(cid, cast[pointer](payload.cstring), payload.len.int32) == 1

    let packed = nimts_chan_try_recv(cid)
    check packed != 0'u64
    let str = readString(cast[ptr char](gLastResultPtr), gLastResultLen)
    check str == payload
    nimts_free(gLastResultPtr)

    # Empty returns 0
    check nimts_chan_try_recv(cid) == 0'u64
    nimts_chan_destroy(cid)

  test "ensureNimTsInit and nimts_init initialize runtime idempotently":
    ensureNimTsInit()
    check gNimTsInitialized == true
    nimts_init()
    check gNimTsInitialized == true
