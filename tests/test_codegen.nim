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
    check js.contains("if (typeof _exports.NimMain === \"function\") _exports.NimMain();")
    check js.contains("if (typeof _exports.nimts_init === \"function\") _exports.nimts_init();")

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

  test "generateJs generates DataView-based _readPrimitive and _resolveValue for safe primitive parsing":
    let meta = TsModuleMeta(
      name: "safe_primitives",
      wasmFileName: "safe_primitives.wasm",
      types: @[],
      procs: @[
        TsProc(
          name: "fetchFloatAsync",
          cabiName: "nimts_fetchFloatAsync",
          params: @[],
          returnNimType: "Future[float64]",
          returnTsType: "Promise<number>",
          isAsync: true,
          isHandleReturn: false,
          returnKind: "float64"
        ),
        TsProc(
          name: "fetchBoolAsync",
          cabiName: "nimts_fetchBoolAsync",
          params: @[],
          returnNimType: "Future[bool]",
          returnTsType: "Promise<boolean>",
          isAsync: true,
          isHandleReturn: false,
          returnKind: "bool"
        )
      ]
    )

    let js = generateJs(meta)
    check js.contains("function _readPrimitive(bufOrPtr, len, kind)")
    check js.contains("new DataView(")
    check js.contains("function _resolveValue(ptrOrBuf, len, kind)")
    check js.contains("view.getFloat64(0, true)")
    check js.contains("view.getInt32(0, true) !== 0")

  test "generateDts and generateJs handle overloaded procedures correctly without duplicate declarations":
    let meta = TsModuleMeta(
      name: "overload_mod",
      wasmFileName: "overload_mod.wasm",
      types: @[],
      procs: @[
        TsProc(
          name: "formatValue",
          cabiName: "nimts_formatValue",
          params: @[TsParam(name: "val", nimType: "int32", tsType: "number")],
          returnNimType: "string",
          returnTsType: "string",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "string"
        ),
        TsProc(
          name: "formatValue",
          cabiName: "nimts_formatValue_1",
          params: @[TsParam(name: "val", nimType: "float32", tsType: "number")],
          returnNimType: "string",
          returnTsType: "string",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "string"
        ),
        TsProc(
          name: "computeHash",
          cabiName: "nimts_computeHash",
          params: @[TsParam(name: "id", nimType: "int64", tsType: "bigint")],
          returnNimType: "int64",
          returnTsType: "bigint",
          isAsync: false,
          isHandleReturn: false,
          returnKind: "int64"
        )
      ]
    )

    let dts = generateDts(meta)
    check dts.contains("formatValue(val: number): string;")
    check dts.contains("computeHash(id: bigint): bigint;")

    let js = generateJs(meta)
    check js.contains("function _proc_formatValue_0(val)")
    check js.contains("function _proc_formatValue_1(val)")
    check js.contains("export function formatValue(...args)")
    check js.contains("Number.isInteger(args[0])")
    check js.contains("export function computeHash(id)")
    # BigInt param must not be stringified
    check not js.contains("JSON.stringify(id)")
    # Check that formatValue only appears once in _exportsObj
    let exportsIdx1 = js.find("formatValue,")
    check exportsIdx1 != -1
    let exportsIdx2 = js.find("formatValue,", exportsIdx1 + 12)
    check exportsIdx2 == -1

