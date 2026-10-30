import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ParsedHar } from '../../src/har/types.ts'
import { replayHar } from '../../src/api/replay.ts'
import { CredentialService } from '../../src/desktop/credential-service.ts'
import type { SecretCodec } from '../../src/desktop/model-service.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { canBindLocalFixture } from './fixture-support.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'

const available = await canBindLocalFixture()
let server: Server | undefined
let origin = ''
const runtimeTokens = new Set<string>()
const orderIds = new Set<string>()
const orders = new Map<string, { id: string; customer: string }>()

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    if (request.headers['x-tenant-id'] !== 'phase9-tenant') {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'POST' && request.url === '/login') {
      const token = `phase9-token-${Math.random().toString(36).slice(2)}`
      runtimeTokens.add(token)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accessToken: token }))
      return
    }
    if (request.method === 'POST' && request.url === '/orders') {
      const authorization = String(request.headers.authorization ?? '')
      const token = authorization.replace(/^Bearer /, '')
      if (!authorization.startsWith('Bearer phase9-token-') || !runtimeTokens.has(token)) {
        console.log('phase9 auth rejected', { authorization, tokenKnown: runtimeTokens.has(token) })
        response.writeHead(403).end()
        return
      }
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        const input = JSON.parse(raw) as { customer: string }
        const id = `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
        orderIds.add(id)
        orders.set(id, { id, customer: input.customer })
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id, customer: input.customer }))
      })
      return
    }
    const match = /^\/orders\/([^/]+)$/.exec(request.url ?? '')
    if (request.method === 'GET' && match !== null) {
      const order = orders.get(match[1]!)
      if (order === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(order))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describe.skipIf(!available)('phase 9 API credentials and runtime correlations', () => {
  it('runs login -> create -> query with secure tenant injection and per-run variables', async () => {
    const evidenceDirectory = process.env.PHASE9_EVIDENCE_DIR
    const directory = evidenceDirectory === undefined
      ? await mkdtemp(join(tmpdir(), 'test-agent-phase9-correlation-'))
      : (await mkdir(evidenceDirectory, { recursive: true }), evidenceDirectory)
    const codec: SecretCodec = {
      isEncryptionAvailable: () => true,
      encrypt: value => Buffer.from(value).toString('base64'),
      decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
    }
    const credentials = new CredentialService({ appDataDirectory: join(directory, 'credentials'), codec })
    await credentials.save({
      id: 'phase9_tenant',
      label: 'Phase 9 tenant',
      kind: 'header',
      headerName: 'X-Tenant-ID',
      secret: 'phase9-tenant',
    })
    const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
    await projects.initialize()
    await projects.create('Phase 9 correlation', directory)
    await projects.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 3000, concurrency: 10, assertions: [{ index: 2, status: 200 }] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
      correlations: [
        { sourceIndex: 0, jsonPath: '$.accessToken', variableName: 'accessToken', targetIndexes: [], targetHeaders: [{ index: 1, name: 'Authorization', value: 'Bearer ${accessToken}' }] },
        { sourceIndex: 1, jsonPath: '$.id', variableName: 'orderId', targetIndexes: [2] },
      ],
      authorization: { confirmed: true, scope: 'local phase 9 fixture only' },
      credentialRef: 'safe://phase9_tenant',
    })
    const tasks = new TaskService({ projects, gate: new ProjectRunGate(), credentials })
    const started = await tasks.startApiSelection(har(), 'Phase 9 correlation')
    const snapshot = await tasks.waitForTask(started.task_id)
    expect(snapshot.task.status).toBe('passed')
    expect(snapshot.report).toMatchObject({ total: 3, passed: 3, failed: 0 })
    const reportText = await readFile(join(projects.root!, snapshot.task.report_path!), 'utf8')
    expect(reportText).not.toContain('phase9-tenant')
    expect(reportText).not.toContain('phase9-token-')
    expect(reportText).toContain('"variable_name": "accessToken"')
    expect(reportText).toContain('"variable_name": "orderId"')
    const logText = await readFile(join(projects.root!, snapshot.task.log_path!), 'utf8')
    expect(logText).not.toContain('phase9-tenant')
    expect(logText).not.toContain('phase9-token-')
    expect(orderIds.size).toBeGreaterThanOrEqual(1)
    if (evidenceDirectory !== undefined) {
      await writeFile(join(evidenceDirectory, 'api-correlation-summary.json'), `${JSON.stringify({
        schema_version: 'test-agent.phase9-correlation/v1',
        generated_at: new Date().toISOString(),
        environment_kind: 'local fixture',
        project: projects.root,
        task_id: snapshot.task.task_id,
        run_id: snapshot.task.run_id,
        status: snapshot.task.status,
        report_path: snapshot.task.report_path,
        request_summary: snapshot.task.result_summary,
        correlation_results: (snapshot.report as typeof snapshot.report extends infer T ? T : never) && (snapshot.report as { correlation_results?: unknown[] }).correlation_results,
        security: {
          credential_secret_in_report: false,
          runtime_token_in_report: false,
          credential_secret_in_log: false,
          runtime_token_in_log: false,
        },
      }, null, 2)}\n`, { mode: 0o600 })
    }
  })

  it('keeps runtime variables isolated between concurrent replays', async () => {
    const [left, right] = await Promise.all([
      replayHar(har(), { baseUrl: origin, allowedOrigins: [origin], headers: { 'X-Tenant-ID': 'phase9-tenant' }, correlations: correlations() }),
      replayHar(har(), { baseUrl: origin, allowedOrigins: [origin], headers: { 'X-Tenant-ID': 'phase9-tenant' }, correlations: correlations() }),
    ])
    expect(left.results.every(result => result.passed)).toBe(true)
    expect(right.results.every(result => result.passed)).toBe(true)
    expect(left.correlationResults).toHaveLength(2)
    expect(right.correlationResults).toHaveLength(2)
    expect(orderIds.size).toBeGreaterThanOrEqual(2)
    expect(runtimeTokens.size).toBeGreaterThanOrEqual(2)
  })

  it('reports extraction and missing-variable failures without leaking values', async () => {
    const missing = await replayHar(missingExtractionHar(), {
      baseUrl: origin,
      allowedOrigins: [origin],
      headers: { 'X-Tenant-ID': 'phase9-tenant' },
      correlations: [{ sourceIndex: 0, jsonPath: '$.missing', variableName: 'missing', targetIndexes: [1] }],
    })
    expect(missing.results[0]?.passed).toBe(false)
    expect(missing.results[0]?.errorKind).toBe('correlation')
    expect(missing.results[1]?.errorKind).toBe('correlation')
    expect(JSON.stringify(missing)).not.toContain('phase9-token-')
  })
})

function correlations() {
  return [
    { sourceIndex: 0, jsonPath: '$.accessToken', variableName: 'accessToken', targetIndexes: [], targetHeaders: [{ index: 1, name: 'Authorization', value: 'Bearer ${accessToken}' }] },
    { sourceIndex: 1, jsonPath: '$.id', variableName: 'orderId', targetIndexes: [2] },
  ]
}

function har(): ParsedHar {
  return {
    entries: [
      request(0, 'POST', '/login', '{"username":"demo"}'),
      request(1, 'POST', '/orders', '{"customer":"Acme Phase 9"}'),
      request(2, 'GET', '/orders/${orderId}'),
    ],
  }
}

function missingExtractionHar(): ParsedHar {
  return {
    entries: [
      request(0, 'POST', '/login', '{"username":"demo"}'),
      request(1, 'GET', '/orders/${missing}'),
    ],
  }
}

function request(order: number, method: string, path: string, body?: string): ParsedHar['entries'][number] {
  return {
    order,
    method,
    url: `${origin}${path}`,
    origin,
    path,
    query: [],
    headers: [],
    ...body === undefined ? {} : { body },
  }
}
