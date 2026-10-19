# nimts/macros.nim - Non-invasive {.exportts.} and exportTs(procOrType) macros
# Licensed under MIT License.

import std/macros
import std/strutils
import std/tables
import std/json
import codegen
import memory
export memory

var
  gExportedProcs {.compileTime.}: seq[TsProc] = @[]
  gExportedTypes {.compileTime.}: seq[TsType] = @[]
  gProcCounts {.compileTime.}: Table[string, int] = initTable[string, int]()
  gModuleName {.compileTime.}: string = ""

proc setNimTsModule*(name: string) {.compileTime.} =
  gModuleName = name

proc getNimTsModule*(): string {.compileTime.} =
  gModuleName

macro setModule*(name: static[string]): untyped =
  gModuleName = name
  result = newEmptyNode()

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

proc replacePlaceholder(n: NimNode, replacement: NimNode): NimNode =
  result = copyNimNode(n)
  if n.kind == nnkCall and n.len > 0 and n[0].kind == nnkIdent and n[0].strVal == "placeholderCall":
    return replacement.copyNimTree()
  for child in n:
    result.add(replacePlaceholder(child, replacement))

proc rewriteChannelNodes(n: NimNode): NimNode =
  if n.kind == nnkIdent and n.strVal == "Channel":
    return ident("NimTsChannel")
  result = copyNimNode(n)
  for child in n:
    result.add(rewriteChannelNodes(child))

proc getArrayElemType(nimType: string): string =
  let t = nimType.strip
  if (t.startsWith("seq[") or t.startsWith("openArray[")) and t.endsWith("]"):
    let startIdx = if t.startsWith("seq["): 4 else: 10
    return t[startIdx .. ^2].strip
  return ""

proc numericElemToTsArray(elemType: string): string =
  case elemType
  of "byte", "uint8": "Uint8Array"
  of "int8": "Int8Array"
  of "int16": "Int16Array"
  of "uint16": "Uint16Array"
  of "int", "int32": "Int32Array"
  of "uint", "uint32": "Uint32Array"
  of "float", "float32": "Float32Array"
  of "float64": "Float64Array"
  of "int64": "BigInt64Array"
  of "uint64": "BigUint64Array"
  else: ""

