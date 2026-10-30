import { describe, expect, it } from 'vitest'
import { HarParseError, parseHar } from '../../src/har/parser.ts'
import { readFileSync } from 'node:fs'

describe('HAR parser', () => {
  it('parses a valid HAR', () => {
    const har = parseHar(readFileSync('samples/demo.har', 'utf8'))
    expect(har.entries).toHaveLength(3)
    expect(har.entries[0].method).toBe('GET')
    expect(har.entries[0].query).toEqual([{ name: 'verbose', value: 'true', sensitive: false }])
  })

  it.each([
    ['invalid json', 'not json'],
    ['missing log', '{}'],
    ['missing entries', JSON.stringify({ log: {} })],
    ['empty entries', JSON.stringify({ log: { entries: [] } })],
  ])('rejects %s', (_name, input) => {
    expect(() => parseHar(input)).toThrow(HarParseError)
  })

  it('rejects an invalid URL', () => {
    const input = JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'not-a-url' } }] } })
    expect(() => parseHar(input)).toThrow(/invalid URL/)
  })

  it('redacts sensitive headers and JSON bodies', () => {
    const input = JSON.stringify({
      log: {
        entries: [{
          request: {
            method: 'POST',
            url: 'https://example.test/api',
            headers: [{ name: 'Authorization', value: 'Bearer secret' }],
            postData: { mimeType: 'application/json', text: '{"password":"secret","ok":"value"}' },
          },
        }],
      },
    })
    const har = parseHar(input)
    expect(har.entries[0].headers[0].value).toBe('[REDACTED]')
    expect(har.entries[0].body).toBe('{"password":"[REDACTED]","ok":"value"}')
  })
})
