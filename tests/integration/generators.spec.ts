import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHar } from '../../src/har/parser.ts'
import { generateJmx } from '../../src/generators/jmeter.ts'
import { generateK6Script } from '../../src/generators/k6.ts'

const har = parseHar(readFileSync('samples/demo.har', 'utf8'))

describe('generators', () => {
  it('generates k6 against the selected origin', () => {
    const baseUrl = 'http://127.0.0.1:18091'
    const script = generateK6Script(har, { baseUrl, allowedOrigins: [baseUrl] })
    expect(script).toContain(`${baseUrl}/api/health?verbose=true`)
    expect(script).not.toContain('production.example.test')
  })

  it('generates JMeter XML against the selected origin', () => {
    const baseUrl = 'http://127.0.0.1:18091'
    const jmx = generateJmx(har, { baseUrl, allowedOrigins: [baseUrl] })
    expect(jmx).toContain('<stringProp name="HTTPSampler.domain">127.0.0.1</stringProp>')
    expect(jmx).not.toContain('production.example.test')
    expect(jmx).toContain('<HTTPSamplerProxy')
  })

  it('generates correlation placeholders without URL-encoding', () => {
    const har = parseHar(JSON.stringify({
      log: { entries: [
        { request: { method: 'GET', url: 'https://production.example.test/login' } },
        { request: { method: 'GET', url: 'https://production.example.test/orders/${orderId}' } },
      ] },
    }))
    const script = generateK6Script(har, {
      baseUrl: 'http://127.0.0.1:18091',
      allowedOrigins: ['http://127.0.0.1:18091'],
      correlations: [{ sourceIndex: 0, jsonPath: '$.id', variableName: 'orderId', targetIndexes: [1] }],
    })
    expect(script).toContain('http://127.0.0.1:18091/orders/${orderId}')
  })
})
