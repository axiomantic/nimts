# nimts/memory.nim - Memory allocation, buffer marshaling and handle registry
# Licensed under MIT License.

import std/tables
import types

type
  HandleEntry = object
    rawPtr: pointer
    typeName: string
    destructor: proc(raw: pointer)

var
  gLastResultPtr*: pointer = nil
  gLastResultLen*: int32 = 0

  gHandleCounter: HandleId = 1
  gHandleTable = initTable[HandleId, HandleEntry]()

proc nimts_alloc*(size: int32): pointer {.exportc: "nimts_alloc", cdecl.} =
  if size <= 0: return nil
  result = alloc0(size)

proc nimts_free*(p: pointer) {.exportc: "nimts_free", cdecl.} =
  if p != nil:
    dealloc(p)

proc nimts_get_last_result_ptr*(): pointer {.exportc: "nimts_get_last_result_ptr", cdecl.} =
  gLastResultPtr

proc nimts_get_last_result_len*(): int32 {.exportc: "nimts_get_last_result_len", cdecl.} =
  gLastResultLen

proc packBuffer*(p: pointer, len: int32): uint64 {.inline.} =
  gLastResultPtr = p
  gLastResultLen = len
  let ptrVal = cast[uint32](cast[uint](p))
  let lenVal = cast[uint32](len)
  result = (uint64(lenVal) shl 32) or uint64(ptrVal)

proc allocStringResult*(s: string): uint64 =
  if s.len == 0:
    return packBuffer(nil, 0)
  let p = alloc0(s.len + 1)
  if s.len > 0:
    copyMem(p, unsafeAddr s[0], s.len)
  result = packBuffer(p, s.len.int32)

proc allocBytesResult*(bytes: openArray[byte]): uint64 =
  if bytes.len == 0:
    return packBuffer(nil, 0)
  let p = alloc0(bytes.len)
  copyMem(p, unsafeAddr bytes[0], bytes.len)
  result = packBuffer(p, bytes.len.int32)

proc readString*(p: ptr char, len: int32): string =
  if p == nil or len <= 0: return ""
  result = newString(len)
  copyMem(addr result[0], p, len)

proc readBytes*(p: ptr uint8, len: int32): seq[byte] =
  if p == nil or len <= 0: return @[]
  result = newSeq[byte](len)
  copyMem(addr result[0], p, len)

proc registerHandle*[T: ref object](obj: T): HandleId =
  if obj.isNil: return InvalidHandleId
  result = gHandleCounter
  inc gHandleCounter
  GC_ref(obj)
  let p = cast[pointer](obj)
  let tName = $typeof(T)
  gHandleTable[result] = HandleEntry(
    rawPtr: p,
    typeName: tName,
    destructor: proc(raw: pointer) =
      let typedObj = cast[T](raw)
      GC_unref(typedObj)
  )

proc getHandle*[T: ref object](h: HandleId): T =
  if h == InvalidHandleId: return nil
  if gHandleTable.hasKey(h):
    let entry = gHandleTable[h]
    let expectedName = $typeof(T)
    if entry.typeName == expectedName:
      return cast[T](entry.rawPtr)
    # Type mismatch prevents memory corruption / type confusion
    return nil
  return nil

proc getHandleTypeName*(h: HandleId): string =
  if h != InvalidHandleId and gHandleTable.hasKey(h):
    return gHandleTable[h].typeName
  return ""

proc releaseHandle*(h: HandleId) =
  if h != InvalidHandleId and gHandleTable.hasKey(h):
    let entry = gHandleTable[h]
    gHandleTable.del(h)
    if entry.destructor != nil:
      entry.destructor(entry.rawPtr)

proc nimts_destroy_handle*(h: HandleId) {.exportc: "nimts_destroy_handle", cdecl.} =
  releaseHandle(h)

proc activeHandleCount*(): int =
  gHandleTable.len
