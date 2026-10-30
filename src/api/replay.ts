import type { ParsedHar, ParsedHarRequest } from '../har/types.ts'
import { evaluateAssertions, type AssertionConfig, type AssertionResult } from './assertions.ts'
import { assertTargetNetworkAllowed, createTargetPolicy, isOriginAllowed, type TargetPolicy } from './policy.ts'
import { redactSensitiveText } from '../desktop/security.ts'
import type { CorrelationConfig } from '../generators/k6.ts'

export interface ReplayOptions {
  baseUrl: string
  allowedOrigins?: string[]
  timeoutMs?: number
  maxResponseBytes?: number
  maxEntries?: number
  headers?: Record<string, string>
  allowedPaths?: string[]
  assertions?: AssertionConfig[]
  correlations?: CorrelationConfig[]
  concurrency?: number
  requestOrders?: number[]
}

export interface ReplayRequestResult {
  index: number
  method: string
  path: string
  status: number
  durationMs: number
  passed: boolean
  assertions: AssertionResult[]
  responsePreview?: string
  error?: string
  errorKind?: 'blocked' | 'network' | 'timeout' | 'http' | 'auth' | 'assertion' | 'correlation' | 'cancelled' | 'response-too-large'
}

export interface ReplayResult {
  runId: string
  baseUrl: string
  allowedPaths?: string[]
  results: ReplayRequestResult[]
  correlationResults: CorrelationExecutionResult[]
  startedAt: Date
  finishedAt: Date
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 100

interface CorrelationExecutionResult {
  variable_name: string
  source_index: number
  target_indexes: number[]
  status: 'extracted' | 'failed' | 'blocked'
  error?: string
}

interface RuntimeCorrelationState {
  variables: Map<string, { available: boolean; value?: string }>
  correlations: CorrelationConfig[]
  results: CorrelationExecutionResult[]
  secrets: Set<string>
}

export async function replayHar(har: ParsedHar, options: ReplayOptions, signal?: AbortSignal): Promise<ReplayResult> {
  const startedAt = new Date()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const selectedEntries = selectRequestEntries(har, options.requestOrders)
  if (selectedEntries.length > maxEntries) {
    throw new Error(`selection contains ${selectedEntries.length} requests; replay limit is ${maxEntries}`)
  }

  const policy = createTargetPolicy(options.baseUrl, options.allowedOrigins)
  await assertTargetNetworkAllowed(policy.baseUrl)
  const correlations = validateCorrelations(har.entries.length, options.correlations ?? [])
  const correlationState: RuntimeCorrelationState = {
    variables: new Map(),
    correlations,
    results: [],
    secrets: new Set(knownSecretValues(options.headers)),
  }
  const allowedPaths = options.allowedPaths
  const base = new URL(policy.baseUrl)
  const effectivePolicy: TargetPolicy = { ...policy, allowedPaths }
  const results = await runWithConcurrency(
    selectedEntries.map(request => () => replayRequest(request, request.order, base, effectivePolicy, options, timeoutMs, maxResponseBytes, correlationState, signal)),
    correlations.length > 0 ? 1 : options.concurrency ?? 1,
  )
  return { runId: createRunId(), baseUrl: base.toString(), results, correlationResults: correlationState.results, startedAt, finishedAt: new Date() }
}

function selectRequestEntries(har: ParsedHar, requestOrders: number[] | undefined): ParsedHarRequest[] {
  if (requestOrders === undefined) return har.entries
  if (!Array.isArray(requestOrders) || requestOrders.length === 0) {
    throw new Error('replay request selection must contain at least one request')
  }
  const available = new Set(har.entries.map(entry => entry.order))
  const unique = new Set<number>()
  for (const order of requestOrders) {
    if (!Number.isSafeInteger(order) || order < 0 || !available.has(order)) {
      throw new Error(`replay request order is invalid: ${String(order)}`)
    }
    if (unique.has(order)) throw new Error(`replay request order is duplicated: ${order}`)
    unique.add(order)
  }
  return har.entries.filter(entry => unique.has(entry.order))
}

async function replayRequest(
  request: ParsedHarRequest,
  index: number,
  base: URL,
  policy: TargetPolicy,
  options: ReplayOptions,
  timeoutMs: number,
  maxResponseBytes: number,
  correlationState: RuntimeCorrelationState,
  signal?: AbortSignal,
): Promise<ReplayRequestResult> {
  const started = performance.now()
  let prepared: ParsedHarRequest & { runtimeHeaders?: Record<string, string> } = request
  let target: URL
  try {
    prepared = applyRuntimeVariables(request, index, correlationState)
    target = mapTargetUrl(base, prepared.path)
  } catch (error) {
    return {
      index,
      method: request.method,
      path: request.path,
      status: 0,
      durationMs: 0,
      passed: false,
      error: redactRuntimeValues((error as Error).message, correlationState.secrets),
      errorKind: 'correlation',
      assertions: [],
    }
  }
  if (!isOriginAllowed(target.origin, policy)) {
    return {
      index,
      method: request.method,
      path: displayPath(target, correlationState.secrets),
      status: 0,
      durationMs: 0,
      passed: false,
      error: redactRuntimeValues(`target origin is not whitelisted: ${target.origin}`, correlationState.secrets),
      errorKind: 'blocked',
      assertions: [],
    }
  }
  if (policy.allowedPaths !== undefined && !isPathAllowed(target.pathname, policy)) {
    return {
      index,
      method: request.method,
      path: displayPath(target, correlationState.secrets),
      status: 0,
      durationMs: 0,
      passed: false,
      error: redactRuntimeValues(`target path is not whitelisted: ${target.pathname}`, correlationState.secrets),
      errorKind: 'blocked',
      assertions: [],
    }
  }
  if (signal?.aborted) return cancelled(index, request, target, started, correlationState.secrets)

  const timeoutController = new AbortController()
  const abort = (): void => timeoutController.abort(new DOMException('request timeout', 'TimeoutError'))
  const timer = setTimeout(abort, timeoutMs)
  const listener = (): void => timeoutController.abort(new Error('cancelled'))
  signal?.addEventListener('abort', listener)
  try {
    const headers: Record<string, string> = {}
    for (const header of prepared.headers) {
      if (header.sensitive) continue
      const adapted = adaptRecordedHeader(header.name, header.value, target)
      if (adapted !== undefined) headers[header.name] = adapted
    }
    Object.assign(headers, options.headers ?? {})
    Object.assign(headers, prepared.runtimeHeaders ?? {})
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(prepared.method) ? undefined : prepared.body,
      redirect: 'manual',
      signal: timeoutController.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      const redirect = new URL(location, target)
      if (!isOriginAllowed(redirect.origin, policy)) {
        return {
          index,
          method: request.method,
          path: displayPath(target, correlationState.secrets),
          status: response.status,
          durationMs: elapsed(started),
          passed: false,
          error: redactRuntimeValues(`redirect target origin is not whitelisted: ${redirect.origin}`, correlationState.secrets),
          errorKind: 'blocked',
          assertions: [],
        }
      }
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > maxResponseBytes) {
      return {
        index,
        method: request.method,
        path: displayPath(target, correlationState.secrets),
        status: response.status,
        durationMs: elapsed(started),
        passed: false,
        error: `response exceeds limit: ${contentLength} > ${maxResponseBytes}`,
        errorKind: 'response-too-large',
        assertions: [],
      }
    }
    const bodyText = await consumeResponse(response, maxResponseBytes)
    const assertions = evaluateAssertions({
      status: response.status,
      durationMs: elapsed(started),
      bodyText,
    }, findAssertion(index, target.pathname + target.search, options.assertions))
    const httpPassed = response.status >= 200 && response.status < 300
    let correlationPassed = true
    if (httpPassed) {
      correlationPassed = extractCorrelations(index, bodyText, correlationState)
    }
    const passed = httpPassed && assertions.every(item => item.passed) && correlationPassed
    const redactedAssertions = redactAssertions(assertions, correlationState.secrets)
    const assertionError = redactedAssertions.find(item => !item.passed)?.error
    const correlationError = correlationState.results
      .filter(result => result.source_index === index && result.status === 'failed')
      .at(-1)?.error
    const authFailure = response.status === 401 || response.status === 403
    return {
      index,
      method: request.method,
      path: displayPath(target, correlationState.secrets),
      status: response.status,
      durationMs: elapsed(started),
      passed,
      assertions: redactedAssertions,
      responsePreview: bodyText.length > 0
        ? redactRuntimeValues(`${bodyText.slice(0, 200)}${bodyText.length > 200 ? '...[truncated]' : ''}`, correlationState.secrets)
        : undefined,
      error: authFailure
        ? redactRuntimeValues(`target rejected credentials (HTTP ${response.status})`, correlationState.secrets)
        : redactOptional(assertionError ?? correlationError ?? (httpPassed ? undefined : `HTTP ${response.status}`), correlationState.secrets),
      errorKind: authFailure
        ? 'auth'
        : !httpPassed
          ? 'http'
          : correlationError !== undefined
            ? 'correlation'
            : assertionError === undefined
              ? undefined
              : 'assertion',
    }
  } catch (error) {
    const message = redactRuntimeValues((error as Error).message, correlationState.secrets)
    const kind = (error as DOMException).name === 'TimeoutError' ? 'timeout' : message === 'cancelled' ? 'cancelled' : 'network'
    return {
      index,
      method: request.method,
      path: displayPath(target, correlationState.secrets),
      status: 0,
      durationMs: elapsed(started),
      passed: false,
      error: message,
      errorKind: kind,
      assertions: [],
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', listener)
  }
}

function mapTargetUrl(base: URL, requestPath: string): URL {
  const target = new URL(base.toString())
  const [pathname, search = ''] = requestPath.split('?')
  target.pathname = joinPath(base.pathname, pathname)
  target.search = search
  return target
}

function applyRuntimeVariables(
  request: ParsedHarRequest,
  index: number,
  state: RuntimeCorrelationState,
): ParsedHarRequest {
  const headerValues: Record<string, string> = {}
  for (const correlation of correlationsForTarget(index, state)) {
    const variable = state.variables.get(correlation.variableName)
    if (variable?.available !== true) {
      throw new Error(`correlation variable is unavailable: ${correlation.variableName}`)
    }
    headerValues[correlation.targetHeader] = interpolate(correlation.targetTemplate, state)
  }
  const prepared: ParsedHarRequest & { runtimeHeaders?: Record<string, string> } = {
    ...request,
    path: interpolate(request.path, state),
    headers: [
      ...request.headers.filter(header => !header.sensitive),
    ],
    ...Object.keys(headerValues).length === 0 ? {} : { runtimeHeaders: headerValues },
    ...request.body === undefined ? {} : { body: interpolate(request.body, state) },
  }
  return prepared
}

function correlationsForTarget(index: number, state: RuntimeCorrelationState): Array<CorrelationConfig & { targetHeader: string; targetTemplate: string }> {
  return state.correlations.filter(correlation =>
    correlation.targetIndexes.includes(index)
      || (correlation.targetHeaders ?? []).some(header => header.index === index),
  ).map(correlation => {
    const header = correlation.targetHeaders?.find(item => item.index === index)
    if (header !== undefined) {
      return { ...correlation, targetHeader: header.name, targetTemplate: header.value ?? `\${${correlation.variableName}}` }
    }
    return undefined
    }).filter((value): value is CorrelationConfig & { targetHeader: string; targetTemplate: string } => value !== undefined)
}

function interpolate(value: string, state: RuntimeCorrelationState): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const variable = state.variables.get(name)
    if (variable?.available !== true) throw new Error(`correlation variable is unavailable: ${name}`)
    return variable.value!
  })
}

