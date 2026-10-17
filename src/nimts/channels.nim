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

type
  RawByteChannel = NimTsChannel[seq[byte]]

var
  gRawChannels = initTable[int32, RawByteChannel]()
  gChanCounter: int32 = 1

proc nimts_chan_create*(capacity: int32 = DefaultChannelCapacity.int32): int32 {.exportc: "nimts_chan_create", cdecl.} =
  let id = gChanCounter
  inc gChanCounter
  let chan = newNimTsChannel[seq[byte]](DefaultChannelCapacity)
  gRawChannels[id] = chan
  return id

proc nimts_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_chan_send", cdecl.} =
  if not gRawChannels.hasKey(chanId): return -1
  let chan = gRawChannels[chanId]
  if chan.isClosed(): return -1
  var bytes = newSeq[byte](dataLen)
  if dataLen > 0 and dataPtr != nil:
    copyMem(addr bytes[0], dataPtr, dataLen)
  if chan.trySend(bytes):
    return 1
  return 0 # full

proc nimts_chan_try_recv*(chanId: int32, outPtr: ptr pointer, outLen: ptr int32): int32 {.exportc: "nimts_chan_try_recv", cdecl.} =
  if not gRawChannels.hasKey(chanId): return -1
  let chan = gRawChannels[chanId]
  var bytes: seq[byte]
  if chan.tryRecv(bytes):
    if bytes.len > 0:
      let p = nimts_alloc(bytes.len.int32)
      copyMem(p, addr bytes[0], bytes.len)
      if outPtr != nil: outPtr[] = p
      if outLen != nil: outLen[] = bytes.len.int32
    else:
      if outPtr != nil: outPtr[] = nil
      if outLen != nil: outLen[] = 0
    return 1
  if chan.isClosed():
    return -1
  return 0 # empty

proc nimts_chan_is_closed*(chanId: int32): int32 {.exportc: "nimts_chan_is_closed", cdecl.} =
  if not gRawChannels.hasKey(chanId): return 1
  let chan = gRawChannels[chanId]
  return if chan.isClosed(): 1 else: 0

proc nimts_chan_close*(chanId: int32) {.exportc: "nimts_chan_close", cdecl.} =
  if gRawChannels.hasKey(chanId):
    let chan = gRawChannels[chanId]
    chan.close()

proc nimts_chan_destroy*(chanId: int32) {.exportc: "nimts_chan_destroy", cdecl.} =
  if gRawChannels.hasKey(chanId):
    let chan = gRawChannels[chanId]
    chan.close()
    gRawChannels.del(chanId)

# Module-namespaced C-ABI aliases
proc nimts_core_chan_send*(chanId: int32, dataPtr: pointer, dataLen: int32): int32 {.exportc: "nimts_core_chan_send", cdecl.} =
  nimts_chan_send(chanId, dataPtr, dataLen)

proc nimts_core_chan_try_recv*(chanId: int32, outPtr: ptr pointer, outLen: ptr int32): int32 {.exportc: "nimts_core_chan_try_recv", cdecl.} =
  nimts_chan_try_recv(chanId, outPtr, outLen)

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

proc `""" & tryRecvName & """`*(chanId: int32, outPtr: ptr pointer, outLen: ptr int32): int32 {.exportc: """" & tryRecvName & """", cdecl.} =
  nimts_chan_try_recv(chanId, outPtr, outLen)

proc `""" & isClosedName & """`*(chanId: int32): int32 {.exportc: """" & isClosedName & """", cdecl.} =
  nimts_chan_is_closed(chanId)

proc `""" & closeName & """`*(chanId: int32) {.exportc: """" & closeName & """", cdecl.} =
  nimts_chan_close(chanId)
"""))
