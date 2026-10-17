# nimts/channels.nim - Lock-free SPSC channel topology for WASM and native JS fallback
# Licensed under MIT License.

import std/options
import std/tables
import types
import memory

when not defined(js):
  import std/atomics

const
  DefaultChannelCapacity* = 1024

type
  NimTsChannel*[T] = ref object
    capacity*: int
    mask*: uint32
    when defined(js):
      head*: uint32
      tail*: uint32
      closed*: bool
    else:
      head*: Atomic[uint32]
      tail*: Atomic[uint32]
      closed*: Atomic[bool]
    buffer*: seq[T]

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
  when defined(js):
    result.head = 0
    result.tail = 0
    result.closed = false
  else:
    result.head.store(0'u32, moRelaxed)
    result.tail.store(0'u32, moRelaxed)
    result.closed.store(false, moRelaxed)

proc isClosed*[T](chan: NimTsChannel[T]): bool =
  if chan.isNil: return true
  when defined(js):
    result = chan.closed
  else:
    result = chan.closed.load(moAcquire)

proc close*[T](chan: NimTsChannel[T]) =
  if chan.isNil: return
  when defined(js):
    chan.closed = true
  else:
    chan.closed.store(true, moRelease)

proc len*[T](chan: NimTsChannel[T]): int =
  if chan.isNil: return 0
  when defined(js):
    let h = chan.head
    let t = chan.tail
  else:
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
  when defined(js):
    let h = chan.head
    let t = chan.tail
    if (h - t) >= uint32(chan.capacity):
      return false
    chan.buffer[h and chan.mask] = item
    chan.head = h + 1
    return true
  else:
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
  when defined(js):
    let t = chan.tail
    let h = chan.head
    if t == h:
      return false
    outVal = move(chan.buffer[t and chan.mask])
    chan.tail = t + 1
    return true
  else:
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
    tryRecvProc*: proc(): uint64
    trySendProc*: proc(dataPtr: pointer, dataLen: int32): int32
    isClosedProc*: proc(): bool
    closeProc*: proc()

var
  gChannelSlots = initTable[int32, NimTsChannelSlot]()
  gChanCounter: int32 = 1

proc registerChannel*[T](chan: NimTsChannel[T]): int32 =
  if chan.isNil: return 0
  let id = gChanCounter
  inc gChanCounter
  GC_ref(chan)
  let slot = NimTsChannelSlot(
    chanId: id,
    tryRecvProc: proc(): uint64 =
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
      return 0'u64,
    trySendProc: proc(dataPtr: pointer, dataLen: int32): int32 =
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
        return 0,
    isClosedProc: proc(): bool =
      chan.isClosed(),
    closeProc: proc() =
      chan.close()
  )
  gChannelSlots[id] = slot
  return id

proc nimts_chan_create*(capacity: int32 = DefaultChannelCapacity.int32): int32 {.exportc: "nimts_chan_create", cdecl.} =
  let cap = if capacity > 0: capacity.int else: DefaultChannelCapacity
  let chan = newNimTsChannel[seq[byte]](cap)
  return registerChannel(chan)

proc nimts_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_chan_send", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return -1
  return gChannelSlots[chanId].trySendProc(dataPtr, dataLen)

proc nimts_chan_try_recv*(chanId: int32): uint64 {.exportc: "nimts_chan_try_recv", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return 0'u64
  return gChannelSlots[chanId].tryRecvProc()

proc nimts_chan_is_closed*(chanId: int32): int32 {.exportc: "nimts_chan_is_closed", cdecl.} =
  if not gChannelSlots.hasKey(chanId): return 1
  return if gChannelSlots[chanId].isClosedProc(): 1 else: 0

proc nimts_chan_close*(chanId: int32) {.exportc: "nimts_chan_close", cdecl.} =
  if gChannelSlots.hasKey(chanId):
    gChannelSlots[chanId].closeProc()

proc nimts_chan_destroy*(chanId: int32) {.exportc: "nimts_chan_destroy", cdecl.} =
  if gChannelSlots.hasKey(chanId):
    gChannelSlots[chanId].closeProc()
    gChannelSlots.del(chanId)

# Module-namespaced C-ABI aliases
proc nimts_core_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_core_chan_send", cdecl.} =
  nimts_chan_send(chanId, dataPtr, dataLen)

proc nimts_core_chan_try_recv*(chanId: int32): uint64 {.exportc: "nimts_core_chan_try_recv", cdecl.} =
  nimts_chan_try_recv(chanId)

proc nimts_core_chan_is_closed*(chanId: int32): int32 {.exportc: "nimts_core_chan_is_closed", cdecl.} =
  nimts_chan_is_closed(chanId)

proc nimts_core_chan_close*(chanId: int32) {.exportc: "nimts_core_chan_close", cdecl.} =
  nimts_chan_close(chanId)

import std/macros

macro exportModuleChannelCabi*(moduleName: static[string]): untyped =
  ## Macro helper to export module-namespaced channel C-ABI symbols
  result = newStmtList()
  let sendName = "nimts_" & moduleName & "_chan_send"
  let tryRecvName = "nimts_" & moduleName & "_chan_try_recv"
  let isClosedName = "nimts_" & moduleName & "_chan_is_closed"
  let closeName = "nimts_" & moduleName & "_chan_close"
  result.add(parseStmt("""
proc `""" & sendName & """`*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: """" & sendName & """", cdecl.} =
  nimts_chan_send(chanId, dataPtr, dataLen)

proc `""" & tryRecvName & """`*(chanId: int32): uint64 {.exportc: """" & tryRecvName & """", cdecl.} =
  nimts_chan_try_recv(chanId)

proc `""" & isClosedName & """`*(chanId: int32): int32 {.exportc: """" & isClosedName & """", cdecl.} =
  nimts_chan_is_closed(chanId)

proc `""" & closeName & """`*(chanId: int32) {.exportc: """" & closeName & """", cdecl.} =
  nimts_chan_close(chanId)
"""))
