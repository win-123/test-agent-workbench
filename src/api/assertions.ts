import { redactSensitiveText } from '../desktop/security.ts'

export interface AssertionConfig {
  /** Match the HAR request index. */
  index?: number
  /** Match the normalized path, including query. */
  path?: string
  status?: number
  jsonPath?: string
  equals?: unknown
  contains?: string
  maxDurationMs?: number
}

export interface AssertionResult {
  name: string
  passed: boolean
  expected: string
  actual: string
  error?: string
}

interface AssertionTarget {
  status: number
  durationMs: number
  bodyText: string
}

export function evaluateAssertions(target: AssertionTarget, config: AssertionConfig): AssertionResult[] {
  const results = [
    ...config.status !== undefined ? [assertStatus(target, config.status)] : [],
    ...config.jsonPath !== undefined ? [assertJson(target, config)] : [],
    ...config.contains !== undefined ? [assertContains(target, config.contains)] : [],
    ...config.maxDurationMs !== undefined ? [assertDuration(target, config.maxDurationMs)] : [],
  ]
  return results.map(result => ({
    ...result,
    expected: redactSensitiveText(result.expected),
    actual: redactSensitiveText(result.actual),
    ...result.error === undefined ? {} : { error: redactSensitiveText(result.error) },
  }))
}

function assertStatus(target: AssertionTarget, expected: number): AssertionResult {
  const passed = target.status === expected
  return {
    name: 'status equals',
    passed,
    expected: stringify(expected),
    actual: stringify(target.status),
    error: passed ? undefined : `HTTP status mismatch: expected ${expected}, got ${target.status}`,
  }
}

function assertJson(target: AssertionTarget, config: AssertionConfig): AssertionResult {
  const jsonPath = config.jsonPath ?? ''
  const name = `json ${jsonPath} equals`
  let actual: unknown
  try {
    actual = getJsonPath(JSON.parse(target.bodyText) as unknown, jsonPath)
  } catch (error) {
    return {
      name,
      passed: false,
      expected: stringify(config.equals),
      actual: truncate(target.bodyText),
      error: `cannot evaluate JSON assertion: ${(error as Error).message}`,
    }
  }
  const passed = JSON.stringify(actual) === JSON.stringify(config.equals)
  const privateValue = sensitiveJsonPath(config.jsonPath ?? '$')
  return {
    name,
    passed,
    expected: privateValue ? '[REDACTED]' : stringify(config.equals),
    actual: privateValue ? '[REDACTED]' : stringify(actual),
    error: passed || !privateValue ? undefined : `JSON field ${jsonPath} mismatch`,
  }
}

function assertContains(target: AssertionTarget, contains: string): AssertionResult {
  const passed = target.bodyText.includes(contains)
  return {
    name: 'body contains',
    passed,
    // A contains assertion can target a secret; never persist its exact value.
    expected: '[REDACTED]',
    actual: redactSensitiveText(truncate(target.bodyText)),
    error: passed ? undefined : 'body does not contain the expected value',
  }
}

function assertDuration(target: AssertionTarget, maxDurationMs: number): AssertionResult {
  const passed = target.durationMs <= maxDurationMs
  return {
    name: 'duration at most',
    passed,
    expected: `${maxDurationMs} ms`,
    actual: `${target.durationMs} ms`,
    error: passed ? undefined : `response time exceeds limit: ${target.durationMs} > ${maxDurationMs} ms`,
  }
}

function getJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error(`path must start with '$': ${path}`)
  let current: unknown = value
  for (const token of path.slice(1).split('.')) {
    if (token.length === 0) continue
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function stringify(value: unknown): string {
  return truncate(JSON.stringify(value) ?? String(value))
}

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...[truncated]` : value
}

function sensitiveJsonPath(value: string): boolean {
  return /(?:^|\.)(?:password|passwd|secret|token|credential|api[-_]?key)$/i.test(value)
}
