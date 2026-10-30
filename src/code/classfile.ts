import type { JavaBranch, JavaCall, JavaException, JavaMethodInfo } from './types.ts'

export interface ParsedClassFile {
  name: string
  superName?: string
  interfaces: string[]
  accessFlags: number
  majorVersion: number
  methods: JavaMethodInfo[]
  branches: JavaBranch[]
  calls: JavaCall[]
  exceptions: JavaException[]
  annotationDescriptors: string[]
}

interface ConstantPoolEntry {
  tag: number
  value?: string
  refA?: number
  refB?: number
  nameIndex?: number
  descriptorIndex?: number
}

interface MethodAttribute {
  name: string
  bytes: Buffer
}

interface ExceptionTableEntry {
  startPc: number
  endPc: number
  handlerPc: number
  catchType: number
}

export function parseClassFile(buffer: Buffer, file: string): ParsedClassFile {
  const reader = new ClassReader(buffer)
  if (reader.u4() !== 0xcafebabe) throw new Error('invalid class file magic')
  reader.u2()
  const majorVersion = reader.u2()
  const constantPoolCount = reader.u2()
  const pool: Array<ConstantPoolEntry | undefined> = new Array(constantPoolCount)
  for (let index = 1; index < constantPoolCount; index += 1) {
    const tag = reader.u1()
    if (tag === 1) pool[index] = { tag, value: reader.utf8() }
    else if (tag === 3 || tag === 4) pool[index] = { tag, refA: reader.u4() }
    else if (tag === 5 || tag === 6) {
      pool[index] = { tag, refA: reader.u4() }
      index += 1
    } else if (tag === 7) pool[index] = { tag, nameIndex: reader.u2() }
    else if (tag === 8) pool[index] = { tag, nameIndex: reader.u2() }
    else if (tag === 9 || tag === 10 || tag === 11) {
      const classIndex = reader.u2()
      const nameAndTypeIndex = reader.u2()
      pool[index] = { tag, refA: classIndex, refB: nameAndTypeIndex }
    } else if (tag === 12) {
      const nameIndex = reader.u2()
      const descriptorIndex = reader.u2()
      pool[index] = { tag, nameIndex, descriptorIndex }
    } else if (tag === 15) {
      reader.u1()
      reader.u2()
      pool[index] = { tag }
    } else if (tag === 16) {
      pool[index] = { tag, nameIndex: reader.u2() }
    } else if (tag === 17 || tag === 18) {
      reader.u2()
      reader.u2()
      pool[index] = { tag }
    } else if (tag === 19 || tag === 20) {
      pool[index] = { tag, nameIndex: reader.u2() }
    } else {
      throw new Error(`unsupported class constant pool tag: ${tag}`)
    }
  }
  const accessFlags = reader.u2()
  const thisClassIndex = reader.u2()
  const superClassIndex = reader.u2()
  const interfaceCount = reader.u2()
  const interfaces = Array.from({ length: interfaceCount }, () => className(pool, reader.u2()))
  const classAnnotations: string[] = []
  const fieldsCount = reader.u2()
  for (let index = 0; index < fieldsCount; index += 1) {
    reader.u2()
    reader.u2()
    reader.u2()
    skipAttributes(reader)
  }

  const methodCount = reader.u2()
  const methods: JavaMethodInfo[] = []
  const branches: JavaBranch[] = []
  const calls: JavaCall[] = []
  const exceptions: JavaException[] = []
  const classNameValue = className(pool, thisClassIndex)
  for (let index = 0; index < methodCount; index += 1) {
    const flags = reader.u2()
    const name = utf8(pool, reader.u2())
    const descriptor = utf8(pool, reader.u2())
    const attributes: MethodAttribute[] = []
    const annotations: string[] = []
    const attributesCount = reader.u2()
    for (let attributeIndex = 0; attributeIndex < attributesCount; attributeIndex += 1) {
      const attributeName = utf8(pool, reader.u2())
      const length = reader.u4()
      const bytes = reader.bytes(length)
      attributes.push({ name: attributeName, bytes })
      if (attributeName === 'RuntimeVisibleAnnotations' || attributeName === 'RuntimeInvisibleAnnotations') {
        annotations.push(...parseAnnotationDescriptors(bytes))
      }
    }
    const code = attributes.find(attribute => attribute.name === 'Code')
    const parsedCode = code === undefined ? undefined : parseCodeAttribute(code.bytes, pool)
    const lineNumbers = parsedCode?.lines ?? []
    const firstLine = lineNumbers[0]?.line
    const method: JavaMethodInfo = {
      class_name: classNameValue,
      name,
      signature: `${name}${descriptor}`,
      descriptor,
      parameters: decodeDescriptorParameters(descriptor),
      annotations,
      calls: [],
      branches: [],
      exceptions: [],
      confidence: 'bytecode',
      ...firstLine === undefined ? {} : { line: firstLine, end_line: lineNumbers.at(-1)?.line },
    }
    if (parsedCode !== undefined) {
      const instructions = parseInstructions(parsedCode.instructions, pool)
      for (const instruction of instructions) {
        if (instruction.branch !== undefined) {
          const branch: JavaBranch = {
            id: `bytecode-${branches.length + 1}`,
            class_name: classNameValue,
            method: name,
            kind: instruction.branch,
            line: lineForPc(lineNumbers, instruction.pc),
            condition: `bytecode ${instruction.opcodeName}`,
            risk: 'medium',
            evidence: { file, line: lineForPc(lineNumbers, instruction.pc), class_name: classNameValue, method: name },
          }
          method.branches.push(branch)
          branches.push(branch)
        }
        if (instruction.call !== undefined) {
          const line = lineForPc(lineNumbers, instruction.pc)
          const call: JavaCall = {
            caller_class: classNameValue,
            caller_method: name,
            target: instruction.call.target,
            line,
            resolved: false,
            dynamic: instruction.opcodeName === 'invokedynamic',
            ...instruction.call.descriptor === undefined ? {} : {
              parameter_types: decodeDescriptorParameters(instruction.call.descriptor).map(parameter => parameter.type),
              parameter_evidence: 'bytecode-descriptor',
            },
            evidence: { file, line, class_name: classNameValue, method: name },
          }
          method.calls.push(call)
          calls.push(call)
        }
      }
      for (const exception of parsedCode.exceptions) {
        const evidence = {
          file,
          line: lineForPc(lineNumbers, exception.handlerPc),
          class_name: classNameValue,
          method: name,
        }
        const record: JavaException = {
          class_name: classNameValue,
          method: name,
          kind: 'catch',
          line: evidence.line,
          type: exception.catchType === 0 ? 'any' : className(pool, exception.catchType),
          message: 'bytecode exception handler',
          evidence,
        }
        method.exceptions.push(record)
        exceptions.push(record)
      }
    }
    if ((flags & 0x0400) !== 0) method.annotations.push('deprecated')
    methods.push(method)
  }

  const classAttributesCount = reader.u2()
  for (let index = 0; index < classAttributesCount; index += 1) {
    const attributeName = utf8(pool, reader.u2())
    const length = reader.u4()
    const bytes = reader.bytes(length)
    if (attributeName === 'RuntimeVisibleAnnotations' || attributeName === 'RuntimeInvisibleAnnotations') {
      classAnnotations.push(...parseAnnotationDescriptors(bytes))
    }
  }
  return {
    name: classNameValue,
    superName: superClassIndex === 0 ? undefined : className(pool, superClassIndex),
    interfaces,
    accessFlags,
    majorVersion,
    methods,
    branches,
    calls,
    exceptions,
    annotationDescriptors: classAnnotations,
  }
}