function extractCorrelations(index: number, bodyText: string, state: RuntimeCorrelationState): boolean {
  const correlations = (state.correlations ?? []).filter(correlation => correlation.sourceIndex === index)
  let passed = true
  for (const correlation of correlations) {
    const result: CorrelationExecutionResult = {
      variable_name: correlation.variableName,
      source_index: correlation.sourceIndex,
      target_indexes: correlation.targetIndexes,
      status: 'extracted',
    }
    try {
      const value = getJsonPath(JSON.parse(bodyText), correlation.jsonPath)
      if (value === undefined || value === null) throw new Error('correlation extraction returned null or undefined')
      const extracted = String(value)
      state.variables.set(correlation.variableName, { available: true, value: extracted })
      if (extracted.length > 0) state.secrets.add(extracted)
      state.results.push(result)
    } catch {
      passed = false
      state.variables.set(correlation.variableName, { available: false })
      state.results.push({ ...result, status: 'failed', error: `correlation extraction failed: ${correlation.jsonPath}` })
    }
  }
  return passed
}

function getJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error(`path must start with '$': ${path}`)
  let current = value
  for (const token of path.slice(1).split('.')) {
    if (token.length === 0) continue
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function validateCorrelations(requestCount: number, correlations: CorrelationConfig[]): CorrelationConfig[] {
  if (!Array.isArray(correlations)) throw new Error('correlations must be an array')
  const variableNames = new Set<string>()
  return correlations.map((correlation, position) => {
    if (correlation === null || typeof correlation !== 'object') throw new Error(`correlation ${position} must be an object`)
    if (!Number.isSafeInteger(correlation.sourceIndex) || correlation.sourceIndex < 0 || correlation.sourceIndex >= requestCount) {
      throw new Error(`correlation ${position} has an invalid sourceIndex`)
    }
    if (typeof correlation.jsonPath !== 'string' || !correlation.jsonPath.startsWith('$')) {
      throw new Error(`correlation ${position} has an invalid jsonPath`)
    }
    if (typeof correlation.variableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(correlation.variableName)) {
      throw new Error(`correlation ${position} has an invalid variableName`)
    }
    if (variableNames.has(correlation.variableName)) throw new Error(`duplicate correlation variable: ${correlation.variableName}`)
    variableNames.add(correlation.variableName)
    const validateTarget = (index: unknown): number => {
      if (!Number.isSafeInteger(index) || Number(index) <= correlation.sourceIndex || Number(index) >= requestCount) {
        throw new Error(`correlation ${position} target must be after source and inside the request list`)
      }
      return Number(index)
    }
    const targetIndexes = correlation.targetIndexes.map(validateTarget)
    const targetHeaders = correlation.targetHeaders?.map(header => {
      if (header === null || typeof header !== 'object') throw new Error(`correlation ${position} targetHeaders must contain objects`)
      if (typeof header.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) {
        throw new Error(`correlation ${position} has an invalid target header name`)
      }
      if (header.value !== undefined && (typeof header.value !== 'string' || header.value.length > 2000 || !header.value.includes(`\${${correlation.variableName}}`))) {
        throw new Error(`correlation ${position} target header value must reference its variable`)
      }
      return { name: header.name, index: validateTarget(header.index), ...header.value === undefined ? {} : { value: header.value } }
    })
    if (targetIndexes.length === 0 && (targetHeaders === undefined || targetHeaders.length === 0)) {
      throw new Error(`correlation ${position} must declare at least one target`)
    }
    return { ...correlation, targetIndexes, ...targetHeaders === undefined ? {} : { targetHeaders } }
  })
}

/**
 * Recorded HAR headers that are bound to the recording environment must follow
 * the configured replay environment instead of leaking the old gateway:
 * - Host is derived from the target URL by the HTTP client.
 * - Origin/Referer are rewritten to the configured target origin (path kept).
 * Explicit environment headers from the project config still win because they
 * are assigned after this loop.
 */
export function adaptRecordedHeader(name: string, value: string, target: URL): string | undefined {
  const normalized = name.toLowerCase()
  if (normalized === 'host') return undefined
  if (normalized === 'origin') return target.origin
  if (normalized === 'referer') {
    try {
      const recorded = new URL(value)
      return new URL(`${recorded.pathname}${recorded.search}${recorded.hash}`, target).toString()
    } catch {
      return `${target.origin}/`
    }
  }
  return value
}

function isPathAllowed(pathname: string, policy: TargetPolicy): boolean {
  return policy.allowedPaths?.some(pattern => {
    if (!pattern.startsWith('/')) return false
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3)
      return pathname === prefix || pathname.startsWith(`${prefix}/`)
    }
    return pathname === pattern
  }) ?? false
}

