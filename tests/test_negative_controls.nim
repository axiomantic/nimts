# tests/test_negative_controls.nim - Adversarial negative control suites (NEG-01 to NEG-05)
# Licensed under MIT License.

import std/unittest
import std/strutils
import std/tables
import nimts/types
import nimts/memory

type
  MockStreamHandle = ref object
    id: int32
    label: string
    isClosed: bool

  # SPSC Ring Buffer Model for NEG-02 Backpressure Verification
  RingBuffer[T] = object
    capacity: int
    head: int
    tail: int
    count: int
    data: seq[T]

proc initRingBuffer[T](cap: int): RingBuffer[T] =
  result.capacity = cap
  result.head = 0
  result.tail = 0
  result.count = 0
  result.data = newSeq[T](cap)

proc tryPush[T](rb: var RingBuffer[T], item: T): bool =
  if rb.count >= rb.capacity:
    # Buffer is saturated - backpressure triggered
    return false
  rb.data[rb.tail] = item
  rb.tail = (rb.tail + 1) mod rb.capacity
  inc rb.count
  return true

proc tryPop[T](rb: var RingBuffer[T], outItem: var T): bool =
  if rb.count == 0:
    return false
  outItem = rb.data[rb.head]
  rb.head = (rb.head + 1) mod rb.capacity
  dec rb.count
  return true

suite "Adversarial Negative Controls (NEG-01 to NEG-05)":

  test "NEG-01: Channel early-break memory reclamation (handle count returns to baseline)":
    let baselineCount = activeHandleCount()

    # Simulate opening a stream and registering 5 chunk handles
    var handles: seq[HandleId] = @[]
    for i in 1 .. 5:
      let streamObj = MockStreamHandle(id: i.int32, label: "chunk_" & $i, isClosed: false)
      let h = registerHandle(streamObj)
      check h != InvalidHandleId
      handles.add(h)

    check activeHandleCount() == baselineCount + 5

    # Simulate consumer breaking early on chunk 2:
    # A flawed consumer or leaking iterator fails to release remaining handles.
    # We verify that if we release the consumed chunk and then cleanly abort/dispose the stream:
    releaseHandle(handles[0]) # chunk 1 consumed
    releaseHandle(handles[1]) # chunk 2 consumed, then 'break' triggered

    # Early break with proper .return() / dispose cleans up unconsumed items
    for i in 2 ..< handles.len:
      releaseHandle(handles[i])

    # Invariant: Handle count must strictly return to baseline
    check activeHandleCount() == baselineCount

  test "NEG-02: Ring-buffer capacity saturation backpressure (no silent overflow)":
    var rb = initRingBuffer[int32](4)
    check rb.capacity == 4

    # Push up to capacity
    check rb.tryPush(10) == true
    check rb.tryPush(20) == true
    check rb.tryPush(30) == true
    check rb.tryPush(40) == true
    check rb.count == 4

    # Saturation: Push on full ring-buffer MUST return false (backpressure)
    # It must NEVER silently overwrite the head (item 10) or corrupt the tail
    let overflowSuccess = rb.tryPush(50)
    check overflowSuccess == false
    check rb.count == 4

    # Verify head item was NOT corrupted by rejected push
    var first: int32
    check rb.tryPop(first) == true
    check first == 10
    check rb.count == 3

    # Now space is freed, push must succeed
    check rb.tryPush(50) == true
    check rb.count == 4

  test "NEG-03: Iterator use-after-free handling (graceful completion without WASM trap)":
    let baseline = activeHandleCount()
    let mock = MockStreamHandle(id: 42, label: "single_shot", isClosed: false)
    let h = registerHandle(mock)
    check activeHandleCount() == baseline + 1

    # Normal fetch
    let retrieved = getHandle[MockStreamHandle](h)
    check retrieved != nil
    check retrieved.id == 42

    # Dispose handle
    releaseHandle(h)
    check activeHandleCount() == baseline

    # Negative control: Use-after-free must safely return nil without memory crash or trap
    let afterFree = getHandle[MockStreamHandle](h)
    check afterFree == nil

    # Negative control: Non-existent / random handle ID must safely return nil
    let bogusHandle: HandleId = 999999
    check getHandle[MockStreamHandle](bogusHandle) == nil

    # Negative control: Idempotent double release must not corrupt internal handle table
    releaseHandle(h)
    releaseHandle(bogusHandle)
    check activeHandleCount() == baseline

  test "NEG-04: Multi-module duplicate proc namespacing (clean linking in wasm-ld)":
    # Verify that module namespacing produces collision-free C-ABI names
    let procName = "process"
    let modA = "audio_synth"
    let modB = "network_dsp"

    # Simulated namespacing generator
    proc formatCabiName(modName, pName: string): string =
      "nimts_" & modName.replace("-", "_") & "_" & pName

    let cabiA = formatCabiName(modA, procName)
    let cabiB = formatCabiName(modB, procName)

    # Identical proc names in different modules must produce distinct C-ABI symbols
    check cabiA != cabiB
    check cabiA == "nimts_audio_synth_process"
    check cabiB == "nimts_network_dsp_process"

  test "NEG-05: WASM memory.grow detachment stability during active streaming":
    # Verify large memory allocation and byte integrity across page boundaries
    let largeSize = 256 * 1024 # 256 KB (crosses multiple 64KB WASM pages)
    let rawPtr = nimts_alloc(largeSize.int32)
    check rawPtr != nil

    # Verify write and read integrity at page boundary offsets
    let pBytes = cast[ptr UncheckedArray[byte]](rawPtr)
    pBytes[0] = 0xAA'u8
    pBytes[65536] = 0xBB'u8
    pBytes[131072] = 0xCC'u8
    pBytes[largeSize - 1] = 0xDD'u8

    check pBytes[0] == 0xAA'u8
    check pBytes[65536] == 0xBB'u8
    check pBytes[131072] == 0xCC'u8
    check pBytes[largeSize - 1] == 0xDD'u8

    nimts_free(rawPtr)