class ClassReader {
  private offset = 0
  private readonly buffer: Buffer

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  u1(): number {
    this.ensure(1)
    return this.buffer[this.offset++]!
  }

  u2(): number {
    this.ensure(2)
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  u4(): number {
    this.ensure(4)
    const value = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    return value
  }

  utf8(): string {
    const length = this.u2()
    this.ensure(length)
    const bytes = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return modifiedUtf8(bytes)
  }

  bytes(length: number): Buffer {
    this.ensure(length)
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(length: number): void {
    this.ensure(length)
    this.offset += length
  }

  get position(): number {
    return this.offset
  }

  seek(position: number): void {
    if (position < 0 || position > this.buffer.length) throw new Error('class file offset out of range')
    this.offset = position
  }

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) throw new Error('truncated class file')
  }
}

function skipAttributes(reader: ClassReader): void {
  const count = reader.u2()
  for (let index = 0; index < count; index += 1) {
    reader.u2()
    const length = reader.u4()
    reader.skip(length)
  }
}

function utf8(pool: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = pool[index]
  if (entry?.tag !== 1 || entry.value === undefined) throw new Error(`invalid UTF8 constant pool index: ${index}`)
  return entry.value
}

function className(pool: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = pool[index]
  if (entry?.tag !== 7 || entry.nameIndex === undefined) throw new Error(`invalid class constant pool index: ${index}`)
  return utf8(pool, entry.nameIndex).replace(/\//g, '.')
}

function methodReference(pool: Array<ConstantPoolEntry | undefined>, index: number): { target: string; descriptor?: string } {
  const entry = pool[index]
  if (entry === undefined || (entry.tag !== 10 && entry.tag !== 11) || entry.refA === undefined || entry.refB === undefined) {
    return { target: `constant-pool:${index}` }
  }
  const nameAndType = pool[entry.refB]
  if (nameAndType?.tag !== 12 || nameAndType.nameIndex === undefined || nameAndType.descriptorIndex === undefined) return { target: `constant-pool:${index}` }
  const descriptor = utf8(pool, nameAndType.descriptorIndex)
  return { target: `${className(pool, entry.refA)}.${utf8(pool, nameAndType.nameIndex)}`, descriptor }
}

function parseAnnotationDescriptors(bytes: Buffer): string[] {
  const descriptors: string[] = []
  const text = bytes.toString('latin1')
  const matches = text.match(/L[\\/A-Za-z0-9_$]+;/g) ?? []
  for (const match of matches) descriptors.push(match.slice(1, -1).replace(/\//g, '.'))
  return [...new Set(descriptors)]
}

function parseCodeAttribute(bytes: Buffer, pool: Array<ConstantPoolEntry | undefined>): {
  length: number
  instructions: Buffer
  exceptions: ExceptionTableEntry[]
  lines: Array<{ pc: number; line: number }>
} {
  const reader = new ClassReader(bytes)
  reader.u2()
  reader.u2()
  const codeLength = reader.u4()
  const instructions = reader.bytes(codeLength)
  const exceptionCount = reader.u2()
  const exceptions: ExceptionTableEntry[] = []
  for (let index = 0; index < exceptionCount; index += 1) {
    exceptions.push({
      startPc: reader.u2(),
      endPc: reader.u2(),
      handlerPc: reader.u2(),
      catchType: reader.u2(),
    })
  }
  const attributesCount = reader.u2()
  const lines: Array<{ pc: number; line: number }> = []
  for (let index = 0; index < attributesCount; index += 1) {
    const attributeName = utf8(pool, reader.u2())
    const length = reader.u4()
    const attribute = reader.bytes(length)
    if (attributeName !== 'LineNumberTable') continue
    const candidate = new ClassReader(attribute)
    try {
      const entries = candidate.u2()
      if (entries * 4 + 2 === length) {
        for (let lineIndex = 0; lineIndex < entries; lineIndex += 1) {
          lines.push({ pc: candidate.u2(), line: candidate.u2() })
        }
      }
    } catch {
      // Non-LineNumberTable attributes are intentionally ignored.
    }
  }
  return { length: codeLength, instructions, exceptions, lines }
}

function parseInstructions(bytes: Buffer, pool: Array<ConstantPoolEntry | undefined>): Array<{
  pc: number
  opcodeName: string
  branch?: JavaBranch['kind']
  call?: { target: string; descriptor?: string }
}> {
  const result: Array<{ pc: number; opcodeName: string; branch?: JavaBranch['kind']; call?: { target: string; descriptor?: string } }> = []
  let pc = 0
  while (pc < bytes.length) {
    const opcode = bytes[pc]!
    const name = OPCODE_NAMES[opcode] ?? `opcode_${opcode.toString(16)}`
    if (opcode === 0xaa || opcode === 0xab) {
      const tableStart = pc + 1 + ((4 - ((pc + 1) % 4)) % 4)
      if (tableStart + 12 > bytes.length) break
      if (opcode === 0xaa) {
        const low = bytes.readInt32BE(tableStart + 4)
        const high = bytes.readInt32BE(tableStart + 8)
        const length = tableStart - pc + 12 + (high - low + 1) * 4
        result.push({ pc, opcodeName: name, branch: 'switch' })
        pc += Math.max(1, length)
      } else {
        const pairs = bytes.readInt32BE(tableStart + 4)
        const length = tableStart - pc + 8 + pairs * 8
        result.push({ pc, opcodeName: name, branch: 'switch' })
        pc += Math.max(1, length)
      }
      continue
    }
    if (opcode === 0xc4) {
      pc += bytes[pc + 1] === 0x84 ? 6 : 4
      continue
    }
    if (opcode >= 0x99 && opcode <= 0xa6) result.push({ pc, opcodeName: name, branch: 'if' })
    else if (opcode === 0xc6 || opcode === 0xc7) result.push({ pc, opcodeName: name, branch: 'if' })
    else if (opcode === 0xb6 || opcode === 0xb7 || opcode === 0xb8 || opcode === 0xb9) {
      if (pc + 2 < bytes.length) result.push({ pc, opcodeName: name, call: methodReference(pool, bytes.readUInt16BE(pc + 1)) })
    } else if (opcode === 0xba) {
      if (pc + 2 < bytes.length) result.push({ pc, opcodeName: name, call: { target: `dynamic:${bytes.readUInt16BE(pc + 1)}` } })
    }
    pc += instructionLength(opcode, bytes, pc)
  }
  return result
}

function instructionLength(opcode: number, bytes: Buffer, pc: number): number {
  if (opcode === 0x10 || opcode === 0x12 || opcode === 0x15 || opcode === 0x16 || opcode === 0x17 || opcode === 0x18 || opcode === 0x19 || opcode === 0x36 || opcode === 0x37 || opcode === 0x38 || opcode === 0x39 || opcode === 0x3a || opcode === 0xa9 || opcode === 0xbc) return 2
  if (opcode === 0x11 || opcode === 0x13 || opcode === 0x14 || opcode === 0x84 || (opcode >= 0x99 && opcode <= 0xa8) || (opcode >= 0xb2 && opcode <= 0xb8) || opcode === 0xbb || opcode === 0xbd || opcode === 0xc0 || opcode === 0xc1 || opcode === 0xc6 || opcode === 0xc7) return 3
  if (opcode === 0xc5) return 4
  if (opcode === 0xb9 || opcode === 0xba || opcode === 0xc8 || opcode === 0xc9) return 5
  if (opcode === 0xc4) return bytes[pc + 1] === 0x84 ? 6 : 4
  return 1
}

function lineForPc(lines: Array<{ pc: number; line: number }>, pc: number): number | undefined {
  let selected: number | undefined
  for (const entry of lines) {
    if (entry.pc > pc) break
    selected = entry.line
  }
  return selected ?? lines[0]?.line
}

function decodeDescriptorParameters(descriptor: string): JavaMethodInfo['parameters'] {
  const start = descriptor.indexOf('(')
  const end = descriptor.indexOf(')')
  if (start < 0 || end < 0) return []
  const raw = descriptor.slice(start + 1, end)
  const parameters: Array<{ name: string; type: string; annotations: string[] }> = []
  let index = 0
  while (index < raw.length) {
    const parsed = parseDescriptorType(raw, index)
    if (parsed === undefined) break
    parameters.push({ name: `arg${parameters.length}`, type: parsed.type, annotations: [] })
    index = parsed.next
  }
  return parameters
}

function parseDescriptorType(value: string, index: number): { type: string; next: number } | undefined {
  let cursor = index
  let dimensions = ''
  while (value[cursor] === '[') {
    dimensions += '[]'
    cursor += 1
  }
  const tag = value[cursor]
  const primitive: Record<string, string> = {
    Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double', V: 'void',
  }
  if (tag !== undefined && primitive[tag] !== undefined) return { type: `${primitive[tag]}${dimensions}`, next: cursor + 1 }
  if (tag === 'L') {
    const end = value.indexOf(';', cursor)
    if (end < 0) return undefined
    return { type: `${value.slice(cursor + 1, end).replace(/\//g, '.')}${dimensions}`, next: end + 1 }
  }
  return undefined
}

function modifiedUtf8(bytes: Buffer): string {
  return bytes.toString('utf8')
}

const OPCODE_NAMES: Record<number, string> = {
  0x99: 'ifeq',
  0x9a: 'ifne',
  0x9b: 'iflt',
  0x9c: 'ifge',
  0x9d: 'ifgt',
  0x9e: 'ifle',
  0x9f: 'if_icmpeq',
  0xa0: 'if_icmpne',
  0xa1: 'if_icmplt',
  0xa2: 'if_icmpge',
  0xa3: 'if_icmpgt',
  0xa4: 'if_icmple',
  0xa5: 'if_acmpeq',
  0xa6: 'if_acmpne',
  0xaa: 'tableswitch',
  0xab: 'lookupswitch',
  0xb6: 'invokevirtual',
  0xb7: 'invokespecial',
  0xb8: 'invokestatic',
  0xb9: 'invokeinterface',
  0xba: 'invokedynamic',
  0xc6: 'ifnull',
  0xc7: 'ifnonnull',
}
