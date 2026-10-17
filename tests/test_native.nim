# tests/test_native.nim - Verifies that {.exportts.} has zero signature perturbation for native Nim callers
# Licensed under MIT License.

import std/unittest
import std/asyncdispatch
import nimts

type
  AudioSynth = ref object
    sampleRate*: float32
    voiceCount*: int32

  SynthConfig = object
    channels*: int32
    polyphony*: int32
    name*: string

proc computeFrequency*(note: int32, tuningA4: float32): float32 {.exportts.} =
  result = tuningA4 * (note.float32 / 69.0'f32)

proc processAudioBuffer*(input: openArray[byte]): seq[byte] {.exportts.} =
  result = newSeq[byte](input.len)
  for i in 0 ..< input.len:
    result[i] = input[i] xor 0xAA'u8

proc createSynth*(sampleRate: float32, voices: int32): AudioSynth {.exportts.} =
  AudioSynth(sampleRate: sampleRate, voiceCount: voices)

proc getVoiceCount*(synth: AudioSynth): int32 {.exportts.} =
  if synth == nil: return 0
  synth.voiceCount

proc configureSynth*(cfg: SynthConfig): string {.exportts.} =
  result = cfg.name & ":" & $cfg.polyphony & "ch" & $cfg.channels

proc renderSynthAsync*(synth: AudioSynth, frames: int32): Future[int32] {.async, exportts.} =
  if synth == nil: return 0
  return synth.voiceCount * frames

proc formatValue*(val: int32): string {.exportts.} =
  "int:" & $val

proc formatValue*(val: float32): string {.exportts.} =
  "float:" & $val

suite "Native Nim {.exportts.} Non-Invasive Verification":

  test "Direct invocation with primitive arguments and returns":
    let freq = computeFrequency(69, 440.0)
    check freq == 440.0

  test "Direct invocation with openArray[byte] input and seq[byte] output":
    let raw = [1'u8, 2, 3, 4]
    let processed = processAudioBuffer(raw)
    check processed.len == 4
    check processed[0] == (1'u8 xor 0xAA'u8)
    check processed[1] == (2'u8 xor 0xAA'u8)

  test "Direct invocation with ref object instances (Handles in WASM)":
    let synth = createSynth(48000.0, 16)
    check synth != nil
    check synth.sampleRate == 48000.0
    check synth.voiceCount == 16
    check getVoiceCount(synth) == 16

  test "Direct invocation with value objects":
    let cfg = SynthConfig(channels: 2, polyphony: 8, name: "FM")
    let desc = configureSynth(cfg)
    check desc == "FM:8ch2"

  test "Direct invocation with async Future[T]":
    let synth = createSynth(44100.0, 8)
    let fut = renderSynthAsync(synth, 128)
    let val = waitFor fut
    check val == 8 * 128

  test "Direct invocation with overloaded procs":
    check formatValue(42'i32) == "int:42"
    check formatValue(3.14'f32) == "float:3.14"

