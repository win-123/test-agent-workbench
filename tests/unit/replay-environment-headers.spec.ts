import { describe, expect, it } from 'vitest'
import { adaptRecordedHeader } from '../../src/api/replay.ts'

describe('replay environment header adaptation', () => {
  const target = new URL('http://10.16.30.53:8080/base')

  it('drops the recorded Host header so the client derives it from the target URL', () => {
    expect(adaptRecordedHeader('Host', '10.16.183.221', target)).toBeUndefined()
    expect(adaptRecordedHeader('host', 'old-gateway:80', target)).toBeUndefined()
  })

  it('rewrites Origin to the configured target origin', () => {
    expect(adaptRecordedHeader('Origin', 'http://10.16.183.221', target)).toBe('http://10.16.30.53:8080')
  })

  it('rewrites Referer to the target environment while keeping the recorded path', () => {
    expect(adaptRecordedHeader('Referer', 'http://10.16.183.221/workbench/index.html?a=1', target))
      .toBe('http://10.16.30.53:8080/workbench/index.html?a=1')
  })

  it('falls back to the target root for an invalid recorded Referer', () => {
    expect(adaptRecordedHeader('Referer', 'not-a-url', target)).toBe('http://10.16.30.53:8080/')
  })

  it('keeps environment-independent headers unchanged', () => {
    expect(adaptRecordedHeader('Content-Type', 'application/json', target)).toBe('application/json')
    expect(adaptRecordedHeader('isYdf', 'YDF', target)).toBe('YDF')
  })
})