proc classifyParamType(typeNode: NimNode): (ParamKind, string, string) =
  let typeRepr = typeNode.repr.strip
  if (typeRepr.startsWith("NimTsChannel[") and typeRepr.endsWith("]")) or
     (typeRepr.startsWith("Channel[") and typeRepr.endsWith("]")):
    let prefixLen = if typeRepr.startsWith("NimTsChannel["): 13 else: 8
    let inner = typeRepr[prefixLen .. ^2]
    return (pkHandle, typeRepr, "NimTsChannel<" & mapNimTypeToTs(inner) & ">")
  elif typeRepr == "NimTsChannel" or typeRepr == "Channel":
    return (pkHandle, typeRepr, "NimTsChannel<any>")

  if typeRepr.startsWith("NimTsView[") and typeRepr.endsWith("]"):
    let inner = typeRepr[10 .. ^2].strip
    let tsArray = numericElemToTsArray(inner)
    let viewArray = if tsArray.len > 0: tsArray else: "Uint8Array"
    return (pkBytes, typeRepr, "NimTsView<" & viewArray & ">")

  let arrayElem = getArrayElemType(typeRepr)
  let tsArray = numericElemToTsArray(arrayElem)
  if tsArray.len > 0:
    return (pkBytes, typeRepr, tsArray)

  case typeRepr
  of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8", "int64", "uint64", "float", "float32", "float64", "bool", "char":
    return (pkPrimitive, typeRepr, mapNimTypeToTs(typeRepr))
  of "string", "cstring":
    return (pkString, typeRepr, "string")
  else:
    for t in gExportedTypes:
      if t.name == typeRepr and t.isHandle:
        return (pkHandle, typeRepr, typeRepr)
    if typeRepr.contains("Handle") or typeRepr.startsWith("ref "):
      return (pkHandle, typeRepr, typeRepr.replace("ref ", ""))
    return (pkObject, typeRepr, mapNimTypeToTs(typeRepr))

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
    let innerElem = getArrayElemType(inner)
    let innerTsArray = numericElemToTsArray(innerElem)
    let innerKind = if innerTsArray.len > 0:
      "typedarray:" & innerTsArray
    else:
      case inner
      of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8": "int32"
      of "int64", "uint64": "int64"
      of "float", "float32": "float32"
      of "float64": "float64"
      of "bool": "bool"
      of "string", "cstring": "string"
      of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]": "bytes"
      of "void", "": "void"
      else: "object"
    return (retRepr, "Promise<" & innerTs & ">", true, innerKind)
  if retRepr.startsWith("NimTsIterator[") and retRepr.endsWith("]"):
    let inner = retRepr[14 .. ^2]
    let innerTs = mapNimTypeToTs(inner)
    let innerElem = getArrayElemType(inner)
    let innerTsArray = numericElemToTsArray(innerElem)
    let innerKind = if innerTsArray.len > 0:
      "typedarray:" & innerTsArray
    else:
      case inner
      of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8": "int32"
      of "int64", "uint64": "int64"
      of "float", "float32": "float32"
      of "float64": "float64"
      of "bool": "bool"
      of "string", "cstring": "string"
      of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]": "bytes"
      else: "object"
    return (retRepr, "NimTsIterator<" & innerTs & ">", false, "iterator:" & innerKind)
  if (retRepr.startsWith("NimTsChannel[") and retRepr.endsWith("]")) or
     (retRepr.startsWith("Channel[") and retRepr.endsWith("]")):
    let prefixLen = if retRepr.startsWith("NimTsChannel["): 13 else: 8
    let inner = retRepr[prefixLen .. ^2]
    let innerTs = mapNimTypeToTs(inner)
    let innerElem = getArrayElemType(inner)
    let innerTsArray = numericElemToTsArray(innerElem)
    let innerKind = if innerTsArray.len > 0:
      "typedarray:" & innerTsArray
    else:
      case inner
      of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8": "int32"
      of "int64", "uint64": "int64"
      of "float", "float32": "float32"
      of "float64": "float64"
      of "bool": "bool"
      of "string", "cstring": "string"
      of "seq[byte]", "openArray[byte]", "seq[uint8]", "openArray[uint8]": "bytes"
      else: "object"
    return (retRepr, "NimTsChannel<" & innerTs & ">", false, "channel:" & innerKind)
  if retRepr == "NimTsChannel" or retRepr == "Channel":
    return (retRepr, "NimTsChannel<any>", false, "channel:object")

  if retRepr.startsWith("NimTsView[") and retRepr.endsWith("]"):
    let inner = retRepr[10 .. ^2].strip
    let tsArray = numericElemToTsArray(inner)
    let viewArray = if tsArray.len > 0: tsArray else: "Uint8Array"
    return (retRepr, "NimTsView<" & viewArray & ">", false, "view:" & viewArray)

  let retElem = getArrayElemType(retRepr)
  let retTsArray = numericElemToTsArray(retElem)
  if retTsArray.len > 0:
    return (retRepr, retTsArray, false, "typedarray:" & retTsArray)

  case retRepr
  of "int", "int32", "int16", "int8", "uint", "uint32", "uint16", "uint8":
    return (retRepr, mapNimTypeToTs(retRepr), false, "int32")
  of "int64", "uint64":
    return (retRepr, "bigint", false, "int64")
  of "float", "float32":
    return (retRepr, "number", false, "float32")
  of "float64":
    return (retRepr, "number", false, "float64")
  of "bool":
    return (retRepr, "boolean", false, "bool")
  of "char":
    return (retRepr, "string", false, "char")
  of "string", "cstring":
    return (retRepr, "string", false, "string")
  else:
    for t in gExportedTypes:
      if t.name == retRepr and t.isHandle:
        return (retRepr, retRepr, false, "handle")
    if retRepr.contains("Handle") or retRepr.startsWith("ref "):
      return (retRepr, retRepr.replace("ref ", ""), false, "handle")
    return (retRepr, mapNimTypeToTs(retRepr), false, "object")

