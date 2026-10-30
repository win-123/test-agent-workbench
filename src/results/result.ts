import type { ReplayResult } from '../api/replay.ts'
import type { AssertionResult } from '../api/assertions.ts'
import { redactSensitiveText } from '../desktop/security.ts'

export interface TestAgentReport {
  run_id: string
  started_at: string
  finished_at: string
  target_origin: string
  total: number
  passed: number
  failed: number
  skipped: number
  requests: Array<{
    method: string
    path: string
    status: number
    duration_ms: number
    passed: boolean
    assertions: AssertionResult[]
    response_preview?: string
    error?: string
    error_kind?: ReplayResult['results'][number]['errorKind']
  }>
  correlation_results: Array<{
    variable_name: string
    source_index: number
    target_indexes: number[]
    status: 'extracted' | 'failed' | 'blocked'
    error?: string
  }>
  files: Record<string, string>
  config: Record<string, unknown>
  environment: {
    node: string
    test_agent: string
  }
}

export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }

export function toJsonValue<T extends object>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function createReport(
  replay: ReplayResult,
  files: Record<string, string> = {},
  config: Record<string, unknown> = {},
  startedAt: Date = new Date(),
  finishedAt: Date = new Date(),
): TestAgentReport {
  const requests = replay.results.map(result => ({
    method: result.method,
    path: result.path,
    status: result.status,
    duration_ms: result.durationMs,
    passed: result.passed,
    error: result.error === undefined ? undefined : redactSensitiveText(result.error),
    ...result.errorKind === undefined ? {} : { error_kind: result.errorKind },
    assertions: result.assertions,
    response_preview: result.responsePreview === undefined ? undefined : redactSensitiveText(result.responsePreview),
  }))
  return {
    run_id: replay.runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    target_origin: replay.baseUrl,
    total: requests.length,
    passed: requests.filter(request => request.passed).length,
    failed: requests.filter(request => !request.passed).length,
    skipped: 0,
    requests,
    correlation_results: replay.correlationResults.map(result => ({
      variable_name: result.variable_name,
      source_index: result.source_index,
      target_indexes: result.target_indexes,
      status: result.status,
      ...result.error === undefined ? {} : { error: result.error },
    })),
    files,
    config,
    environment: {
      node: process.version,
      test_agent: '0.1.0',
    },
  }
}
