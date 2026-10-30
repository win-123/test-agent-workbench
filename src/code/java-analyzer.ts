import { randomBytes } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import JSZip from 'jszip'
import { parseClassFile } from './classfile.ts'
import {
  JAVA_ANALYSIS_SCHEMA_VERSION,
  type CodeEvidence,
  type JavaAnalysis,
  type JavaAnalysisLimits,
  type JavaBranch,
  type JavaBranchKind,
  type JavaCall,
  type JavaClassInfo,
  type JavaEndpoint,
  type JavaException,
  type JavaMethodInfo,
  type JavaParameter,
  type JavaUncertainty,
  type WarEntryInfo,
} from './types.ts'

const DEFAULTS = {
  maxSourceFiles: 2_000,
  maxSourceBytes: 20 * 1024 * 1024,
  maxArchiveEntries: 20_000,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxClasses: 500,
} as const

interface SourceFile {
  absolute: string
  relative: string
  content: string
  masked: string
}

interface SourceClassResult {
  classInfo: JavaClassInfo
  endpoints: JavaEndpoint[]
  branches: JavaBranch[]
  exceptions: JavaException[]
  calls: JavaCall[]
  uncertainties: JavaUncertainty[]
}

export async function analyzeJavaInput(inputPath: string, limits: JavaAnalysisLimits = {}): Promise<JavaAnalysis> {
  const canonical = await realpath(inputPath)
  const info = await stat(canonical)
  if (info.isDirectory()) return await analyzeJavaSource(canonical, limits)
  if (!info.isFile()) throw new Error('Java analysis input must be a source directory, WAR, or class file')
  if (extname(canonical).toLowerCase() === '.war') return await analyzeWar(canonical, limits)
  if (extname(canonical).toLowerCase() === '.class') {
    return await analyzeSingleClass(canonical, limits)
  }
  throw new Error('Java analysis supports a source directory, .war, or .class input')
}

export async function analyzeJavaSource(inputPath: string, limits: JavaAnalysisLimits = {}): Promise<JavaAnalysis> {
  const root = await realpath(inputPath)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error('Java source input must be a directory')
  const effective = { ...DEFAULTS, ...limits }
  const files: SourceFile[] = []
  let totalBytes = 0
  const buildFiles: string[] = []
  const frameworks = new Set<string>()
  await walkSource(root, root, files, buildFiles, effective, () => totalBytes, bytes => {
    totalBytes += bytes
  })
  if (files.length === 0) throw new Error('no Java source files were found')

  const classes: JavaClassInfo[] = []
  const endpoints: JavaEndpoint[] = []
  const branches: JavaBranch[] = []
  const exceptions: JavaException[] = []
  const calls: JavaCall[] = []
  const uncertainties: JavaUncertainty[] = []
  const methodNames = new Set<string>()
  const parsed: SourceClassResult[] = []
  for (const file of files) {
    const result = parseJavaSource(file)
    parsed.push(result)
    for (const method of result.classInfo.methods) methodNames.add(method.name)
  }
  for (const result of parsed) {
    for (const call of result.calls) {
      call.resolved = methodNames.has(call.target.split('.').at(-1) ?? '')
    }
    if (result.classInfo.annotations.some(annotation => /spring/i.test(annotation))) frameworks.add('Spring')
    classes.push(result.classInfo)
    endpoints.push(...result.endpoints)
    branches.push(...result.branches)
    exceptions.push(...result.exceptions)
    calls.push(...result.calls)
    uncertainties.push(...result.uncertainties)
  }
  const packages = [...new Set(classes.map(item => item.package).filter(Boolean))].sort()
  for (const file of files) {
    const imports = [...file.content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)].map(match => match[1] ?? '')
    if (imports.some(item => item.startsWith('org.springframework'))) frameworks.add('Spring')
    if (imports.some(item => item.startsWith('jakarta.servlet') || item.startsWith('javax.servlet'))) frameworks.add('Servlet')
  }
  return {
    schema_version: JAVA_ANALYSIS_SCHEMA_VERSION,
    analysis_id: analysisId('source'),
    mode: 'source',
    input: basename(root),
    generated_at: new Date().toISOString(),
    structure: {
      root: basename(root),
      source_roots: sourceRoots(files),
      source_files: files.length,
      packages,
      build_files: [...new Set(buildFiles)].sort(),
      frameworks: [...frameworks].sort(),
    },
    classes,
    endpoints,
    branches,
    exceptions,
    calls,
    uncertainties: uniqueUncertainties(uncertainties),
    coverage: {
      measured: false,
      note: 'No runtime coverage data was supplied. Branch lists are static candidates, not measured coverage.',
    },
  }
}

