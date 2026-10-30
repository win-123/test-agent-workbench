import type { HarDocument, HarEntry, HarHeader, HarNameValue, HarQueryParameter, HarRequest, ParsedHar, ParsedHarRequest } from './types.ts'

const SUPPORTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|access-token|refresh-token)$/i
const SENSITIVE_BODY_KEY_PATTERN = /(password|passwd|secret|token|credential|api[-_]?key)/i
const SENSITIVE_QUERY_PATTERN = /^(password|passwd|secret|token|access[-_]?token|refresh[-_]?token|credential|api[-_]?key|key)$/i

export class HarParseError extends Error {
  readonly entries: ParsedHarRequest[]

  constructor(message: string, entries: ParsedHarRequest[] = []) {
    super(message)
    this.name = 'HarParseError'
    this.entries = entries
  }
}

export interface HarParseLimits {
  maxBytes?: number
  maxEntries?: number
  maxBodyBytes?: number
}

const DEFAULT_MAX_HAR_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

export function parseHar(input: string, options: HarParseLimits = {}): ParsedHar {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_HAR_BYTES
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw new HarParseError(`HAR exceeds limit: ${Buffer.byteLength(input, 'utf8')} > ${maxBytes} bytes`)
  }
  let document: HarDocument
  try {
    document = JSON.parse(input) as HarDocument
  } catch (error) {
    throw new HarParseError(`invalid HAR JSON: ${(error as Error).message}`)
  }

  if (document?.log === undefined || document.log === null || typeof document.log !== 'object') {
    throw new HarParseError('missing log object')
  }
  if (!Array.isArray(document.log.entries)) {
    throw new HarParseError('missing log.entries array')
  }
  if (document.log.entries.length === 0) {
    throw new HarParseError('log.entries is empty')
  }
  if (options.maxEntries !== undefined && document.log.entries.length > options.maxEntries) {
    throw new HarParseError(`HAR contains ${document.log.entries.length} entries; limit is ${options.maxEntries}`)
  }

  const entries: ParsedHarRequest[] = []
  const errors: string[] = []
  document.log.entries.forEach((rawEntry: HarEntry, index: number) => {
    try {
      entries.push(parseEntry(rawEntry, index, maxBodyBytes))
    } catch (error) {
      errors.push(`entry ${index}: ${(error as Error).message}`)
    }
  })
  if (errors.length > 0) {
    throw new HarParseError(errors.join('; '), entries)
  }
  return { entries }
}

function parseEntry(rawEntry: HarEntry, index: number, maxBodyBytes: number): ParsedHarRequest {
  if (rawEntry?.request === undefined || rawEntry.request === null || typeof rawEntry.request !== 'object') {
    throw new Error('missing request object')
  }
  return parseRequest(rawEntry.request, index, maxBodyBytes)
}

function parseRequest(request: HarRequest, order: number, maxBodyBytes: number): ParsedHarRequest {
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : ''
  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error(`unsupported method ${JSON.stringify(request.method)}`)
  }
  if (typeof request.url !== 'string' || request.url.length === 0) {
    throw new Error('missing or invalid url')
  }

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new Error(`invalid URL ${JSON.stringify(request.url)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported URL protocol ${url.protocol}`)
  }

  const query = parseNameValues(request.queryString)
  return {
    order,
    method,
    url: url.toString(),
    origin: url.origin,
    path: `${url.pathname}${rebuildSearch(query)}`,
    query,
    headers: parseHeaders(request.headers),
    body: parseBody(request.postData, order, maxBodyBytes),
  }
}

function parseNameValues(input: unknown): HarQueryParameter[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('expected an array')
  return input.map((item, index) => {
    const pair = item as HarNameValue
    if (typeof pair?.name !== 'string') throw new Error(`item ${index} missing name`)
    const value = typeof pair.value === 'string' ? pair.value : ''
    const sensitive = SENSITIVE_QUERY_PATTERN.test(pair.name)
    return { name: pair.name, value: sensitive ? '[REDACTED]' : value, sensitive }
  })
}

function rebuildSearch(query: HarQueryParameter[]): string {
  if (query.length === 0) return ''
  return `?${query.map(item => `${encodeURIComponent(item.name)}=${encodeURIComponent(item.value)}`).join('&')}`
}

function parseHeaders(input: unknown): HarHeader[] {
  return parseNameValues(input).map(item => {
    const sensitive = SENSITIVE_HEADER_PATTERN.test(item.name)
    return { name: item.name, value: sensitive ? '[REDACTED]' : item.value, sensitive }
  })
}

function parseBody(input: unknown, order: number, maxBodyBytes: number): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || typeof (input as { text?: unknown }).text !== 'string') {
    return undefined
  }
  const body = (input as { text: string }).text
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    throw new Error(`entry ${order}: request body exceeds limit: ${Buffer.byteLength(body, 'utf8')} > ${maxBodyBytes} bytes`)
  }
  const mimeType = typeof (input as { mimeType?: unknown }).mimeType === 'string' ? (input as { mimeType: string }).mimeType : ''
  if (/json/i.test(mimeType)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body) as unknown))
    } catch {
      // A malformed JSON body may contain a literal credential, so fail closed.
      return redactUnstructuredBody(body)
    }
  }
  return redactFormBody(body)
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson)
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_BODY_KEY_PATTERN.test(key) ? '[REDACTED]' : redactJson(child)
    }
    return output
  }
  return value
}

function redactFormBody(body: string): string {
  return body.split('&').map(pair => {
    const separator = pair.indexOf('=')
    if (separator === -1) return pair
    const rawKey = pair.slice(0, separator)
    let key: string
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      key = rawKey
    }
    return SENSITIVE_BODY_KEY_PATTERN.test(key) ? `${rawKey}=${encodeURIComponent('[REDACTED]')}` : pair
  }).join('&')
}

function redactUnstructuredBody(body: string): string {
  // Preserve replay evidence without retaining original credential bytes.
  return body.replace(/("(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*")/g, match => {
    const separator = match.indexOf(':')
    const rawKey = match.slice(0, separator).trim()
    let key: string
    try {
      key = JSON.parse(rawKey) as string
    } catch {
      key = rawKey
    }
    return SENSITIVE_BODY_KEY_PATTERN.test(key) ? `${rawKey}:${JSON.stringify('[REDACTED]')}` : match
  }).replace(/((?:password|passwd|secret|token|credential|api[-_]?key)=[^&\s]+)/gi, 'REDACTED=[REDACTED]')
}
