import { readFile } from 'node:fs/promises'
import type { EngineDiagnostic, EngineExecutionResult } from './types.ts'

export type EngineReportStatus = 'passed' | 'test_failed' | 'result_parse_error' | 'cancelled' | 'timeout' | 'invalid_script' | 'engine_error' | 'not_installed'

export interface EnginePerformanceReport {
  engine: {
    name: string
    version: string
    version_available: boolean
  }
  run_id: string
  started_at: string
  finished_at: string
  configuration: {
    concurrency: number
    duration: string
    iterations: number
  }
  metrics: {
    total: number
    passed: number
    failed: number
    error_rate: number | null
    avg_response_ms: number | null
    p90_response_ms: number | null
    p95_response_ms: number | null
    p99_response_ms: number | null
    throughput_per_second: number | null
    throughput_basis: string
  }
  evidence: {
    stdout_path: string
    stderr_path: string
    raw_result_path?: string
    exit_code: number | null
    signal: string | null
    timed_out: boolean
    status: EngineReportStatus
    error?: string
  }
  sensitive_redacted: boolean
  diagnostics: EngineDiagnostic[]
  limitations: string[]
}

export async function createEngineReport(
  execution: EngineExecutionResult,
  configuration: { concurrency: number; duration?: string; iterations?: number },
): Promise<EnginePerformanceReport> {
  const raw = execution.rawResultPath === undefined ? undefined : await readFile(execution.rawResultPath, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    if (execution.status === 'timeout' || execution.status === 'cancelled') {
      return createUnparsedReport(
        execution,
        configuration,
        execution.status,
        `${execution.status}: engine result file is missing or unreadable: ${execution.rawResultPath}`,
      )
    }
    throw new Error(`engine result file is missing or unreadable: ${execution.rawResultPath}`)
  }
  let metrics: EnginePerformanceReport['metrics']
  const diagnostics: EngineDiagnostic[] = []
  try {
    metrics = execution.kind === 'k6' ? parseK6Summary(raw) : parseJMeterJtl(raw)
  } catch (error) {
    diagnostics.push({ category: 'result_parse', message: (error as Error).message })
    return createUnparsedReport(
      execution,
      configuration,
      'result_parse_error',
      `engine result could not be parsed: ${(error as Error).message}`,
      diagnostics,
    )
  }
  if (metrics.failed > 0) {
    diagnostics.push({
      category: 'test_result',
      message: `engine reported ${metrics.failed} failed request${metrics.failed === 1 ? '' : 's'} out of ${metrics.total}`,
    })
  }
  return {
    engine: {
      name: execution.kind,
      version: execution.version ?? 'unknown',
      version_available: execution.version !== null,
    },
    run_id: execution.runId,
    started_at: execution.startedAt.toISOString(),
    finished_at: execution.finishedAt.toISOString(),
    configuration: {
      concurrency: configuration.concurrency,
      duration: configuration.duration ?? '',
      iterations: configuration.iterations ?? 0,
    },
    metrics,
    evidence: {
      stdout_path: execution.stdoutPath,
      stderr_path: execution.stderrPath,
      raw_result_path: execution.rawResultPath,
      exit_code: execution.exitCode,
      signal: execution.signal,
      timed_out: execution.timedOut,
      status: toReportStatus(execution.status),
    },
    sensitive_redacted: true,
    diagnostics,
    limitations: buildLimitations(execution, metrics),
  }
}

function createUnparsedReport(
  execution: EngineExecutionResult,
  configuration: { concurrency: number; duration?: string; iterations?: number },
  status: EngineReportStatus,
  error: string,
  diagnostics: EngineDiagnostic[] = [],
): EnginePerformanceReport {
  return {
    engine: {
      name: execution.kind,
      version: execution.version ?? 'unknown',
      version_available: execution.version !== null,
    },
    run_id: execution.runId,
    started_at: execution.startedAt.toISOString(),
    finished_at: execution.finishedAt.toISOString(),
    configuration: {
      concurrency: configuration.concurrency,
      duration: configuration.duration ?? '',
      iterations: configuration.iterations ?? 0,
    },
    metrics: {
      total: 0, passed: 0, failed: 0, error_rate: null,
      avg_response_ms: null, p90_response_ms: null, p95_response_ms: null, p99_response_ms: null,
      throughput_per_second: null, throughput_basis: 'not available: engine did not produce a parsable result',
    },
    evidence: {
      stdout_path: execution.stdoutPath,
      stderr_path: execution.stderrPath,
      raw_result_path: execution.rawResultPath,
      exit_code: execution.exitCode,
      signal: execution.signal,
      timed_out: execution.timedOut,
      status,
      error,
    },
    sensitive_redacted: true,
    diagnostics,
    limitations: ['Engine result file was unavailable, so metrics are not reported.'],
  }
}

