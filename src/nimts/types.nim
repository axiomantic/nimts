# nimts/types.nim - Core type definitions for nimts
# Licensed under MIT License.

type
  HandleId* = int32
  PromiseId* = int32
  FutureId* = int32

  NimTsHandle*[T] = distinct HandleId
  NimTsIterator*[T] = distinct HandleId

  ClosureIterSlotBase* = ref object of RootObj
    finished*: bool
    stepProc*: proc(self: ClosureIterSlotBase): uint64 {.nimcall.}

  ClosureIterSlot*[T] = ref object of ClosureIterSlotBase
    iter*: iterator(): T {.closure.}

  NimTsBuffer* = object
    data*: ptr uint8
    len*: int32

  NimTsError* = object of CatchableError
    code*: int32

  GpuBufferSlice*[T] = object
    data*: ptr UncheckedArray[T]
    len*: int32
    byteLength*: int32
    alignment*: int32

  NimTsView*[T] = object
    data*: ptr UncheckedArray[T]
    len*: int32
    byteLength*: int32

proc `[]`*[T](v: NimTsView[T], idx: int): lent T {.inline.} =
  v.data[idx]

proc `[]=`*[T](v: NimTsView[T], idx: int, val: T) {.inline.} =
  v.data[idx] = val

proc len*[T](v: NimTsView[T]): int {.inline.} =
  v.len.int

proc rawPointer*[T](v: NimTsView[T]): pointer {.inline.} =
  cast[pointer](v.data)

proc toPointer*[T](v: NimTsView[T]): pointer {.inline.} =
  cast[pointer](v.data)

proc `==`*[T](a, b: NimTsHandle[T]): bool = a.HandleId == b.HandleId
proc `$`*[T](h: NimTsHandle[T]): string = "NimTsHandle[" & $typeof(T) & "](" & $h.HandleId & ")"

proc `==`*[T](a, b: NimTsIterator[T]): bool = a.HandleId == b.HandleId
proc `$`*[T](it: NimTsIterator[T]): string = "NimTsIterator[" & $typeof(T) & "](" & $it.HandleId & ")"

const
  InvalidHandleId*: HandleId = 0
  InvalidPromiseId*: PromiseId = 0
  InvalidFutureId*: FutureId = 0
