import { describe, expect, it } from 'vitest'
import {
  importUiRecording,
  isOriginAllowed,
  parseUiTestCase,
  validateUiTestCase,
} from '../../src/ui/validation.ts'
import { validCase } from '../helpers/ui-case.ts'

describe('UI test case validation', () => {
  it('accepts a bounded case and rejects cross-origin navigation', () => {
    const testCase = validCase()
    expect(validateUiTestCase(testCase).valid).toBe(true)
    testCase.steps.push({
      id: 'outside',
      action: 'navigate',
      url: 'https://outside.example.test/',
    })
    const result = validateUiTestCase(testCase)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'navigation_origin_not_allowed' }))
  })

  it('rejects unsafe locators, duplicate step ids and malformed assertions', () => {
    const testCase = validCase()
    testCase.steps = [
      { id: 'same', action: 'click', locator: { kind: 'css', value: 'javascript:alert(1)' } },
      { id: 'same', action: 'assert', assertion: 'count', locator: { kind: 'css', value: '#value' }, expected: -1 },
    ]
    const result = validateUiTestCase(testCase)
    expect(result.valid).toBe(false)
    expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      'unsafe_locator',
      'duplicate_step_id',
      'invalid_assertion_count',
    ]))
  })

  it('imports recording actions without accepting invalid target URLs', () => {
    const imported = importUiRecording({
      name: 'Recorded login',
      target_url: 'http://127.0.0.1:8090/',
      actions: [
        { type: 'navigate', url: 'http://127.0.0.1:8090/' },
        { type: 'fill', locator: { kind: 'label', value: 'Username' }, value: 'demo' },
      ],
    }, { caseId: 'recorded-login', version: 1, createdAt: '2026-01-01T00:00:00.000Z' })
    expect(imported.steps).toHaveLength(2)
    expect(imported.allowed_origins).toEqual(['http://127.0.0.1:8090'])
    expect(() => importUiRecording({
      target_url: 'file:///etc/passwd',
      actions: [{ type: 'navigate', url: 'http://127.0.0.1:8090/' }],
    }, { caseId: 'bad-recording', version: 1 })).toThrow('URL must use http or https')
  })

  it('parses JSON validation errors and checks origins exactly', () => {
    expect(() => parseUiTestCase('{"schema_version":"wrong"}')).toThrow('validation failed')
    expect(isOriginAllowed('http://127.0.0.1:8090/path', ['http://127.0.0.1:8090'])).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:8091/path', ['http://127.0.0.1:8090'])).toBe(false)
  })
})
