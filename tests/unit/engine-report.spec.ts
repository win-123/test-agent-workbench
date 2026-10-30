import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEngineReport, parseK6SummaryForTest, parseJMeterJtlForTest } from '../../src/engines/report.ts'

describe('engine result parsing', () => {
  it('parses k6 summary metrics', () => {
    const metrics = parseK6SummaryForTest(JSON.stringify({
      metrics: {
        checks: { count: 3, passes: 2, fails: 1 },
        http_reqs: { count: 3, rate: 10 },
        http_req_duration: { avg: 12, 'p(90)': 18, 'p(95)': 20, 'p(99)': 22 },
        http_req_failed: { value: 0.25 },
      },
    }))
    expect(metrics.total).toBe(3)
    expect(metrics.failed).toBe(1)
    expect(metrics.passed).toBe(2)
    expect(metrics.p90_response_ms).toBe(18)
    expect(metrics.throughput_per_second).toBe(10)
    expect(metrics.avg_response_ms).toBe(12)
  })

  it('uses check failures when k6 does not expose the request failure metric', () => {
    const metrics = parseK6SummaryForTest(JSON.stringify({
      metrics: {
        checks: { count: 3, passes: 1, fails: 2 },
        http_reqs: { count: 3, rate: 5 },
        http_req_duration: { avg: 10 },
      },
    }))
    expect(metrics.error_rate).toBe(2 / 3)
    expect(metrics.failed).toBe(2)
  })

  it('parses JMeter JTL metrics', () => {
    const raw = 'timeStamp,elapsed,label,responseCode,success\n1000,10,A,200,true\n1010,20,B,500,false\n1030,30,C,200,true\n'
    const metrics = parseJMeterJtlForTest(raw)
    expect(metrics.total).toBe(3)
    expect(metrics.passed).toBe(2)
    expect(metrics.failed).toBe(1)
    expect(metrics.avg_response_ms).toBe(20)
    expect(metrics.p90_response_ms).toBe(30)
    expect(metrics.p95_response_ms).toBe(30)
    expect(metrics.p99_response_ms).toBe(30)
  })

  it('records diagnostics and non-success status for failed engine requests', async () => {
    const report = await createEngineReport(await fakeExecution(), { concurrency: 1, iterations: 1 })
    expect(report.metrics.failed).toBe(1)
    expect(report.evidence.status).toBe('passed')
    expect(report.diagnostics).toEqual([{
      category: 'test_result',
      message: 'engine reported 1 failed request out of 3',
    }])
  })

  it('returns a result-parse report for corrupted k6 JSON', async () => {
    const report = await createEngineReport(await fakeExecution('{bad json'), { concurrency: 1, iterations: 1 })
    expect(report.evidence.status).toBe('result_parse_error')
    expect(report.metrics.total).toBe(0)
    expect(report.diagnostics[0]?.category).toBe('result_parse')
  })
})

async function fakeExecution(raw = JSON.stringify({ metrics: { http_reqs: { count: 3, rate: 5 }, http_req_failed: { value: 1 / 3 } } })) {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-report-'))
  const rawResultPath = join(directory, 'result.json')
  await writeFile(rawResultPath, raw)
  return {
    kind: 'k6' as const,
    runId: 'unit-report',
    executable: 'k6',
    version: 'v0.0.0',
    arguments: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    status: 'passed' as const,
    stdoutPath: 'unused',
    stderrPath: 'unused',
    rawResultPath,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  }
}