export async function analyzeWar(inputPath: string, limits: JavaAnalysisLimits = {}): Promise<JavaAnalysis> {
  const effective = { ...DEFAULTS, ...limits }
  const info = await stat(inputPath)
  if (!info.isFile()) throw new Error('WAR input must be a file')
  if (info.size > effective.maxArchiveBytes) throw new Error(`WAR exceeds the ${effective.maxArchiveBytes} byte analysis limit`)
  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(await readFile(inputPath), { checkCRC32: true })
  } catch (error) {
    throw new Error(`invalid WAR archive: ${(error as Error).message}`)
  }
  const zipEntries = Object.values(archive.files).filter(entry => !entry.dir)
  if (zipEntries.length > effective.maxArchiveEntries) {
    throw new Error(`WAR contains ${zipEntries.length} entries; limit is ${effective.maxArchiveEntries}`)
  }
  let totalBytes = 0
  const files: WarEntryInfo[] = []
  const safeEntries = new Map<string, JSZip.JSZipObject>()
  for (const entry of zipEntries) {
    const normalized = normalizeArchivePath(entry.name)
    const uncompressed = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)
    totalBytes += uncompressed
    if (totalBytes > effective.maxArchiveBytes) throw new Error(`WAR expands beyond the ${effective.maxArchiveBytes} byte analysis limit`)
    const kind = classifyArchiveEntry(normalized)
    files.push({ path: normalized, bytes: uncompressed, kind })
    safeEntries.set(normalized, entry)
  }
  const classes: JavaClassInfo[] = []
  const branches: JavaBranch[] = []
  const calls: JavaCall[] = []
  const exceptions: JavaException[] = []
  const uncertainties: JavaUncertainty[] = []
  const frameworks = new Set<string>()
  let parsedClasses = 0
  for (const file of files) {
    if (file.kind !== 'class' || !file.path.startsWith('WEB-INF/classes/')) continue
    if (parsedClasses >= effective.maxClasses) {
      uncertainties.push({
        kind: 'bytecode-limit',
        message: `Only the first ${effective.maxClasses} WEB-INF/classes entries were analyzed.`,
      })
      break
    }
    const entry = safeEntries.get(file.path)!
    try {
      const parsed = parseClassFile(await entry.async('nodebuffer'), file.path)
      parsedClasses += 1
      const classInfo = classFromBytecode(parsed, file.path)
      classes.push(classInfo)
      branches.push(...parsed.branches)
      calls.push(...parsed.calls)
      exceptions.push(...parsed.exceptions)
      if (parsed.annotationDescriptors.some(item => item.startsWith('org.springframework'))) frameworks.add('Spring')
      if (parsed.interfaces.some(item => item.includes('servlet'))) frameworks.add('Servlet')
    } catch (error) {
      uncertainties.push({
        kind: 'unsupported-syntax',
        message: `Could not parse class metadata: ${basename(file.path)}: ${(error as Error).message}`,
        evidence: { file: file.path },
      })
    }
  }
  const jars = files.filter(file => file.kind === 'jar')
  if (jars.length > 0) {
    uncertainties.push({
      kind: 'missing-dependency',
      message: `${jars.length} nested JAR(s) were inventoried but not introspected. Calls into those dependencies remain unresolved.`,
    })
  }
  if (classes.length > 0 && classes.filter(item => item.name.split('.').at(-1)!.length <= 2).length / classes.length > 0.5) {
    uncertainties.push({ kind: 'obfuscation', message: 'Most class names are very short; bytecode may be obfuscated and source-level names are unavailable.' })
  }
  if (classes.length === 0) {
    uncertainties.push({ kind: 'missing-dependency', message: 'No parseable classes were found under WEB-INF/classes; the WAR may use an unusual layout or only contain dependencies.' })
  }
  if (classes.some(item => item.annotations.length > 0 || item.methods.some(method => method.annotations.length > 0))) {
    uncertainties.push({
      kind: 'bytecode-limit',
      message: 'Framework annotations are visible in bytecode, but annotation arguments are not reconstructed; endpoint paths are intentionally not inferred.',
    })
  }
  const manifest = files.find(file => file.path === 'META-INF/MANIFEST.MF')
  return {
    schema_version: JAVA_ANALYSIS_SCHEMA_VERSION,
    analysis_id: analysisId('war'),
    mode: 'war',
    input: basename(inputPath),
    generated_at: new Date().toISOString(),
    structure: {
      root: basename(inputPath),
      source_roots: [],
      source_files: 0,
      packages: [...new Set(classes.map(item => item.package).filter(Boolean))].sort(),
      build_files: manifest === undefined ? [] : [manifest.path],
      frameworks: [...frameworks].sort(),
    },
    classes,
    endpoints: [],
    branches,
    exceptions,
    calls,
    uncertainties: uniqueUncertainties(uncertainties),
    archive: {
      entries: files.length,
      bytes: totalBytes,
      class_files: files.filter(file => file.kind === 'class').length,
      jars: jars.length,
      config_files: files.filter(file => file.kind === 'config').slice(0, 500).map(file => file.path),
      files: files.slice(0, 5_000),
    },
    coverage: {
      measured: false,
      note: 'WAR analysis is bytecode-static. No runtime coverage data exists, and dynamic or dependency-internal calls may be missing.',
    },
  }
}