function joinPath(basePath: string, requestPath: string): string {
  const left = basePath.replace(/\/$/, '')
  const right = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  return `${left}${right}` || '/'
}

function cancelled(
  index: number,
  request: ParsedHarRequest,
  target: URL,
  started: number,
  secrets: Set<string>,
): ReplayRequestResult {
  return {
    index,
    method: request.method,
    path: displayPath(target, secrets),
    status: 0,
    durationMs: elapsed(started),
    passed: false,
    error: 'cancelled',
    errorKind: 'cancelled',
    assertions: [],
  }
}

function knownSecretValues(headers: Record<string, string> | undefined): string[] {
  return Object.values(headers ?? {}).filter(value => value.length > 0 && value !== '[REDACTED]')
}

function displayPath(target: URL, secrets: Set<string>): string {
  return redactRuntimeValues(`${target.pathname}${target.search}`, secrets)
}

function redactOptional(value: string | undefined, secrets: Set<string>): string | undefined {
  return value === undefined ? undefined : redactRuntimeValues(value, secrets)
}

function redactAssertions(assertions: AssertionResult[], secrets: Set<string>): AssertionResult[] {
  return assertions.map(assertion => ({
    ...assertion,
    expected: redactRuntimeValues(assertion.expected, secrets),
    actual: redactRuntimeValues(assertion.actual, secrets),
    ...assertion.error === undefined ? {} : { error: redactRuntimeValues(assertion.error, secrets) },
  }))
}

function redactRuntimeValues(input: string, secrets: Set<string>): string {
  let redacted = redactSensitiveText(input)
  const values = [...secrets]
    .filter(value => value.length >= 4 && value !== '[REDACTED]')
    .sort((left, right) => right.length - left.length)
  for (const value of values) redacted = redacted.split(value).join('[REDACTED]')
  return redacted
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

function createRunId(): string {
  return `run_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`
}

async function consumeResponse(response: Response, maxResponseBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > maxResponseBytes) throw new Error(`response exceeds limit: ${declaredLength} > ${maxResponseBytes}`)
  let received = 0
  if (response.body === null) return ''
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value?.byteLength ?? 0
      chunks.push(value ?? new Uint8Array())
    if (received > maxResponseBytes) throw new Error(`response exceeds limit: received more than ${maxResponseBytes} bytes`)
  }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function findAssertion(index: number, path: string, configs: AssertionConfig[] = []): AssertionConfig {
  return configs.find(item => item.index === index)
    ?? configs.find(item => item.path !== undefined && path === item.path)
    ?? {}
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`)
  }
  const results = new Array<T>(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}
