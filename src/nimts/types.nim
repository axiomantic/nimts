# nimts/types.nim - Core type definitions for nimts
# Licensed under MIT License.

type
  HandleId* = int32
  PromiseId* = int32
  FutureId* = int32

  NimTsHandle*[T] = distinct HandleId

  NimTsBuffer* = object
    data*: ptr uint8
    len*: int32

  NimTsError* = object of CatchableError
    code*: int32

proc `==`*[T](a, b: NimTsHandle[T]): bool = a.HandleId == b.HandleId
proc `$`*[T](h: NimTsHandle[T]): string = "NimTsHandle[" & $typeof(T) & "](" & $h.HandleId & ")"

const
  InvalidHandleId*: HandleId = 0
  InvalidPromiseId*: PromiseId = 0
  InvalidFutureId*: FutureId = 0
