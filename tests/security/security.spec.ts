import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHar } from '../../src/har/parser.ts'
import { replayHar } from '../../src/api/replay.ts'
import { generateK6Script } from '../../src/generators/k6.ts'
import { generateJmx } from '../../src/generators/jmeter.ts'

const har = parseHar(readFileSync('samples/demo.har', 'utf8'))

describe('security', () => {
  it('does not leak production credentials to generators', () => {
    const baseUrl = 'http://127.0.0.1:18092'
    expect(generateK6Script(har, { baseUrl, allowedOrigins: [baseUrl] })).not.toContain('production-secret')
    expect(generateJmx(har, { baseUrl, allowedOrigins: [baseUrl] })).not.toContain('production-secret')
  })

  it('does not replay the recorded production origin', async () => {
    const baseUrl = 'http://127.0.0.1:18092'
    const result = await replayHar(har, { baseUrl, allowedOrigins: [baseUrl] })
    expect(result.baseUrl).toBe(`${baseUrl}/`)
  })
})