async function analyzeSingleClass(inputPath: string, limits: JavaAnalysisLimits): Promise<JavaAnalysis> {
  const effective = { ...DEFAULTS, ...limits }
  const info = await stat(inputPath)
  if (info.size > effective.maxArchiveBytes) throw new Error('class file exceeds the analysis limit')
  const parsed = parseClassFile(await readFile(inputPath), basename(inputPath))
  const classInfo = classFromBytecode(parsed, basename(inputPath))
  return {
    schema_version: JAVA_ANALYSIS_SCHEMA_VERSION,
    analysis_id: analysisId('class'),
    mode: 'war',
    input: basename(inputPath),
    generated_at: new Date().toISOString(),
    structure: {
      root: basename(inputPath),
      source_roots: [],
      source_files: 0,
      packages: classInfo.package === '' ? [] : [classInfo.package],
      build_files: [],
      frameworks: [],
    },
    classes: [classInfo],
    endpoints: [],
    branches: parsed.branches,
    exceptions: parsed.exceptions,
    calls: parsed.calls,
    uncertainties: [{
      kind: 'bytecode-limit',
      message: 'A standalone class file has no surrounding application metadata or dependencies; endpoint inference is intentionally disabled.',
    }],
    coverage: { measured: false, note: 'No runtime coverage data was supplied.' },
  }
}

