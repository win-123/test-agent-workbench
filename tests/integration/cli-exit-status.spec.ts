import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('CLI exit status', () => {
  it('returns non-zero when replay reports a failed request', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      'src/cli/bin.ts',
      'api', 'replay', 'samples/demo.har',
      '--base-url', 'http://127.0.0.1:8089',
      '--timeout-ms', '250',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as { failed: number; passed: number; total: number }
    expect(report.failed).toBeGreaterThan(0)
    expect(report.total).toBe(report.passed + report.failed)
  })
})
