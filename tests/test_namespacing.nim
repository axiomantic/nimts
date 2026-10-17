# tests/test_namespacing.nim - Verifies module namespacing (nimts_<module>_<proc>)
# Licensed under MIT License.

import std/unittest
import nimts/macros
import nimts/codegen

# Define module "audio"
proc audioInit*(rate: int32): int32 {.exportts(module = "audio").} =
  rate * 2

proc audioReset*(): bool {.exportts(module = "audio").} =
  true

# Define module "video"
proc videoInit*(fps: int32): int32 {.exportts(module = "video").} =
  fps + 10

proc videoReset*(): bool {.exportts(module = "video").} =
  false

# Verify at compile-time that namespacing assigned the correct cabiName
static:
  var foundAudioInit = false
  var foundVideoInit = false
  var foundAudioReset = false
  var foundVideoReset = false

  for p in getExportedProcs():
    if p.name == "audioInit":
      doAssert p.cabiName == "nimts_audio_audioInit"
      foundAudioInit = true
    elif p.name == "videoInit":
      doAssert p.cabiName == "nimts_video_videoInit"
      foundVideoInit = true
    elif p.name == "audioReset":
      doAssert p.cabiName == "nimts_audio_audioReset"
      foundAudioReset = true
    elif p.name == "videoReset":
      doAssert p.cabiName == "nimts_video_videoReset"
      foundVideoReset = true

  doAssert foundAudioInit, "audioInit should have nimts_audio_audioInit C-ABI"
  doAssert foundVideoInit, "videoInit should have nimts_video_videoInit C-ABI"
  doAssert foundAudioReset, "audioReset should have nimts_audio_audioReset C-ABI"
  doAssert foundVideoReset, "videoReset should have nimts_video_videoReset C-ABI"

suite "NimTS Module Namespacing Verification":

  test "Procs with module pragma execute natively and produce collision-free C-ABI names":
    check audioInit(44100) == 88200
    check audioReset() == true
    check videoInit(60) == 70
    check videoReset() == false
