# tests/fixtures/test_module.nim - Test module for WASM compilation and TS/JS testing
# Licensed under MIT License.

import std/asyncdispatch
import nimts

type
  AudioEngine* {.exportts.} = ref object
    volume*: float32
    sampleRate*: float32

  SynthConfig* = object
    polyphony*: int32
    name*: string

proc addNumbers*(a: int32, b: int32): int32 {.exportts.} =
  a + b

proc greet*(name: string): string {.exportts.} =
  "Hello, " & name & "!"

proc checksumBytes*(data: openArray[byte]): seq[byte] {.exportts.} =
  result = newSeq[byte](data.len)
  for i in 0 ..< data.len:
    result[i] = data[i] xor 0xFF'u8

proc createEngine*(sampleRate: float32): AudioEngine {.exportts.} =
  AudioEngine(sampleRate: sampleRate, volume: 1.0'f32)

proc getEngineSampleRate*(engine: AudioEngine): float32 {.exportts.} =
  if engine == nil: return 0.0'f32
  engine.sampleRate

proc setEngineVolume*(engine: AudioEngine, vol: float32) {.exportts.} =
  if engine != nil:
    engine.volume = vol

proc getEngineVolume*(engine: AudioEngine): float32 {.exportts.} =
  if engine == nil: return 0.0'f32
  engine.volume

proc processConfig*(c: SynthConfig): SynthConfig {.exportts.} =
  result = SynthConfig(polyphony: c.polyphony * 2, name: c.name & "_processed")

proc asyncAdd*(a: int32, b: int32): Future[int32] {.async, exportts.} =
  return a + b

proc asyncEcho*(msg: string): Future[string] {.async, exportts.} =
  return "Async: " & msg

proc asyncComputeFloat*(x: float64): Future[float64] {.async, exportts.} =
  return x * 2.5

proc asyncCheckBool*(flag: bool): Future[bool] {.async, exportts.} =
  return not flag

var gLastFid: int32 = 0

proc startPendingOperation*(): Future[string] {.exportts.} =
  let fut = newFuture[string]("pendingOp")
  let fid = nextFutureId()
  gLastFid = fid.int32
  registerPendingFuture(fid, fut)
  return fut

proc getLastFutureId*(): int32 {.exportc: "nimts_getLastFutureId", cdecl.} =
  return gLastFid

proc generateFrequencies*(root: float32, count: int32): NimTsIterator[float32] {.exportts.} =
  let it = iterator(): float32 {.closure.} =
    for i in 1 .. count:
      yield root * i.float32
  return newNimTsIterator[float32](it)

proc iterateFibonacci*(n: int32): NimTsIterator[int32] {.exportts.} =
  let it = iterator(): int32 {.closure.} =
    var a = 0'i32
    var b = 1'i32
    for i in 0 ..< n:
      yield a
      let next = a + b
      a = b
      b = next
  return newNimTsIterator[int32](it)

proc streamWords*(words: seq[string]): NimTsChannel[string] {.exportts.} =
  let ch = newNimTsChannel[string](32)
  for w in words:
    discard ch.send(w)
  return ch

proc streamNumbers*(count: int32): NimTsChannel[int32] {.exportts.} =
  let ch = newNimTsChannel[int32](32)
  for i in 1 .. count:
    discard ch.send(i)
  return ch

static:
  emitTsGlueFiles("test_module", "tests/fixtures")