proc processExportTs*(body: NimNode): NimNode =
  result = newStmtList()

  if body.kind == nnkProcDef:
    var procDef = body
    let (procNameStr, baseIdent) = cleanName(procDef[0])

    var modName = gModuleName
    if procDef[4].kind == nnkPragma:
      for p in procDef[4]:
        if p.kind == nnkExprColonExpr and p.len > 1:
          let key = if p[0].kind == nnkIdent: p[0].strVal else: ""
          if key.toLowerAscii == "module":
            modName = if p[1].kind == nnkStrLit: p[1].strVal else: p[1].repr.strip(chars = {'"'})
        elif p.kind == nnkCall and p.len > 1:
          let key = if p[0].kind == nnkIdent: p[0].strVal else: ""
          if key.toLowerAscii in ["exportts", "export_ts"]:
            for k in 1 ..< p.len:
              if p[k].kind == nnkExprColonExpr and p[k][0].strVal == "module":
                modName = if p[k][1].kind == nnkStrLit: p[k][1].strVal else: p[k][1].repr.strip(chars = {'"'})
              elif p[k].kind == nnkStrLit:
                modName = p[k].strVal

    let cabiBase = if modName.len > 0: "nimts_" & modName & "_" & procNameStr else: "nimts_" & procNameStr
    var cabiNameStr = cabiBase
    let countKey = if modName.len > 0: modName & "_" & procNameStr else: procNameStr
    if gProcCounts.hasKey(countKey):
      let count = gProcCounts[countKey] + 1
      gProcCounts[countKey] = count
      cabiNameStr = cabiBase & "_" & $count
    else:
      gProcCounts[countKey] = 0
    let cabiIdent = ident(cabiNameStr)

    var isAudioProcess = false
    if procDef[4].kind == nnkPragma:
      for p in procDef[4]:
        let pName = if p.kind == nnkIdent: p.strVal
                    elif p.kind == nnkExprColonExpr and p.len > 0: p[0].strVal
                    elif p.kind == nnkCall and p.len > 0: p[0].strVal
                    else: ""
        if pName.toLowerAscii in ["audioprocess", "audio_process", "worklet", "exporttsworklet"]:
          isAudioProcess = true
        elif p.kind in [nnkExprColonExpr, nnkCall]:
          for k in 1 ..< p.len:
            let childName = if p[k].kind == nnkIdent: p[k].strVal else: ""
            if childName.toLowerAscii in ["audioprocess", "audio_process", "worklet"]:
              isAudioProcess = true

    # 1. Clean pragmas on the original proc (remove exportts & audioProcess pragmas)
    var newPragmas = newNimNode(nnkPragma)
    if procDef[4].kind == nnkPragma:
      for p in procDef[4]:
        let pName = if p.kind == nnkIdent: p.strVal
                    elif p.kind == nnkExprColonExpr and p.len > 0: p[0].strVal
                    elif p.kind == nnkCall and p.len > 0: p[0].strVal
                    else: ""
        if pName.toLowerAscii in ["exportts", "export_ts", "module", "audioprocess", "audio_process", "worklet", "exporttsworklet"]:
          discard
        else:
          newPragmas.add(p)
    procDef[4] = newPragmas

    # Original proc is emitted with Channel rewritten to NimTsChannel to prevent system.Channel ambiguity
    result.add(rewriteChannelNodes(procDef))

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
          let elemType = if paramNimType.startsWith("NimTsView["):
            paramNimType[10 .. ^2].strip
          else:
            getArrayElemType(paramNimType)
          let elemNimType = if elemType == "byte": "uint8" elif elemType == "int": "int32" elif elemType == "uint": "uint32" elif elemType == "float": "float32" else: elemType
          wrapperFormalParams.add(newIdentDefs(ptrIdent, parseExpr("ptr " & elemNimType)))
          wrapperFormalParams.add(newIdentDefs(lenIdent, ident("int32")))
          if paramNimType.startsWith("openArray"):
            callArgs.add(parseExpr("(if " & lenIdent.strVal & " > 0 and " & ptrIdent.strVal & " != nil: toOpenArray(cast[ptr UncheckedArray[" & elemType & "]](" & ptrIdent.strVal & "), 0, " & lenIdent.strVal & " - 1) else: toOpenArray(cast[ptr UncheckedArray[" & elemType & "]](nil), 0, -1))"))
          elif paramNimType.startsWith("NimTsView["):
            callArgs.add(parseExpr("initNimTsView[" & elemType & "](" & ptrIdent.strVal & ", " & lenIdent.strVal & ")"))
          else:
            unpackStmts.add(parseStmt("let " & paramName & " = readTypedArray[" & elemType & "](" & ptrIdent.strVal & ", " & lenIdent.strVal & ")"))
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
      returnKind: retKind,
      isAudioProcess: isAudioProcess
    ))

    # 3. Build C-ABI companion wrapper body
    var companionBody = newStmtList()
    companionBody.add(newCall(ident("ensureNimTsInit")))
    companionBody.add(unpackStmts)

    var callExpr = newCall(baseIdent)
    for arg in callArgs:
      callExpr.add(arg)

    if retNimType == "void":
      var tryBlock = parseStmt("""
try:
  placeholderCall()
except CatchableError as e:
  setLastError(e.msg)
except Defect as e:
  setLastError(e.msg)
""")
      companionBody.add(replacePlaceholder(tryBlock, callExpr))
    else:
      var tryBlock = parseStmt("""
try:
  let res = placeholderCall()
  when typeof(res) is (SomeInteger or SomeFloat or bool or char):
    return res
  elif typeof(res) is string:
    return allocStringResult(res)
  elif typeof(res) is (seq[byte] or seq[uint8] or seq[int8] or seq[int16] or seq[uint16] or seq[int32] or seq[int] or seq[uint32] or seq[uint] or seq[float32] or seq[float] or seq[float64] or seq[int64] or seq[uint64]):
    return allocTypedArrayResult(res)
  elif (when declared(NimTsView): typeof(res) is NimTsView else: false):
    return packNimTsViewResult(res)
  elif (when declared(Future): typeof(res) is Future else: false):
    return bridgeFutureToPromise(res)
  elif (when declared(NimTsIterator): typeof(res) is NimTsIterator else: false):
    return res.HandleId
  elif (when declared(NimTsChannel): typeof(res) is NimTsChannel else: false):
    return registerChannel(res)
  elif typeof(res) is ref object:
    return registerHandle(res)
  else:
    return allocStringResult($(%*(res)))
except CatchableError as e:
  setLastError(e.msg)
  type RetType = typeof(placeholderCall())
  when RetType is (SomeInteger or SomeFloat or bool or char):
    return default(RetType)
  elif RetType is string:
    return 0'u64
  elif RetType is (seq[byte] or seq[uint8] or seq[int8] or seq[int16] or seq[uint16] or seq[int32] or seq[int] or seq[uint32] or seq[uint] or seq[float32] or seq[float] or seq[float64] or seq[int64] or seq[uint64]):
    return 0'u64
  elif (when declared(NimTsView): RetType is NimTsView else: false):
    return 0'u64
  elif (when declared(Future): RetType is Future else: false):
    return 0'i32
  elif (when declared(NimTsIterator): RetType is NimTsIterator else: false):
    return 0'i32
  elif (when declared(NimTsChannel): RetType is NimTsChannel else: false):
    return 0'i32
  elif RetType is ref object:
    return 0'i32
  else:
    return 0'u64
except Defect as e:
  setLastError(e.msg)
  type RetType = typeof(placeholderCall())
  when RetType is (SomeInteger or SomeFloat or bool or char):
    return default(RetType)
  elif RetType is string:
    return 0'u64
  elif RetType is (seq[byte] or seq[uint8] or seq[int8] or seq[int16] or seq[uint16] or seq[int32] or seq[int] or seq[uint32] or seq[uint] or seq[float32] or seq[float] or seq[float64] or seq[int64] or seq[uint64]):
    return 0'u64
  elif (when declared(NimTsView): RetType is NimTsView else: false):
    return 0'u64
  elif (when declared(Future): RetType is Future else: false):
    return 0'i32
  elif (when declared(NimTsIterator): RetType is NimTsIterator else: false):
    return 0'i32
  elif (when declared(NimTsChannel): RetType is NimTsChannel else: false):
    return 0'i32
  elif RetType is ref object:
    return 0'i32
  else:
    return 0'u64
""")
      companionBody.add(replacePlaceholder(tryBlock, callExpr))

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
    var fields: seq[TsTypeField] = @[]
    var objNode = typeDef[2]
    if objNode.kind == nnkRefTy and objNode.len > 0:
      objNode = objNode[0]
    if objNode.kind == nnkObjectTy and objNode.len > 2 and objNode[2].kind == nnkRecList:
      for identDefs in objNode[2]:
        if identDefs.kind == nnkIdentDefs:
          let fType = identDefs[^2].repr.strip()
          let fTsType = mapNimTypeToTs(fType)
          for k in 0 ..< identDefs.len - 2:
            let (fName, _) = cleanName(identDefs[k])
            fields.add(TsTypeField(name: fName, tsType: fTsType))

    gExportedTypes.add(TsType(name: typeName, isHandle: isRef, fields: fields))
    result = typeDef

  elif body.kind == nnkTypeSection:
    result = body
    for typeDef in body:
      var tDef = typeDef
      var typeName = ""
      if tDef[0].kind == nnkPragmaExpr:
        let (nameStr, _) = cleanName(tDef[0][0])
        typeName = nameStr
      else:
        let (nameStr, _) = cleanName(tDef[0])
        typeName = nameStr
      let isRef = tDef[2].kind == nnkRefTy or tDef[2].repr.contains("ref object")
      var fields: seq[TsTypeField] = @[]
      var objNode = tDef[2]
      if objNode.kind == nnkRefTy and objNode.len > 0:
        objNode = objNode[0]
      if objNode.kind == nnkObjectTy and objNode.len > 2 and objNode[2].kind == nnkRecList:
        for identDefs in objNode[2]:
          if identDefs.kind == nnkIdentDefs:
            let fType = identDefs[^2].repr.strip()
            let fTsType = mapNimTypeToTs(fType)
            for k in 0 ..< identDefs.len - 2:
              let (fName, _) = cleanName(identDefs[k])
              fields.add(TsTypeField(name: fName, tsType: fTsType))
      gExportedTypes.add(TsType(name: typeName, isHandle: isRef, fields: fields))
  else:
    result.add(body)

