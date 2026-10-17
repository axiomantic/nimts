# tests/test_nimts.nim - Unit tests for nimts
import std/unittest
import nimts

# 1. Test proc with {.exportts.}
proc addNumbers*(a: int32, b: int32): int32 {.exportts.} =
  return a + b

proc greet*(name: string): string {.exportts.} =
  return "Hello, " & name & "!"

proc sumBytes*(data: openArray[uint8]): int32 {.exportts.} =
  var sum: int32 = 0
  for b in data:
    sum += int32(b)
  return sum

suite "nimts native execution":
  test "native Nim callers call {.exportts.} procs directly without overhead":
    check addNumbers(20, 22) == 42
    check greet("World") == "Hello, World!"
    check sumBytes([1'u8, 2'u8, 3'u8, 4'u8]) == 10

  test "compile-time proc registration count":
    check getExportedProcsCount() >= 3