function parseJavaSource(file: SourceFile): SourceClassResult {
  const classMatch = /\b(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/.exec(file.masked)
  if (classMatch === null) {
    return {
      classInfo: {
        name: basename(file.relative, '.java'),
        package: '',
        kind: 'unknown',
        file: file.relative,
        annotations: [],
        interfaces: [],
        methods: [],
        confidence: 'uncertain',
      },
      endpoints: [],
      branches: [],
      exceptions: [],
      calls: [],
      uncertainties: [{ kind: 'unsupported-syntax', message: 'No class declaration could be parsed.', evidence: { file: file.relative } }],
    }
  }
  const packageName = /\bpackage\s+([\w.]+)\s*;/.exec(file.masked)?.[1] ?? ''
  const simpleName = classMatch[2]!
  const className = packageName === '' ? simpleName : `${packageName}.${simpleName}`
  const lineStarts = buildLineStarts(file.masked)
  const classLine = lineForOffset(lineStarts, classMatch.index)
  const classAnnotations = annotationsBefore(file, classLine)
  const classOpen = file.masked.indexOf('{', classMatch.index + classMatch[0].length)
  if (classOpen < 0) throw new Error(`cannot locate class body: ${file.relative}`)
  const classClose = matchingBrace(file.masked, classOpen)
  const classBody = file.masked.slice(classOpen + 1, classClose)
  const bodyOffset = classOpen + 1
  const methodMatches = findMethodSignatures(classBody)
  const methods: JavaMethodInfo[] = []
  const endpoints: JavaEndpoint[] = []
  const branches: JavaBranch[] = []
  const exceptions: JavaException[] = []
  const calls: JavaCall[] = []
  const uncertainties: JavaUncertainty[] = []
  const controller = classAnnotations.some(annotation => /^(RestController|Controller)$/.test(annotation.name))
  const classMapping = annotationPath(classAnnotations.find(annotation => annotation.name === 'RequestMapping'))
  for (const match of methodMatches) {
    const methodRelativeLine = lineForOffset(lineStarts, bodyOffset + match.index)
    const annotations = annotationsBefore(file, methodRelativeLine)
    const annotationText = annotations.map(annotation => `@${annotation.name}${annotation.args === undefined ? '' : `(${annotation.args})`}`)
    const parameters = parseParameters(match.parameters, annotations)
    const open = bodyOffset + match.index + match.signature.lastIndexOf('{')
    const close = matchingBrace(file.masked, open)
    const body = file.masked.slice(open + 1, close)
    const bodyStartLine = lineForOffset(lineStarts, open + 1)
    const endLine = lineForOffset(lineStarts, close)
    const methodCalls = findCalls(file, open + 1, body, bodyStartLine, className, match.name)
    const methodBranches = findBranches(file, body, bodyStartLine, className, match.name, methodCalls)
    const methodExceptions = findExceptions(file, body, bodyStartLine, className, match.name)
    const method: JavaMethodInfo = {
      class_name: className,
      name: match.name,
      signature: `${match.name}(${match.parameters})`,
      file: file.relative,
      line: methodRelativeLine,
      end_line: endLine,
      parameters,
      annotations: annotationText,
      calls: methodCalls,
      branches: methodBranches,
      exceptions: methodExceptions,
      confidence: 'static',
    }
    methods.push(method)
    calls.push(...methodCalls)
    branches.push(...methodBranches)
    exceptions.push(...methodExceptions)
    const httpMethod = endpointMethod(annotations)
    if (controller && httpMethod !== undefined) {
      const methodMapping = annotationPath(annotations.find(annotation => endpointMethod([annotation]) !== undefined))
      endpoints.push({
        http_method: httpMethod,
        path: combinePaths(classMapping, methodMapping),
        class_name: className,
        method: match.name,
        parameters,
        request_body: parameters.some(parameter => parameter.annotations.some(annotation => annotation.endsWith('RequestBody'))),
        evidence: { file: file.relative, line: methodRelativeLine, class_name: className, method: match.name },
      })
    }
  }
  if (methods.length === 0) uncertainties.push({ kind: 'unsupported-syntax', message: 'No method signatures were parsed.', evidence: { file: file.relative, line: classLine, class_name: className } })
  if (/Class\.forName|\.getMethod\s*\(|\.invoke\s*\(|MethodHandles|Proxy\.newProxyInstance/.test(file.content)) {
    uncertainties.push({ kind: 'reflection', message: 'Reflection or dynamic proxy APIs were found; static call edges may be incomplete.', evidence: { file: file.relative, class_name: className } })
  }
  if (/\b(sendRedirect|ResponseEntity|ModelAndView)\b/.test(file.content) && controller) {
    uncertainties.push({ kind: 'unsupported-syntax', message: 'Controller return values may alter runtime routing; static endpoint paths are declaration evidence only.', evidence: { file: file.relative, class_name: className } })
  }
  return {
    classInfo: {
      name: className,
      package: packageName,
      kind: classKind(classMatch[1]!),
      file: file.relative,
      line: classLine,
      annotations: classAnnotations.map(annotation => `@${annotation.name}`),
      interfaces: [],
      methods,
      confidence: 'static',
    },
    endpoints,
    branches,
    exceptions,
    calls,
    uncertainties,
  }
}

interface AnnotationInfo {
  name: string
  args?: string
}

function annotationsBefore(file: SourceFile, line: number): AnnotationInfo[] {
  const lines = file.content.split(/\r?\n/)
  const collected: string[] = []
  let index = Math.max(0, line - 1)
  if (index < lines.length) collected.unshift(lines[index] ?? '')
  index -= 1
  while (index >= 0 && collected.length < 20) {
    const value = lines[index] ?? ''
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.startsWith('//')) {
      index -= 1
      continue
    }
    if (trimmed.startsWith('@') || trimmed.startsWith(')') || trimmed.endsWith(')') || trimmed.includes('= {') || trimmed.startsWith('"')) {
      collected.unshift(value)
      index -= 1
      continue
    }
    break
  }
  const text = collected.join('\n')
  const matches = [...text.matchAll(/@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*\(([\s\S]*?)\))?/g)]
  return matches.map(match => ({ name: match[1] ?? '', args: match[2]?.trim() })).filter(item => item.name.length > 0)
}

function parseParameters(raw: string, methodAnnotations: AnnotationInfo[]): JavaParameter[] {
  if (raw.trim().length === 0) return []
  return splitTopLevel(raw).map((item, index) => {
    const annotations = [...item.matchAll(/@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)].map(match => match[1] ?? '')
    const withoutAnnotations = item.replace(/@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*\([^)]*\))?/g, '').trim()
    const parts = withoutAnnotations.split(/\s+/).filter(Boolean)
    const name = parts.at(-1) ?? `arg${index}`
    const type = parts.slice(0, -1).join(' ') || 'unknown'
    return { name, type, annotations }
  }).filter(parameter => !methodAnnotations.some(annotation => annotation.name === 'RequestParam' && parameter.name === 'required'))
}

