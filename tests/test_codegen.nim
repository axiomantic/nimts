# tests/test_codegen.nim - Verifies code generation of .d.ts and .js wrappers
# Licensed under MIT License.

import std/unittest
import std/strutils
import std/os
import nimts/codegen

suite "NimTS Code Generation Verification":

  test "generateDts and generateJs produce valid wrappers":
    let meta = TsModuleMeta(
      name: "test_patch",
      wasmFileName: "test_patch.wasm",
      types: @[
        TsType(
          name: "PatchGraph",
          isHandle: true,
          fields: @[]
        ),
        TsType(
          name: "ModuleInfo",
          isHandle: false,
          fields: @[
            TsTypeField(name: "id", tsType: "number"),
            TsTypeField(name: "name", tsType: "string")
          ]
        )
      ],
      procs: @[
        TsProc(
          name: "parsePch1",
          cabiName: "nimts_parsePch1",
          params: @[
            TsParam(name: "data", nimType: "openArray[byte]", tsType: "Uint8Array")
          ],
          returnNimType: "PatchGraph",
          returnTsType: "PatchGraph",
          isAsync: false,
          isHandleReturn: true,
          returnKind: "handle"
        ),
        TsProc(
          name: "loadPatchAsync",
          cabiName: "nimts_loadPatchAsync",
          params: @[
            TsParam(name: "url", nimType: "string", tsType: "string")
          ],
          returnNimType: "Future[string]",
          returnTsType: "Promise<string>",
          isAsync: true,
          isHandleReturn: false,
          returnKind: "string"
        )
      ]
    )

    let dts = generateDts(meta)
    check dts.contains("export declare class PatchGraph")
    check dts.contains("export interface ModuleInfo")
    check dts.contains("parsePch1(data: Uint8Array): PatchGraph;")
    check dts.contains("loadPatchAsync(url: string): Promise<string>;")
    check dts.contains("export declare function initNimTs")

    let js = generateJs(meta)
    check js.contains("export class PatchGraph")
    check js.contains("export function parsePch1(data)")
    check js.contains("export async function loadPatchAsync(url)")
    check js.contains("export async function initNimTs")
    check js.contains("WebAssembly.instantiateStreaming")