function buildLimitations(execution: EngineExecutionResult, metrics: EnginePerformanceReport['metrics']): string[] {
  const limitations: string[] = []
  if (execution.kind === 'k6') {
    if (metrics.p90_response_ms === null) limitations.push('k6 summary did not provide p90.')
    if (metrics.p95_response_ms === null) limitations.push('k6 summary did not provide p95.')
    if (metrics.p99_response_ms === null) limitations.push('k6 summary did not provide p99.')
  } else if (metrics.throughput_per_second === null) {
    limitations.push('JMeter throughput is not reported for single-sample JTL timestamp ranges.')
  }
  return limitations
}

function parseK6Summary(raw: string): EnginePerformanceReport['metrics'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('failed to parse k6 result file')
  }
  const root = parsed as { metrics?: Record<string, { count?: number; rate?: number; avg?: number }> }
  const checks = root.metrics?.['checks'] as { count?: number; passes?: number; fails?: number } | undefined
  const httpReqs = root.metrics?.['http_reqs']
  const failedMetric = root.metrics?.['http_req_failed'] as { value?: number } | undefined
  const duration = root.metrics?.['http_req_duration'] as { avg?: number; 'p(90)'?: number; 'p(95)'?: number; 'p(99)'?: number } | undefined
  const total = httpReqs?.count ?? 0
  const failed = failedMetric?.value !== undefined
    ? Math.round(total * failedMetric.value)
    : (checks?.fails ?? 0)
  const requestFailureRate = failedMetric?.value
  const checkFailureRate = checks !== undefined && (checks.count ?? (checks.passes ?? 0) + (checks.fails ?? 0)) > 0
    ? (checks.fails ?? 0) / ((checks.passes ?? 0) + (checks.fails ?? 0))
    : null
  return {
    total,
    passed: Math.max(0, total - failed),
    failed,
    error_rate: requestFailureRate ?? checkFailureRate,
    avg_response_ms: duration?.avg ?? null,
    p90_response_ms: duration?.['p(90)'] ?? null,
    p95_response_ms: duration?.['p(95)'] ?? null,
    p99_response_ms: duration?.['p(99)'] ?? null,
    throughput_per_second: httpReqs?.rate ?? null,
    throughput_basis: 'k6 http_reqs.rate',
  }
}

export const parseK6SummaryForTest = parseK6Summary
export const parseJMeterJtlForTest = parseJMeterJtl

function toReportStatus(status: EngineExecutionResult['status']): EngineReportStatus {
  return status
}

function parseJMeterJtl(raw: string): EnginePerformanceReport['metrics'] {
  const lines = raw.trim().split('\n')
  if (lines.length < 2) throw new Error('failed to parse JMeter JTL result file')
  const headers = lines[0]?.split(',') ?? []
  const elapsedIndex = headers.indexOf('elapsed')
  const successIndex = headers.indexOf('success')
  const timeStampIndex = headers.indexOf('timeStamp')
  if (elapsedIndex < 0 || successIndex < 0 || timeStampIndex < 0) throw new Error('invalid JMeter JTL columns')
  const rows = lines.slice(1).map(line => line.split(','))
  const durations = rows.map(row => Number(row[elapsedIndex])).filter(value => Number.isFinite(value))
  const sorted = [...durations].sort((a, b) => a - b)
  const passed = rows.filter(row => row[successIndex]?.toLowerCase() === 'true').length
  const total = rows.length
  const timeStamps = rows.map(row => Number(row[timeStampIndex])).filter(value => Number.isFinite(value))
  const elapsedMs = timeStamps.length > 0 ? Math.max(...timeStamps) - Math.min(...timeStamps) : 0
  return {
    total,
    passed,
    failed: total - passed,
    error_rate: total > 0 ? (total - passed) / total : null,
    avg_response_ms: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    p90_response_ms: percentile(sorted, 0.9),
    p95_response_ms: percentile(sorted, 0.95),
    p99_response_ms: percentile(sorted, 0.99),
    throughput_per_second: elapsedMs > 0 ? total / (elapsedMs / 1000) : null,
    throughput_basis: 'JTL timeStamp range',
  }
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.ceil(sorted.length * ratio) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? null
}
