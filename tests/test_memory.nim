# tests/test_memory.nim - Unit tests for memory allocation, buffers, and handle registry
# Licensed under MIT License.

import std/unittest
import nimts/types
import nimts/memory

type
  TestWidget = ref object
    id: int32
    name: string

suite "NimTS Memory and Handle Management":

  test "nimts_alloc and nimts_free handle valid and edge-case sizes":
    let nilPtr = nimts_alloc(0)
    check nilPtr == nil

    let negPtr = nimts_alloc(-10)
    check negPtr == nil

    let validPtr = nimts_alloc(64)
    check validPtr != nil
    nimts_free(validPtr)

    # Freeing nil should be a safe no-op
    nimts_free(nil)

  test "packBuffer, allocStringResult, and readString":
    let str = "Hello WebAssembly World! 🚀"
    let packed = allocStringResult(str)
    check packed != 0'u64

    let ptrVal = gLastResultPtr
    let lenVal = gLastResultLen
    check lenVal == str.len.int32

    let reconstructed = readString(cast[ptr char](ptrVal), lenVal)
    check reconstructed == str
    nimts_free(ptrVal)

    # Empty string handling
    let emptyPacked = allocStringResult("")
    check emptyPacked == 0'u64
    check readString(nil, 0) == ""

  test "allocBytesResult and readBytes":
    let raw: seq[byte] = @[0xDE'u8, 0xAD'u8, 0xBE'u8, 0xEF'u8]
    let packed = allocBytesResult(raw)
    check packed != 0'u64

    let ptrVal = gLastResultPtr
    let lenVal = gLastResultLen
    check lenVal == 4

    let reconstructed = readBytes(cast[ptr uint8](ptrVal), lenVal)
    check reconstructed == raw
    nimts_free(ptrVal)

    # Empty bytes handling
    let emptyPacked = allocBytesResult(@[])
    check emptyPacked == 0'u64
    check readBytes(nil, 0).len == 0

  test "Handle registration, retrieval, and deterministic release":
    let initialCount = activeHandleCount()

    let w1 = TestWidget(id: 101, name: "Oscillator")
    let w2 = TestWidget(id: 202, name: "Filter")

    let h1 = registerHandle(w1)
    let h2 = registerHandle(w2)

    check h1 != InvalidHandleId
    check h2 != InvalidHandleId
    check h1 != h2
    check activeHandleCount() == initialCount + 2

    let retrieved1 = getHandle[TestWidget](h1)
    let retrieved2 = getHandle[TestWidget](h2)

    check retrieved1 != nil
    check retrieved1.id == 101
    check retrieved1.name == "Oscillator"

    check retrieved2 != nil
    check retrieved2.id == 202
    check retrieved2.name == "Filter"

    # Releasing h1
    releaseHandle(h1)
    check activeHandleCount() == initialCount + 1
    check getHandle[TestWidget](h1) == nil

    # h2 is still valid
    check getHandle[TestWidget](h2) != nil

    # Releasing h2
    releaseHandle(h2)
    check activeHandleCount() == initialCount
    check getHandle[TestWidget](h2) == nil

    # Double release or invalid release is a safe no-op
    releaseHandle(h1)
    releaseHandle(InvalidHandleId)
    check activeHandleCount() == initialCount

  test "Registering nil object returns InvalidHandleId":
    let nilWidget: TestWidget = nil
    let h = registerHandle(nilWidget)
    check h == InvalidHandleId
    check getHandle[TestWidget](InvalidHandleId) == nil

  test "Handle type mismatch prevention (type safety)":
    type OtherType = ref object
      val: int

    let w = TestWidget(id: 42, name: "Gadget")
    let h = registerHandle(w)
    check getHandleTypeName(h) == "TestWidget"

    # Querying with correct type succeeds
    check getHandle[TestWidget](h) != nil

    # Querying with mismatched type safely returns nil instead of corrupting memory
    check getHandle[OtherType](h) == nil

    releaseHandle(h)

  test "Closure iterator slot allocation, stepping, and deterministic teardown":
    let initialCount = activeHandleCount()

    let it = iterator(): int32 {.closure.} =
      yield 100
      yield 200
      yield 300

    let iterHandle = newNimTsIterator[int32](it)
    let hid = iterHandle.HandleId
    check hid != InvalidHandleId
    check activeHandleCount() == initialCount + 1
    check nimts_iter_finished(hid) == 0

    # Step 1
    let p1 = nimts_iter_next(hid)
    check p1 != 0'u64
    let ptrVal1 = cast[ptr int32](gLastResultPtr)
    check ptrVal1[] == 100
    nimts_free(gLastResultPtr)

    # Step 2
    let p2 = nimts_iter_next(hid)
    check p2 != 0'u64
    let ptrVal2 = cast[ptr int32](gLastResultPtr)
    check ptrVal2[] == 200
    nimts_free(gLastResultPtr)

    # Step 3
    let p3 = nimts_iter_next(hid)
    check p3 != 0'u64
    let ptrVal3 = cast[ptr int32](gLastResultPtr)
    check ptrVal3[] == 300
    nimts_free(gLastResultPtr)

    # Step 4: Finished
    let p4 = nimts_iter_next(hid)
    check p4 == 0'u64
    check nimts_iter_finished(hid) == 1
    # Auto-released on completion
    check activeHandleCount() == initialCount

  test "Closure iterator early disposal and NEG-03 safe use-after-free":
    let initialCount = activeHandleCount()

    let it = iterator(): string {.closure.} =
      yield "one"
      yield "two"
      yield "three"

    let iterHandle = newNimTsIterator[string](it)
    let hid = iterHandle.HandleId
    check activeHandleCount() == initialCount + 1

    # Read first element
    let p1 = nimts_iter_next(hid)
    check p1 != 0'u64
    let s1 = readString(cast[ptr char](gLastResultPtr), gLastResultLen)
    check s1 == "one"
    nimts_free(gLastResultPtr)

    # Early disposal (e.g. break in loop)
    nimts_iter_dispose(hid)
    check activeHandleCount() == initialCount
    check nimts_iter_finished(hid) == 1

    # NEG-03: calling next after dispose returns 0 without crashing or memory corruption
    let pAfter = nimts_iter_next(hid)
    check pAfter == 0'u64

  test "Last error reporting C-ABI":
    check nimts_has_error() == 0
    setLastError("Sample failure")
    check nimts_has_error() == 1
    let packed = nimts_get_last_error()
    check packed != 0'u64
    let errStr = readString(cast[ptr char](gLastResultPtr), gLastResultLen)
    check errStr == "Sample failure"
    nimts_free(gLastResultPtr)
    nimts_clear_error()
    check nimts_has_error() == 0
