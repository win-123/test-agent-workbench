import { describe, expect, it } from 'vitest'
import { evaluateAssertions } from '../../src/api/assertions.ts'
import { createReport } from '../../src/results/result.ts'
import type { ReplayResult } from '../../src/api/replay.ts'

describe('report sensitive-value redaction', () => {
  it('redacts secrets in response previews and assertion evidence', () => {
    const body = JSON.stringify({ token: 'secret-token', password: 'hunter2', data: 'ok' })
    const assertions = evaluateAssertions(
      { status: 200, durationMs: 10, bodyText: body },
      { jsonPath: '$.token', equals: 'secret-token' },
    )
    const rendered = JSON.stringify(assertions)
    expect(rendered).not.toContain('secret-token')
    expect(rendered).not.toContain('hunter2')
    expect(rendered).toContain('[REDACTED]')

    const replay: ReplayResult = {
      runId: 'run_redaction',
      baseUrl: 'http://127.0.0.1:1/',
      results: [{
        index: 0,
        method: 'GET',
        path: '/login',
        status: 200,
        durationMs: 10,
        passed: true,
        assertions,
        responsePreview: `${body} Authorization: Bearer abc123`,
      }],
      correlationResults: [],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    }
    const report = JSON.stringify(createReport(replay))
    expect(report).not.toContain('secret-token')
    expect(report).not.toContain('hunter2')
    expect(report).not.toContain('abc123')
    expect(report).toContain('[REDACTED]')
  })
})
