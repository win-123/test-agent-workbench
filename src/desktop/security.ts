import { realpath, stat } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|access-token|refresh-token)$/i
const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]'],
  [/(cookie\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]'],
  [/((?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)([^\s,;&]+)/gi, '$1[REDACTED]'],
  [/("?(?:password|passwd|secret|token|api[-_]?key)"?\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]@'],
]

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name)
}

export function redactSensitiveText(input: string): string {
  return SECRET_TEXT_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), input)
}

export function resolveInside(root: string, child: string): string {
  if (typeof child !== 'string' || child.length === 0 || child.includes('\0')) {
    throw new Error('invalid path')
  }
  const absoluteRoot = resolve(root)
  const candidate = isAbsolute(child) ? resolve(child) : resolve(absoluteRoot, child)
  const childRelative = relative(absoluteRoot, candidate)
  if (childRelative !== '' && (childRelative.startsWith('..') || childRelative.startsWith(`..${sep}`) || isAbsolute(childRelative))) {
    throw new Error(`path escapes project directory: ${candidate}`)
  }

  // Validate the nearest existing ancestor so symlinks cannot redirect an
  // otherwise project-relative output, artifact, or execution path.
  const canonicalRoot = realpathSync(absoluteRoot)
  const canonicalExisting = nearestExistingPath(candidate)
  const canonicalRelative = relative(canonicalRoot, canonicalExisting)
  if (canonicalRelative !== '' && (canonicalRelative.startsWith('..') || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative))) {
    throw new Error(`path escapes project directory: ${candidate}`)
  }
  return candidate
}

function nearestExistingPath(path: string): string {
  let current = path
  while (current !== dirname(current)) {
    try {
      lstatSync(current)
      return realpathSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = dirname(current)
    }
  }
  return realpathSync(current)
}

export async function assertRegularFile(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
}

export async function assertDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error(`not a directory: ${path}`)
  return canonical
}

export function safeFileStem(input: string): string {
  const stem = input
    .replace(/\.har$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return stem.length > 0 ? stem : 'imported'
}

export function assertSafeTaskId(taskId: string): string {
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(taskId)) {
    throw new Error('invalid task id')
  }
  return taskId
}

export function assertSafeEngine(engine: string): 'k6' | 'jmeter' {
  if (engine === 'k6' || engine === 'jmeter') return engine
  throw new Error('engine must be k6 or jmeter')
}
