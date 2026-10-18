# nimts/channels.nim - Lock-free SPSC channel topology for WebAssembly
# Licensed under MIT License.

import std/options
import std/tables
import std/atomics
import types
import memory

const
  DefaultChannelCapacity* = 1024

type
  NimTsChannel*[T] = ref object
    capacity*: int
    mask*: uint32
    head*: Atomic[uint32]
    tail*: Atomic[uint32]
    closed*: Atomic[bool]
    buffer*: seq[T]

  Channel*[T] = NimTsChannel[T]

proc newNimTsChannel*[T](capacity: int = DefaultChannelCapacity): NimTsChannel[T] =
  var cap = capacity
  if cap <= 0: cap = DefaultChannelCapacity
  # Ensure power of two
  if (cap and (cap - 1)) != 0:
    var p = 1
    while p < cap: p = p shl 1
    cap = p
  result = new(NimTsChannel[T])
  result.capacity = cap
  result.mask = uint32(cap - 1)
  result.buffer = newSeq[T](cap)
  result.head.store(0'u32, moRelaxed)
  result.tail.store(0'u32, moRelaxed)
  result.closed.store(false, moRelaxed)

proc newChannel*[T](capacity: int = DefaultChannelCapacity): Channel[T] =
  newNimTsChannel[T](capacity)

proc isClosed*[T](chan: NimTsChannel[T]): bool =
  if chan.isNil: return true
  result = chan.closed.load(moAcquire)

proc close*[T](chan: NimTsChannel[T]) =
  if chan.isNil: return
  chan.closed.store(true, moRelease)

proc len*[T](chan: NimTsChannel[T]): int =
  if chan.isNil: return 0
  let h = chan.head.load(moRelaxed)
  let t = chan.tail.load(moRelaxed)
  result = int(h - t)

proc isFull*[T](chan: NimTsChannel[T]): bool =
  if chan.isNil: return false
  result = chan.len >= chan.capacity

proc isEmpty*[T](chan: NimTsChannel[T]): bool =
  if chan.isNil: return true
  result = chan.len == 0

proc capacity*[T](chan: NimTsChannel[T]): int =
  if chan.isNil: 0 else: chan.capacity

proc trySend*[T](chan: NimTsChannel[T], item: sink T): bool =
  if chan.isNil or chan.isClosed(): return false
  let h = chan.head.load(moRelaxed)
  let t = chan.tail.load(moAcquire)
  if (h - t) >= uint32(chan.capacity):
    return false
  chan.buffer[h and chan.mask] = item
  chan.head.store(h + 1, moRelease)
  return true

proc send*[T](chan: NimTsChannel[T], item: sink T): bool =
  chan.trySend(item)

proc tryRecv*[T](chan: NimTsChannel[T], outVal: var T): bool =
  if chan.isNil: return false
  let t = chan.tail.load(moRelaxed)
  let h = chan.head.load(moAcquire)
  if t == h:
    return false
  outVal = move(chan.buffer[t and chan.mask])
  chan.tail.store(t + 1, moRelease)
  return true

proc recv*[T](chan: NimTsChannel[T]): Option[T] =
  var item: T
  if chan.tryRecv(item):
    return some(item)
  else:
    return none(T)

# -----------------------------------------------------------------------------
# C-ABI Handle Registry and Exports for WebAssembly / JS Bridge
# -----------------------------------------------------------------------------
# C-ABI Handle Registry and Exports for WebAssembly / JS Bridge
# -----------------------------------------------------------------------------

type
  NimTsChannelSlot* = ref object
    chanId*: int32
    chanPtr*: pointer
    tryRecvProc*: proc(chanPtr: pointer): uint64 {.nimcall.}
    trySendProc*: proc(chanPtr: pointer, dataPtr: pointer, dataLen: int32): int32 {.nimcall.}
    isClosedProc*: proc(chanPtr: pointer): bool {.nimcall.}
    closeProc*: proc(chanPtr: pointer) {.nimcall.}
    destroyProc*: proc(chanPtr: pointer) {.nimcall.}
    getRawPtrsProc*: proc(chanPtr: pointer, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32): int32 {.nimcall.}

var
  gChannelSlots = initTable[int32, NimTsChannelSlot]()
  gChanCounter: int32 = 1

proc chanGetRawPtrsHelper[T](chanPtr: pointer, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32): int32 {.nimcall.} =
  if chanPtr == nil: return -1
  let chan = cast[NimTsChannel[T]](chanPtr)
  if headPtr != nil:
    headPtr[] = cast[pointer](addr chan.head)
  if tailPtr != nil:
    tailPtr[] = cast[pointer](addr chan.tail)
  if capPtr != nil:
    capPtr[] = chan.capacity.int32
  if bufPtr != nil:
    if chan.buffer.len > 0:
      bufPtr[] = cast[pointer](addr chan.buffer[0])
    else:
      bufPtr[] = nil
  return 0

proc chanTryRecvHelper[T](chanPtr: pointer): uint64 {.nimcall.} =
  if chanPtr == nil: return 0'u64
  let chan = cast[NimTsChannel[T]](chanPtr)
  var item: T
  if chan.tryRecv(item):
    when T is (SomeInteger or SomeFloat or bool or char):
      return allocPrimitiveResult(item)
    elif T is string:
      return allocStringResult(item)
    elif T is (seq[byte] or seq[uint8]):
      return allocBytesResult(item)
    elif T is ref object:
      let h = registerHandle(item)
      return allocPrimitiveResult(h)
    else:
      return allocStringResult($(%*(item)))
  return 0'u64

proc chanTrySendHelper[T](chanPtr: pointer, dataPtr: pointer, dataLen: int32): int32 {.nimcall.} =
  if chanPtr == nil: return -1
  let chan = cast[NimTsChannel[T]](chanPtr)
  if chan.isClosed(): return -1
  when T is (SomeInteger or SomeFloat or bool or char):
    if dataLen >= sizeof(T).int32 and dataPtr != nil:
      var item: T
      copyMem(addr item, dataPtr, sizeof(T))
      return if chan.trySend(item): 1 else: 0
    return 0
  elif T is string:
    let str = readString(cast[ptr char](dataPtr), dataLen)
    return if chan.trySend(str): 1 else: 0
  elif T is (seq[byte] or seq[uint8]):
    let bytes = readBytes(cast[ptr uint8](dataPtr), dataLen)
    return if chan.trySend(bytes): 1 else: 0
  else:
    return 0

proc chanIsClosedHelper[T](chanPtr: pointer): bool {.nimcall.} =
  if chanPtr == nil: return true
  let chan = cast[NimTsChannel[T]](chanPtr)
  chan.isClosed()

proc chanCloseHelper[T](chanPtr: pointer) {.nimcall.} =
  if chanPtr != nil:
    let chan = cast[NimTsChannel[T]](chanPtr)
    chan.close()

proc chanDestroyHelper[T](chanPtr: pointer) {.nimcall.} =
  if chanPtr != nil:
    let chan = cast[NimTsChannel[T]](chanPtr)
    chan.close()
    GC_unref(chan)

proc registerChannel*[T](chan: NimTsChannel[T]): int32 =
  if chan.isNil: return 0
  let id = gChanCounter
  inc gChanCounter
  GC_ref(chan)
  let slot = NimTsChannelSlot(
    chanId: id,
    chanPtr: cast[pointer](chan),
    tryRecvProc: chanTryRecvHelper[T],
    trySendProc: chanTrySendHelper[T],
    isClosedProc: chanIsClosedHelper[T],
    closeProc: chanCloseHelper[T],
    destroyProc: chanDestroyHelper[T],
    getRawPtrsProc: chanGetRawPtrsHelper[T]
  )
  gChannelSlots[id] = slot
  return id

proc nimts_chan_create*(capacity: int32 = DefaultChannelCapacity.int32): int32 {.exportc: "nimts_chan_create", cdecl.} =
  let cap = if capacity > 0: capacity.int else: DefaultChannelCapacity
  let chan = newNimTsChannel[seq[byte]](cap)
  return registerChannel(chan)

proc nimts_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_chan_send", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return -1
  let slot = gChannelSlots[chanId]
  return slot.trySendProc(slot.chanPtr, dataPtr, dataLen)

proc nimts_chan_try_recv*(chanId: int32): uint64 {.exportc: "nimts_chan_try_recv", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return 0'u64
  let slot = gChannelSlots[chanId]
  return slot.tryRecvProc(slot.chanPtr)

proc nimts_chan_is_closed*(chanId: int32): int32 {.exportc: "nimts_chan_is_closed", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return 1
  let slot = gChannelSlots[chanId]
  return if slot.isClosedProc(slot.chanPtr): 1 else: 0

proc nimts_chan_close*(chanId: int32) {.exportc: "nimts_chan_close", cdecl.} =
  if gChannelSlots.hasKey(chanId):
    let slot = gChannelSlots[chanId]
    slot.closeProc(slot.chanPtr)

proc nimts_chan_destroy*(chanId: int32) {.exportc: "nimts_chan_destroy", cdecl.} =
  if gChannelSlots.hasKey(chanId):
    let slot = gChannelSlots[chanId]
    gChannelSlots.del(chanId)
    if slot.destroyProc != nil:
      slot.destroyProc(slot.chanPtr)

proc nimts_chan_get_raw_ptrs*(chanId: int32, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32): int32 {.exportc: "nimts_chan_get_raw_ptrs", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return -1
  let slot = gChannelSlots[chanId]
  if slot.getRawPtrsProc == nil: return -1
  return slot.getRawPtrsProc(slot.chanPtr, headPtr, tailPtr, bufPtr, capPtr)

# Module-namespaced C-ABI aliases
proc nimts_core_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_core_chan_send", cdecl.} =
  nimts_chan_send(chanId, dataPtr, dataLen)

proc nimts_core_chan_try_recv*(chanId: int32): uint64 {.exportc: "nimts_core_chan_try_recv", cdecl.} =
  nimts_chan_try_recv(chanId)

proc nimts_core_chan_is_closed*(chanId: int32): int32 {.exportc: "nimts_core_chan_is_closed", cdecl.} =
  nimts_chan_is_closed(chanId)

proc nimts_core_chan_close*(chanId: int32) {.exportc: "nimts_core_chan_close", cdecl.} =
  nimts_chan_close(chanId)

proc nimts_core_chan_get_raw_ptrs*(chanId: int32, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32): int32 {.exportc: "nimts_core_chan_get_raw_ptrs", cdecl.} =
  nimts_chan_get_raw_ptrs(chanId, headPtr, tailPtr, bufPtr, capPtr)

import std/macros

macro exportModuleChannelCabi*(moduleName: static[string]): untyped =
  ## Macro helper to export module-namespaced channel C-ABI symbols
  result = newStmtList()
  let sendName = "nimts_" & moduleName & "_chan_send"
  let tryRecvName = "nimts_" & moduleName & "_chan_try_recv"
  let isClosedName = "nimts_" & moduleName & "_chan_is_closed"
  let closeName = "nimts_" & moduleName & "_chan_close"
  let getRawPtrsName = "nimts_" & moduleName & "_chan_get_raw_ptrs"
  result.add(parseStmt("""
proc `""" & sendName & """`*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: """" & sendName & """", cdecl.} =
  nimts_chan_send(chanId, dataPtr, dataLen)

proc `""" & tryRecvName & """`*(chanId: int32): uint64 {.exportc: """" & tryRecvName & """", cdecl.} =
  nimts_chan_try_recv(chanId)

proc `""" & isClosedName & """`*(chanId: int32): int32 {.exportc: """" & isClosedName & """", cdecl.} =
  nimts_chan_is_closed(chanId)

proc `""" & closeName & """`*(chanId: int32) {.exportc: """" & closeName & """", cdecl.} =
  nimts_chan_close(chanId)

proc `""" & getRawPtrsName & """`*(chanId: int32, headPtr: ptr pointer, tailPtr: ptr pointer, bufPtr: ptr pointer, capPtr: ptr int32): int32 {.exportc: """" & getRawPtrsName & """", cdecl.} =
  nimts_chan_get_raw_ptrs(chanId, headPtr, tailPtr, bufPtr, capPtr)
"""))
