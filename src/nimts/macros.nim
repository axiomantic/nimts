# nimts/macros.nim - Non-invasive {.exportts.} and exportTs(procOrType) macros
# Licensed under MIT License.

import std/macros
import std/strutils
import std/json
import codegen

var
  gExportedProcs {.compileTime.}: seq[TsProc] = @[]
  gExportedTypes {.compileTime.}: seq[TsType] = @[]

type
  ParamKind = enum
    pkPrimitive,
    pkString,
    pkBytes,
    pkHandle,
    pkObject

proc cleanName(node: NimNode): (string, NimNode) =
  if node.kind == nnkPostfix and node.len == 2:
    (node[1].strVal, node[1])
  elif node.kind == nnkIdent:
    (node.strVal, node)
  elif node.kind == nnkSym:
    (node.strVal, node)
  else:
    (node.repr, node)

proc classifyParamType(typeNode: NimNode): (ParamKind, string, string) =
  let typeRepr = typeNode.repr.strip
  case typeRepr
  of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8", "float", "float32", "float64", "bool", "char":
    return (pkPrimitive, typeRepr, mapNimTypeToTs(typeRepr))
  of "string", "cstring":
    return (pkString, typeRepr, "string")
  of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]":
    return (pkBytes, typeRepr, "Uint8Array")
  else:
    for t in gExportedTypes:
      if t.name == typeRepr and t.isHandle:
        return (pkHandle, typeRepr, typeRepr)
    if typeRepr.contains("Handle") or typeRepr.startsWith("ref "):
      return (pkHandle, typeRepr, typeRepr.replace("ref ", ""))
    return (pkObject, typeRepr, typeRepr)

proc classifyReturnType(retNode: NimNode): (string, string, bool, string) =
  # returns (nimType, tsType, isAsync, returnKind)
  if retNode.kind == nnkEmpty:
    return ("void", "void", false, "void")
  let retRepr = retNode.repr.strip
  if retRepr == "void" or retRepr == "":
    return ("void", "void", false, "void")
  if retRepr.startsWith("Future[") and retRepr.endsWith("]"):
    let inner = retRepr[7 .. ^2]
    let innerTs = mapNimTypeToTs(inner)
    let innerKind = case inner
      of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8", "float", "float32", "float64", "bool": "primitive"
      of "string", "cstring": "string"
      of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]": "bytes"
      else: "object"
    return (retRepr, "Promise<" & innerTs & ">", true, innerKind)
  case retRepr
  of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8", "float", "float32", "float64", "bool", "char":
    return (retRepr, mapNimTypeToTs(retRepr), false, "primitive")
  of "string", "cstring":
    return (retRepr, "string", false, "string")
  of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]":
    return (retRepr, "Uint8Array", false, "bytes")
  else:
    for t in gExportedTypes:
      if t.name == retRepr and t.isHandle:
        return (retRepr, retRepr, false, "handle")
    if retRepr.contains("Handle") or retRepr.startsWith("ref "):
      return (retRepr, retRepr.replace("ref ", ""), false, "handle")
    return (retRepr, retRepr, false, "object")