function findMethodSignatures(body: string): Array<{ index: number; name: string; parameters: string; signature: string }> {
  const pattern = /(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?([A-Za-z_$][\w$<>,.?\[\]\s]*?)\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{]+)?\{/g
  const results: Array<{ index: number; name: string; parameters: string; signature: string }> = []
  for (const match of body.matchAll(pattern)) {
    const name = match[2] ?? ''
    if (['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try'].includes(name)) continue
    results.push({ index: match.index, name, parameters: match[3] ?? '', signature: match[0] })
  }
  return results
}

function findCalls(file: SourceFile, bodyOffset: number, body: string, bodyStartLine: number, className: string, methodName: string): JavaCall[] {
  const calls: JavaCall[] = []
  const pattern = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\(/g
  for (const match of body.matchAll(pattern)) {
    const target = match[1] ?? ''
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'assert', 'super', 'this'].includes(target)) continue
    if (target === methodName) continue
    const line = bodyStartLine + countNewlines(body.slice(0, match.index))
    const argumentText = balancedCallArguments(body, (match.index ?? 0) + match[0].length - 1)
    calls.push({
      caller_class: className,
      caller_method: methodName,
      target,
      line,
      resolved: false,
      dynamic: /^(Class|Method|MethodHandle|Proxy)$/.test(target),
      ...argumentText === undefined ? {} : {
        arguments: splitTopLevel(argumentText).map(argument => argument.trim().slice(0, 300)).slice(0, 20),
        parameter_evidence: 'source-text',
      },
      evidence: { file: file.relative, line, class_name: className, method: methodName },
    })
  }
  return calls.slice(0, 500)
}


function balancedCallArguments(source: string, openOffset: number): string | undefined {
  if (source[openOffset] !== '(') return undefined
  let depth = 0
  let inString = false
  let inChar = false
  let escaped = false
  for (let index = openOffset; index < source.length; index += 1) {
    const value = source[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if ((inString || inChar) && value === '\\') {
      escaped = true
      continue
    }
    if (inString && value === '"') inString = false
    else if (inChar && value === "'") inChar = false
    else if (!inString && !inChar && value === '"') inString = true
    else if (!inString && !inChar && value === "'") inChar = true
    else if (!inString && !inChar && value === '(') depth += 1
    else if (!inString && !inChar && value === ')') {
      depth -= 1
      if (depth === 0) return source.slice(openOffset + 1, index)
    }
  }
  return undefined
}
function findBranches(file: SourceFile, body: string, bodyStartLine: number, className: string, methodName: string, calls: JavaCall[]): JavaBranch[] {
  const branches: JavaBranch[] = []
  const lines = body.split(/\r?\n/)
  lines.forEach((line, index) => {
    const lineNumber = bodyStartLine + index
    const checks: Array<{ kind: JavaBranchKind; condition: string }> = []
    const ifMatch = /\bif\s*\(([^)]*)\)/.exec(line)
    if (ifMatch !== null) checks.push({ kind: 'if', condition: ifMatch[1]?.trim() ?? '' })
    if (/\belse\b/.test(line) && ifMatch === null) checks.push({ kind: 'else', condition: 'else branch' })
    const switchMatch = /\bswitch\s*\(([^)]*)\)/.exec(line)
    if (switchMatch !== null) checks.push({ kind: 'switch', condition: switchMatch[1]?.trim() ?? '' })
    const caseMatch = /\bcase\s+([^:]+):/.exec(line)
    if (caseMatch !== null) checks.push({ kind: 'case', condition: caseMatch[1]?.trim() ?? '' })
    const loopMatch = /\b(for|while)\s*\(([^)]*)\)/.exec(line)
    if (loopMatch !== null) checks.push({ kind: 'loop', condition: loopMatch[2]?.trim() ?? '' })
    if (line.includes('?') && line.includes(':')) checks.push({ kind: 'ternary', condition: line.trim() })
    for (const check of checks) {
      branches.push({
        id: `branch-${branches.length + 1}`,
        class_name: className,
        method: methodName,
        kind: check.kind,
        line: lineNumber,
        condition: check.condition,
        risk: calls.some(call => call.line !== undefined && Math.abs(call.line - lineNumber) <= 3) || /\bthrow\b/.test(line) ? 'high' : 'medium',
        evidence: { file: file.relative, line: lineNumber, class_name: className, method: methodName },
      })
    }
  })
  return branches.slice(0, 500)
}

