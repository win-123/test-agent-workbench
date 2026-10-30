import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { parseHar } from '../../src/har/parser.ts'
import { replayHar } from '../../src/api/replay.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const har = parseHar(readFileSync('samples/demo.har', 'utf8'))
let baseUrl = ''
let server: Server | undefined
const describeWithFixture = describe.runIf(await canBindLocalFixture())

beforeAll(async () => {
  if (!describeWithFixture) return
  server = createServer((request, response) => {
    if ((request.url ?? '').startsWith('/api/health')) {
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }))
    } else if (request.url === '/api/echo') {
      response.writeHead(200).end('{}')
    } else if (request.url === '/api/fail') {
      response.writeHead(500).end('{}')
    } else if (request.url === '/api/slow') {
      setTimeout(() => response.writeHead(200).end('{}'), 500)
    } else if (request.url === '/api/redirect-external') {
      response.writeHead(302, { location: 'https://external.example.test/forbidden' }).end()
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

describeWithFixture('API replay', () => {
  it('replays against the local fixture', async () => {
    const result = await replayHar(har, {
      baseUrl,
      allowedOrigins: [baseUrl],
    })
    expect(result.results.map(item => item.status)).toEqual([200, 200, 500])
    expect(result.results.map(item => item.passed)).toEqual([true, true, false])
  })

  it('blocks non-whitelisted origins without a request', async () => {
    await expect(replayHar(har, { baseUrl: 'https://external.example.test', allowedOrigins: [baseUrl] }))
      .rejects.toThrow('target origin is not whitelisted')
  })

  it('reports timeouts', async () => {
    const timeoutHar = parseHar(JSON.stringify({
      log: { entries: [{ request: { method: 'GET', url: 'https://production.example.test/api/slow' } }] },
    }))
    const result = await replayHar(timeoutHar, {
      baseUrl,
      allowedOrigins: [baseUrl],
      timeoutMs: 100,
    })
    expect(result.results[0].errorKind).toBe('timeout')
  })

  it('blocks redirects to non-whitelisted origins', async () => {
    const redirectHar = parseHar(JSON.stringify({
      log: { entries: [{ request: { method: 'GET', url: 'https://production.example.test/api/redirect-external' } }] },
    }))
    const result = await replayHar(redirectHar, {
      baseUrl,
      allowedOrigins: [baseUrl],
    })
    expect(result.results[0].errorKind).toBe('blocked')
    expect(result.results[0].status).toBe(302)
  })
})
