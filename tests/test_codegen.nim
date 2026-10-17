# tests/test_codegen.nim - Verifies code generation of .d.ts and .js wrappers
# Licensed under MIT License.

import std/unittest
import std/strutils
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

  test "mapNimTypeToTs maps all core Nim types and generic wrappers correctly":
    check mapNimTypeToTs("int32") == "number"
    check mapNimTypeToTs("float64") == "number"
    check mapNimTypeToTs("int64") == "bigint"
    check mapNimTypeToTs("uint64") == "bigint"
    check mapNimTypeToTs("bool") == "boolean"
    check mapNimTypeToTs("string") == "string"
    check mapNimTypeToTs("cstring") == "string"
    check mapNimTypeToTs("openArray[byte]") == "Uint8Array"
    check mapNimTypeToTs("seq[byte]") == "Uint8Array"
    check mapNimTypeToTs("void") == "void"
    check mapNimTypeToTs("Future[int32]") == "Promise<number>"
    check mapNimTypeToTs("Future[string]") == "Promise<string>"
    check mapNimTypeToTs("Option[string]") == "string | null"
    check mapNimTypeToTs("seq[string]") == "string[]"
    check mapNimTypeToTs("NimTsHandle[PatchGraph]") == "PatchGraph"

  test "generateJs handles void, boolean, and json object return kinds":
    let meta = TsModuleMeta(
      name: "advanced_mod",
      wasmFileName: "advanced_mod.wasm",
      types: @[],
      procs: @[
        TsProc(
          name: "resetState",
          cabiName: "nimts_resetState",
          params: @[],
          returnNimType: "void",
          returnTsType: "void",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "void"
        ),
        TsProc(
          name: "isValid",
          cabiName: "nimts_isValid",
          params: @[TsParam(name: "id", nimType: "int32", tsType: "number")],
          returnNimType: "bool",
          returnTsType: "boolean",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "primitive"
        ),
        TsProc(
          name: "getConfig",
          cabiName: "nimts_getConfig",
          params: @[],
          returnNimType: "SynthConfig",
          returnTsType: "SynthConfig",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "object"
        )
      ]
    )

    let js = generateJs(meta)
    check js.contains("export function resetState()")
    check js.contains("return Boolean(_exports.nimts_isValid(id));")
    check js.contains("JSON.parse(jsonStr);")