proc processExportTs*(body: NimNode): NimNode =
  result = newStmtList()

  if body.kind == nnkProcDef:
    var procDef = body
    let (procNameStr, baseIdent) = cleanName(procDef[0])
    let cabiNameStr = "nimts_" & procNameStr
    let cabiIdent = ident(cabiNameStr)

    # 1. Clean pragmas on the original proc (remove exportts pragma)
    var newPragmas = newNimNode(nnkPragma)
    if procDef[4].kind == nnkPragma:
      for p in procDef[4]:
        let pName = if p.kind == nnkIdent: p.strVal elif p.kind == nnkExprColonExpr and p.len > 0: p[0].strVal else: ""
        if pName.toLowerAscii != "exportts":
          newPragmas.add(p)
        if p.kind == nnkIdent and (p.strVal == "exportts" or p.strVal == "exportTs"):
          discard
        elif p.kind == nnkExprColonExpr and (p[0].strVal == "exportts" or p[0].strVal == "exportTs"):
          discard
        else:
          newPragmas.add(p)
    procDef[4] = newPragmas

    # Original proc is emitted completely untouched
    result.add(procDef)

    # 2. Extract metadata
    let paramsNode = procDef[3]
    let retNode = paramsNode[0]
    let (retNimType, retTsType, isAsync, retKind) = classifyReturnType(retNode)

    var metaParams: seq[TsParam] = @[]
    var wrapperFormalParams: seq[NimNode] = @[ident("auto")]
    var callArgs: seq[NimNode] = @[]
    var unpackStmts = newStmtList()

    for i in 1 ..< paramsNode.len:
      let identDef = paramsNode[i]
      let paramTypeNode = identDef[^2]
      for j in 0 ..< identDef.len - 2:
        let paramName = identDef[j].strVal
        let (paramKind, paramNimType, paramTsType) = classifyParamType(paramTypeNode)
        metaParams.add(TsParam(name: paramName, nimType: paramNimType, tsType: paramTsType))

        case paramKind
        of pkPrimitive:
          wrapperFormalParams.add(newIdentDefs(ident(paramName), paramTypeNode))
          callArgs.add(ident(paramName))

        of pkString:
          let ptrIdent = ident(paramName & "_ptr")
          let lenIdent = ident(paramName & "_len")
          wrapperFormalParams.add(newIdentDefs(ptrIdent, parseExpr("ptr char")))
          wrapperFormalParams.add(newIdentDefs(lenIdent, ident("int32")))
          unpackStmts.add(parseStmt("let " & paramName & " = readString(" & ptrIdent.strVal & ", " & lenIdent.strVal & ")"))
          callArgs.add(ident(paramName))

        of pkBytes:
          let ptrIdent = ident(paramName & "_ptr")
          let lenIdent = ident(paramName & "_len")
          wrapperFormalParams.add(newIdentDefs(ptrIdent, parseExpr("ptr uint8")))
          wrapperFormalParams.add(newIdentDefs(lenIdent, ident("int32")))
          if paramNimType.startsWith("openArray"):
            callArgs.add(parseExpr("(if " & lenIdent.strVal & " > 0 and " & ptrIdent.strVal & " != nil: toOpenArray(cast[ptr UncheckedArray[byte]](" & ptrIdent.strVal & "), 0, " & lenIdent.strVal & " - 1) else: toOpenArray(cast[ptr UncheckedArray[byte]](nil), 0, -1))"))
          else:
            unpackStmts.add(parseStmt("let " & paramName & " = readBytes(" & ptrIdent.strVal & ", " & lenIdent.strVal & ")"))
            callArgs.add(ident(paramName))

        of pkHandle:
          let handleIdent = ident(paramName & "_handle")
          wrapperFormalParams.add(newIdentDefs(handleIdent, ident("HandleId")))
          unpackStmts.add(parseStmt("let " & paramName & " = getHandle[" & paramTypeNode.repr & "](" & handleIdent.strVal & ")"))
          callArgs.add(ident(paramName))

        of pkObject:
          let ptrIdent = ident(paramName & "_ptr")
          let lenIdent = ident(paramName & "_len")
          wrapperFormalParams.add(newIdentDefs(ptrIdent, parseExpr("ptr char")))
          wrapperFormalParams.add(newIdentDefs(lenIdent, ident("int32")))
          unpackStmts.add(parseStmt("let " & paramName & "_jsonStr = readString(" & ptrIdent.strVal & ", " & lenIdent.strVal & ")"))
          unpackStmts.add(parseStmt("let " & paramName & " = to(parseJson(" & paramName & "_jsonStr), " & paramTypeNode.repr & ")"))
          callArgs.add(ident(paramName))

    # Record compile-time proc metadata
    gExportedProcs.add(TsProc(
      name: procNameStr,
      cabiName: cabiNameStr,
      params: metaParams,
      returnNimType: retNimType,
      returnTsType: retTsType,
      isAsync: isAsync,
      isHandleReturn: retKind == "handle",
      returnKind: retKind
    ))

    # 3. Build C-ABI companion wrapper body
    var companionBody = newStmtList()
    companionBody.add(unpackStmts)

    var callExpr = newCall(baseIdent)
    for arg in callArgs:
      callExpr.add(arg)

    if retNimType == "void":
      companionBody.add(callExpr)
    else:
      let invokeStmt = newLetStmt(ident("res"), callExpr)
      companionBody.add(invokeStmt)

      let retBranch = parseStmt("""
when typeof(res) is (SomeInteger or SomeFloat or bool or char):
  return res
elif typeof(res) is string:
  return allocStringResult(res)
elif typeof(res) is (seq[byte] or seq[uint8]):
  return allocBytesResult(res)
elif typeof(res) is Future:
  return bridgeFutureToPromise(res)
elif typeof(res) is ref object:
  return registerHandle(res)
else:
  return allocStringResult($(%*(res)))
""")
      companionBody.add(retBranch)

    # 4. Construct companion proc definition
    var companionPragmas = newNimNode(nnkPragma)
    companionPragmas.add(newColonExpr(ident("exportc"), newLit(cabiNameStr)))
    companionPragmas.add(ident("cdecl"))

    var companionProc = newProc(
      name = cabiIdent,
      params = wrapperFormalParams,
      body = companionBody,
      procType = nnkProcDef,
      pragmas = companionPragmas
    )

    # Wrap in when defined(wasm) or defined(emscripten) or defined(nimtsWasm) or defined(nimtsCabi):
    let whenCondition = parseExpr("defined(wasm) or defined(emscripten) or defined(nimtsWasm) or defined(nimtsCabi)")
    let whenBranch = newNimNode(nnkElifBranch).add(whenCondition, companionProc)
    let whenStmt = newNimNode(nnkWhenStmt).add(whenBranch)

    result.add(whenStmt)

  elif body.kind == nnkTypeDef:
    var typeDef = body
    var typeName = ""
    if typeDef[0].kind == nnkPragmaExpr:
      let (nameStr, _) = cleanName(typeDef[0][0])
      typeName = nameStr
      typeDef[0] = typeDef[0][0]
    else:
      let (nameStr, _) = cleanName(typeDef[0])
      typeName = nameStr

    let isRef = typeDef[2].kind == nnkRefTy or typeDef[2].repr.contains("ref object")
    gExportedTypes.add(TsType(name: typeName, isHandle: isRef, fields: @[]))
    result = typeDef

  elif body.kind == nnkTypeSection:
    result.add(body)
    for typeDef in body:
      let (typeName, _) = cleanName(typeDef[0])
      let isRef = typeDef[2].kind == nnkRefTy or typeDef[2].repr.contains("ref object")
      gExportedTypes.add(TsType(name: typeName, isHandle: isRef, fields: @[]))
  else:
    result.add(body)

