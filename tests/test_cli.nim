# tests/test_cli.nim - Unit tests for the nimts CLI executable
# Licensed under MIT License.

import std/unittest
import std/osproc
import std/strutils

suite "NimTS CLI Executable":

  test "nimts --version returns 0.1.0":
    let (output, exitCode) = execCmdEx("nim r -p:src src/nimts.nim --version")
    check exitCode == 0
    check output.strip.contains("nimts 0.1.0")

  test "nimts --help displays usage and command list":
    let (output, exitCode) = execCmdEx("nim r -p:src src/nimts.nim --help")
    check exitCode == 0
    check output.contains("Usage:")
    check output.contains("compile <input.nim>")
    check output.contains("version")

  test "nimts compile without arguments exits with error code 1":
    let (output, exitCode) = execCmdEx("nim r -p:src src/nimts.nim compile")
    check exitCode == 1
    check output.contains("Error: 'nimts compile' requires an input .nim file")
