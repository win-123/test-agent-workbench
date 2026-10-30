import { describe, expect, it } from 'vitest'
import { evaluateAssertions } from '../../src/api/assertions.ts'

describe('assertions', () => {
  it('supports status, JSON field, text, and duration assertions', () => {
    const results = evaluateAssertions({
      status: 200,
      durationMs: 10,
      bodyText: '{"status":"ok","nested":{"value":"hello"}}',
    }, {
      status: 200,
      jsonPath: '$.nested.value',
      equals: 'hello',
      contains: 'hello',
      maxDurationMs: 100,
    })
    expect(results).toHaveLength(4)
    expect(results.every(item => item.passed)).toBe(true)
  })

  it('reports actual and expected values on failure', () => {
    const results = evaluateAssertions({
      status: 500,
      durationMs: 20,
      bodyText: '{"status":"error"}',
    }, { status: 200, jsonPath: '$.status', equals: 'ok', maxDurationMs: 10 })
    expect(results.every(item => item.passed)).toBe(false)
    expect(results.find(item => item.name === 'status equals')).toMatchObject({ expected: '200', actual: '500' })
  })
})