function findExceptions(file: SourceFile, body: string, bodyStartLine: number, className: string, methodName: string): JavaException[] {
  const exceptions: JavaException[] = []
  const lines = body.split(/\r?\n/)
  lines.forEach((line, index) => {
    const lineNumber = bodyStartLine + index
    const thrown = /\bthrow\s+new\s+([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)/.exec(line)
    if (thrown !== null) {
      exceptions.push({
        class_name: className,
        method: methodName,
        kind: 'throw',
        line: lineNumber,
        type: thrown[1],
        message: thrown[2] ?? '',
        evidence: { file: file.relative, line: lineNumber, class_name: className, method: methodName },
      })
    }
    const caught = /\bcatch\s*\(\s*([A-Za-z_$][\w$.]*)(?:\s+\w+)?\s*\)/.exec(line)
    if (caught !== null) {
      exceptions.push({
        class_name: className,
        method: methodName,
        kind: 'catch',
        line: lineNumber,
        type: caught[1],
        message: 'catch block',
        evidence: { file: file.relative, line: lineNumber, class_name: className, method: methodName },
      })
    }
  })
  return exceptions.slice(0, 500)
}

function classFromBytecode(parsed: ReturnType<typeof parseClassFile>, file: string): JavaClassInfo {
  const packageName = parsed.name.includes('.') ? parsed.name.slice(0, parsed.name.lastIndexOf('.')) : ''
  const methods = parsed.methods.map(method => ({ ...method, file }))
  return {
    name: parsed.name,
    package: packageName,
    kind: (parsed.accessFlags & 0x0200) !== 0 ? 'interface' : (parsed.accessFlags & 0x4000) !== 0 ? 'enum' : 'class',
    file,
    annotations: parsed.annotationDescriptors.map(item => `@${item.split('.').at(-1) ?? item}`),
    super_class: parsed.superName,
    interfaces: parsed.interfaces,
    methods,
    confidence: 'bytecode',
  }
}

function classKind(value: string): JavaClassInfo['kind'] {
  if (value === 'interface' || value === 'enum' || value === 'record' || value === '@interface') return value === '@interface' ? 'annotation' : value
  return value === 'class' ? 'class' : 'unknown'
}

function endpointMethod(annotations: AnnotationInfo[]): string | undefined {
  const mapping: Record<string, string> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    PatchMapping: 'PATCH',
    DeleteMapping: 'DELETE',
    RequestMapping: 'ANY',
  }
  return annotations.map(annotation => mapping[annotation.name.split('.').at(-1) ?? '']).find(Boolean)
}

function annotationPath(annotation: AnnotationInfo | undefined): string | undefined {
  if (annotation?.args === undefined) return undefined
  const direct = /"(\/[^"]*)"/.exec(annotation.args)
  return direct?.[1]
}

function combinePaths(base: string | undefined, method: string | undefined): string {
  const left = (base ?? '').replace(/\/+$/, '')
  const right = (method ?? '').replace(/^\/+/, '')
  if (right.length === 0) return left.length === 0 ? '/' : left
  const combined = `${left}/${right}`.replace(/\/+/g, '/')
  return combined.startsWith('/') ? combined : `/${combined}`
}