macro exportTs*(args: varargs[untyped]): untyped =
  if args.len == 0:
    return newEmptyNode()
  if args.len == 1:
    let target = args[0]
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
  else:
    let target = args[^1]
    var specifiedMod = ""
    for k in 0 ..< args.len - 1:
      let a = args[k]
      if (a.kind in [nnkExprColonExpr, nnkExprEqExpr]) and a.len > 1:
        if a[0].strVal == "module":
          specifiedMod = if a[1].kind == nnkStrLit: a[1].strVal else: a[1].repr.strip(chars = {'"'})
      elif a.kind == nnkStrLit:
        specifiedMod = a.strVal
    let prevMod = gModuleName
    if specifiedMod.len > 0:
      gModuleName = specifiedMod
    result = processExportTs(target)
    gModuleName = prevMod

template audioProcess*() {.pragma.}

macro exporttsWorklet*(args: varargs[untyped]): untyped =
  ## Macro pragma for marking an AudioWorklet real-time audio process callback
  if args.len == 0: return newEmptyNode()
  let target = args[^1]
  if target.kind == nnkProcDef:
    var procDef = target
    var newPragmas = newNimNode(nnkPragma)
    if procDef[4].kind == nnkPragma:
      for p in procDef[4]: newPragmas.add(p)
    newPragmas.add(ident("audioProcess"))
    procDef[4] = newPragmas
    result = processExportTs(procDef)
  else:
    result = processExportTs(target)


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

  var symbols: seq[string] = @[
    "NimMain",
    "nimts_init",
    "nimts_alloc",
    "nimts_free",
    "nimts_alloc_aligned",
    "nimts_free_aligned",
    "nimts_get_last_result_ptr",
    "nimts_get_last_result_len",
    "nimts_get_last_error_ptr",
    "nimts_get_last_error_len",
    "nimts_destroy_handle",
    "nimts_resume_future",
    "nimts_resume_future_error",
    "nimts_iter_step",
    "nimts_iter_finished",
    "nimts_iter_dispose",
    "nimts_chan_is_closed",
    "nimts_chan_try_recv",
    "nimts_chan_read",
    "nimts_chan_close",
    "nimts_chan_send",
    "nimts_chan_get_raw_ptrs"
  ]
  for p in gExportedProcs:
    if p.cabiName notin symbols:
      symbols.add(p.cabiName)

  var audioProcessCabi = ""
  for p in gExportedProcs:
    if p.isAudioProcess:
      audioProcessCabi = p.cabiName
      break

  var manifest = %* {
    "module": moduleName,
    "symbols": symbols
  }
  if audioProcessCabi.len > 0:
    manifest["audioProcess"] = %audioProcessCabi

  let manifestPath = outputDir & "/_nimts_exports.json"
  writeFile(manifestPath, pretty(manifest))
  result = newEmptyNode()


proc getExportedProcsCount*(): int {.compileTime.} = gExportedProcs.len
proc getExportedTypesCount*(): int {.compileTime.} = gExportedTypes.len
proc getExportedProcs*(): seq[TsProc] {.compileTime.} = gExportedProcs
proc resetExportedRegistrations*() {.compileTime.} =
  gExportedProcs = @[]
  gExportedTypes = @[]
  gProcCounts.clear()
  gModuleName = ""