macro exportTs*(target: untyped): untyped =
  if target.kind in [nnkProcDef, nnkTypeSection, nnkTypeDef, nnkStmtList]:
    result = processExportTs(target)
  else:
    let (nameStr, _) = cleanName(target)
    # Check if target is a known type or proc
    result = parseStmt("""
when declared(""" & nameStr & """):
  when """ & nameStr & """ is typedesc:
    static:
      gExportedTypes.add(TsType(name: """" & nameStr & """", isHandle: """ & nameStr & """ is ref object, fields: @[]))
""")

macro importts*(body: untyped): untyped =
  # proc jsFetch*(url: cstring): Future[seq[byte]] {.importts.}
  expectKind(body, nnkProcDef)
  var procDef = body
  let (procNameStr, _) = cleanName(procDef[0])

  # Strip importts from pragmas
  var newPragmas = newNimNode(nnkPragma)
  if procDef[4].kind == nnkPragma:
    for p in procDef[4]:
      if p.kind == nnkIdent and p.strVal == "importts": discard
      else: newPragmas.add(p)
  procDef[4] = newPragmas

  let paramsNode = procDef[3]
  let retNode = paramsNode[0]
  let retRepr = retNode.repr.strip

  # Generate proc body calling bridgeJsPromiseToFuture
  if retRepr.startsWith("Future[") and retRepr.endsWith("]"):
    let innerTypeStr = retRepr[7 .. ^2]
    procDef[6] = parseStmt("""
let fut = newFuture[""" & innerTypeStr & """]("""" & procNameStr & """")
let fid = nextFutureId()
registerPendingFuture(fid, fut)
when defined(wasm) or defined(emscripten) or defined(nimtsWasm):
  nimts_js_call_async(1'i32, fid.int32, nil, 0'i32)
return fut
""")
  result = procDef

macro emitTsGlueFiles*(moduleName: static[string], outputDir: static[string] = "."): untyped =
  let meta = TsModuleMeta(
    name: moduleName,
    wasmFileName: moduleName & ".wasm",
    types: gExportedTypes,
    procs: gExportedProcs
  )
  let dtsContent = generateDts(meta)
  let jsContent = generateJs(meta)
  let dtsPath = outputDir & "/" & moduleName & ".d.ts"
  let jsPath = outputDir & "/" & moduleName & ".js"
  writeFile(dtsPath, dtsContent)
  writeFile(jsPath, jsContent)
  result = newEmptyNode()

proc getExportedProcsCount*(): int {.compileTime.} = gExportedProcs.len
proc getExportedTypesCount*(): int {.compileTime.} = gExportedTypes.len