async function walkSource(
  root: string,
  directory: string,
  files: SourceFile[],
  buildFiles: string[],
  limits: Required<JavaAnalysisLimits>,
  totalBytes: () => number,
  addBytes: (bytes: number) => void,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (['.git', 'target', 'build', 'node_modules', '.gradle', 'out'].includes(entry.name)) continue
      await walkSource(root, join(directory, entry.name), files, buildFiles, limits, totalBytes, addBytes)
      continue
    }
    if (!entry.isFile()) continue
    const path = join(directory, entry.name)
    const fileInfo = await lstat(path)
    const relativePath = relative(root, path).split('\\').join('/')
    if (fileInfo.size > limits.maxSourceBytes) continue
    if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(entry.name)) {
      buildFiles.push(relativePath)
    }
    if (!entry.name.endsWith('.java')) continue
    if (files.length >= limits.maxSourceFiles) throw new Error(`Java source file limit ${limits.maxSourceFiles} exceeded`)
    const canonical = await realpath(path)
    if (!canonical.startsWith(`${root}/`) && canonical !== root) throw new Error(`source path escapes repository: ${relativePath}`)
    const content = await readFile(path, 'utf8')
    const bytes = Buffer.byteLength(content)
    if (totalBytes() + bytes > limits.maxSourceBytes) throw new Error(`Java source byte limit ${limits.maxSourceBytes} exceeded`)
    addBytes(bytes)
    files.push({ absolute: path, relative: relativePath, content, masked: maskJava(content) })
  }
}

function maskJava(input: string): string {
  const output: string[] = new Array(input.length)
  let state: 'normal' | 'line' | 'block' | 'string' | 'char' | 'textblock' = 'normal'
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]!
    const next = input[index + 1]
    if (value === '\n' || value === '\r') {
      if (state === 'line') state = 'normal'
      output[index] = value
      continue
    }
    if (state === 'line') {
      output[index] = ' '
      continue
    }
    if (state === 'block') {
      if (value === '*' && next === '/') {
        output[index] = ' '
        output[index + 1] = ' '
        index += 1
        state = 'normal'
      } else output[index] = ' '
      continue
    }
    if (state === 'string' || state === 'char') {
      output[index] = ' '
      if (value === '\\') {
        output[index + 1] = ' '
        index += 1
      } else if ((state === 'string' && value === '"') || (state === 'char' && value === "'")) state = 'normal'
      continue
    }
    if (state === 'textblock') {
      if (value === '"' && next === '"' && input[index + 2] === '"') {
        output[index] = output[index + 1] = output[index + 2] = ' '
        index += 2
        state = 'normal'
      } else output[index] = ' '
      continue
    }
    if (value === '/' && next === '/') {
      output[index] = output[index + 1] = ' '
      index += 1
      state = 'line'
    } else if (value === '/' && next === '*') {
      output[index] = output[index + 1] = ' '
      index += 1
      state = 'block'
    } else if (value === '"' && next === '"' && input[index + 2] === '"') {
      output[index] = output[index + 1] = output[index + 2] = ' '
      index += 2
      state = 'textblock'
    } else if (value === '"') {
      output[index] = ' '
      state = 'string'
    } else if (value === "'") {
      output[index] = ' '
      state = 'char'
    } else output[index] = value
  }
  return output.join('')
}

function sourceRoots(files: SourceFile[]): string[] {
  const candidates = ['src/main/java', 'src/test/java', 'src/main/kotlin', 'src']
  return candidates.filter(candidate => files.some(file => file.relative.startsWith(`${candidate}/`)))
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`unsafe WAR entry path: ${path}`)
  }
  return normalized
}

function classifyArchiveEntry(path: string): WarEntryInfo['kind'] {
  if (path.endsWith('.class')) return 'class'
  if (path.endsWith('.jar')) return 'jar'
  if (/\.(xml|properties|ya?ml|json|conf|cfg)$/i.test(path) || path === 'META-INF/MANIFEST.MF') return 'config'
  return 'resource'
}

function uniqueUncertainties(values: JavaUncertainty[]): JavaUncertainty[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = `${value.kind}:${value.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '<' || character === '(' || character === '[') depth += 1
    else if (character === '>' || character === ')' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function matchingBrace(value: string, open: number): number {
  let depth = 0
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1
    else if (value[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error('unbalanced Java braces')
}

function buildLineStarts(value: string): number[] {
  const starts = [0]
  for (let index = 0; index < value.length; index += 1) if (value[index] === '\n') starts.push(index + 1)
  return starts
}

function lineForOffset(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle]! <= offset) low = middle + 1
    else high = middle - 1
  }
  return high + 1
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length
}

function analysisId(prefix: string): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`
}
