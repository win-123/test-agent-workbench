import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseHar } from '../../src/har/parser.ts'
import { generatePostmanCollection } from '../../src/generators/postman.ts'

const har = parseHar(readFileSync('samples/demo.har', 'utf8'))

describe('Postman generator', () => {
  it('generates a sanitized Postman v2.1 collection', () => {
    const baseUrl = 'http://127.0.0.1:18093'
    const raw = generatePostmanCollection(har, { baseUrl, allowedOrigins: [baseUrl] })
    const collection = JSON.parse(raw) as {
      info: { schema: string }
      item: Array<{ request: { method: string; url: { raw: string } } }>
    }
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
    expect(collection.item).toHaveLength(3)
    expect(collection.item[0]?.request.method).toBe('GET')
    expect(raw).toContain(`${baseUrl}/api/health?verbose=true`)
    expect(raw).not.toContain('production-secret')
  })
})
