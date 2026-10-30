import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseHar } from '../../src/har/parser.ts'
import { replayHar } from '../../src/api/replay.ts'
import { canBindLocalFixture } from '../integration/fixture-support.ts'
import { createServer, type Server } from 'node:http'

let baseUrl = ''
let server: Server | undefined
const describeWithFixture = describe.runIf(await canBindLocalFixture())

beforeAll(async () => {
  if (!describeWithFixture) return
  server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }))
    } else if (request.url === '/api/fail') {
      response.writeHead(500).end('{}')
    } else if (request.url === '/api/cancel') {
      setTimeout(() => response.writeHead(200).end('{}'), 500)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server!.address()
  if (address === null || typeof address === 'string') throw new Error('fixture has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describeWithFixture('replay core', () => {
  it('rejects HAR file, entry, and body limits', () => {
    const base = JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'https://x.test/a' } }] } })
    expect(() => parseHar(base, { maxEntries: 0 })).toThrow(/entries; limit is 0/)
    expect(() => parseHar(base, { maxBytes: 10 })).toThrow(/HAR exceeds limit/)
    const body = JSON.stringify({
      log: {
        entries: [{
          request: {
            method: 'POST',
            url: 'https://x.test/a',
            postData: { mimeType: 'text/plain', text: 'x'.repeat(11) },
          },
        }],
      },
    })
    expect(() => parseHar(body, { maxBodyBytes: 10 })).toThrow(/request body exceeds limit/)
  })

  it('evaluates JSON assertions and preserves order with concurrency', async () => {
    const har = parseHar(JSON.stringify({
      log: { entries: [
        { request: { method: 'GET', url: 'https://production.example.test/api/health?verbose=true' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://production.example.test/api/fail' }, response: { status: 500 } },
      ] },
    }))
    const result = await replayHar(har, {
      baseUrl,
      allowedOrigins: [baseUrl],
      concurrency: 2,
      assertions: [{ index: 0, status: 200, jsonPath: '$.status', equals: 'ok' }],
    })
    expect(result.results[0].passed).toBe(true)
    expect(result.results[0].assertions.map(item => item.passed)).toEqual([true, true])
    expect(result.results[1].passed).toBe(false)
    expect(result.results[1].error).toBe('HTTP 500')
  })

  it('reports a JSON assertion failure', async () => {
    const har = parseHar(JSON.stringify({
      log: { entries: [{ request: { method: 'GET', url: 'https://production.example.test/api/health' } }] },
    }))
    const result = await replayHar(har, {
      baseUrl,
      allowedOrigins: [baseUrl],
      assertions: [{ index: 0, status: 200, jsonPath: '$.status', equals: 'not-ok' }],
    })
    expect(result.results[0].passed).toBe(false)
    expect(result.results[0].assertions.find(item => item.name === 'json $.status equals')).toMatchObject({
      expected: '"not-ok"',
      actual: '"ok"',
    })
  })

  it('supports cancellation', async () => {
    const har = parseHar(JSON.stringify({
      log: { entries: [{ request: { method: 'GET', url: 'https://production.example.test/api/cancel' } }] },
    }))
    const controller = new AbortController()
    const replay = replayHar(har, {
      baseUrl,
      allowedOrigins: [baseUrl],
    }, controller.signal)
    controller.abort()
    const result = await replay
    expect(result.results[0].errorKind).toBe('cancelled')
  })
})
