import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ParsedHar } from '../../src/har/types.ts'
import { replayHar } from '../../src/api/replay.ts'
import { createReport } from '../../src/results/result.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const available = await canBindLocalFixture()
const credentialSecret = `p10-credential-${randomBytes(12).toString('hex')}`
const runtimeSecret = `p10-session-${randomBytes(12).toString('hex')}`
let server: Server | undefined
let origin = ''
let apixRequests = 0

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test')
    if (request.method === 'POST' && url.pathname === '/token') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ session: runtimeSecret }))
      return
    }
    if (request.method === 'POST' && url.pathname === `/api/items/${runtimeSecret}`) {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (request.headers['x-session'] !== runtimeSecret
          || request.headers['x-api-key'] !== credentialSecret
          || body !== JSON.stringify({ echo: runtimeSecret })) {
          response.writeHead(403).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, echo: runtimeSecret }))
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/orders') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/apix') {
      apixRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ escaped: true }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/auth-failure') {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/server-failure') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'expected server failure' }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/invalid-response') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('not-json')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describe.skipIf(!available)('phase 10 local real-API readiness controls', () => {
  it('keeps runtime values out of reports while classifying auth, HTTP, and assertion failures', async () => {
    const chain = await replayHar({
      entries: [
        request(0, 'POST', '/token', '{}'),
        request(1, 'POST', `/api/items/${'${session}'}`, `{"echo":"${'${session}'}"}`),
      ],
    }, {
      baseUrl: origin,
      allowedOrigins: [origin],
      headers: { 'X-API-Key': credentialSecret },
      assertions: [{ index: 1, status: 200, jsonPath: '$.echo', equals: runtimeSecret }],
      correlations: [{
        sourceIndex: 0,
        jsonPath: '$.session',
        variableName: 'session',
        targetIndexes: [1],
        targetHeaders: [{ index: 1, name: 'X-Session', value: '${session}' }],
      }],
    })
    const report = createReport(chain, {}, { environment_kind: 'local loopback fixture' })
    const reportText = JSON.stringify(report)
    expect(report).toMatchObject({ total: 2, passed: 2, failed: 0 })
    expect(report.correlation_results).toEqual([
      expect.objectContaining({ variable_name: 'session', status: 'extracted', target_indexes: [1] }),
    ])
    expect(report.requests[1]?.path).toContain('[REDACTED]')
    expect(reportText).not.toContain(runtimeSecret)
    expect(reportText).not.toContain(credentialSecret)

    const auth = await replayHar(har('/auth-failure'), {
      baseUrl: origin,
      allowedOrigins: [origin],
    })
    expect(auth.results[0]).toMatchObject({ status: 401, passed: false, errorKind: 'auth' })

    const serverFailure = await replayHar(har('/server-failure'), {
      baseUrl: origin,
      allowedOrigins: [origin],
    })
    expect(serverFailure.results[0]).toMatchObject({ status: 500, passed: false, errorKind: 'http' })

    const invalidResponse = await replayHar(har('/invalid-response'), {
      baseUrl: origin,
      allowedOrigins: [origin],
      assertions: [{ index: 0, status: 200, jsonPath: '$.ok', equals: true }],
    })
    expect(invalidResponse.results[0]).toMatchObject({ status: 200, passed: false, errorKind: 'assertion' })
    expect(invalidResponse.results[0]?.assertions.find(item => item.name === 'json $.ok equals')?.error)
      .toContain('cannot evaluate JSON assertion')

    const blocked = await replayHar(har('/apix'), {
      baseUrl: origin,
      allowedOrigins: [origin],
      allowedPaths: ['/api/**'],
    })
    expect(blocked.results[0]).toMatchObject({ passed: false, errorKind: 'blocked' })
    expect(apixRequests).toBe(0)

    const allowed = await replayHar(har('/api/orders'), {
      baseUrl: origin,
      allowedOrigins: [origin],
      allowedPaths: ['/api/**'],
    })
    expect(allowed.results[0]).toMatchObject({ status: 200, passed: true })

    const evidenceDirectory = process.env.PHASE10_EVIDENCE_DIR
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true })
      await writeFile(join(evidenceDirectory, 'local-readiness-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      await writeFile(join(evidenceDirectory, 'local-readiness-summary.json'), `${JSON.stringify({
        schema_version: 'test-agent.phase10-local-readiness/v1',
        generated_at: new Date().toISOString(),
        environment_kind: 'local loopback fixture',
        status: 'passed',
        runs: {
          correlation: chain.runId,
          auth_failure: auth.runId,
          server_failure: serverFailure.runId,
          invalid_response: invalidResponse.runId,
          blocked_path: blocked.runId,
          allowed_path: allowed.runId,
        },
        checks: {
          credential_header_injected: true,
          path_body_and_header_correlations_injected: true,
          dynamic_values_absent_from_report: true,
          credential_value_absent_from_report: true,
          assertion_values_absent_from_report: true,
          auth_failure_classified: true,
          server_failure_classified: true,
          invalid_response_assertion_classified: true,
          path_prefix_boundary_enforced: true,
        },
      }, null, 2)}\n`, { mode: 0o600 })
    }
  })
})

function har(path: string): ParsedHar {
  return { entries: [request(0, 'GET', path)] }
}

function request(index: number, method: string, path: string, body?: string): ParsedHar['entries'][number] {
  return {
    order: index,
    method,
    url: `${origin}${path}`,
    origin,
    path,
    query: [],
    headers: [],
    ...body === undefined ? {} : { body },
  }
}
