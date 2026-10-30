import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AssetService } from '../../src/assets/service.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const available = await canBindLocalFixture()
let server: Server | undefined
let origin = ''
let sawEnvironmentHeader = false

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    if (request.headers['x-test-environment'] === 'phase8-local') sawEnvironmentHeader = true
    if (request.method === 'GET' && request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        status: 'ok',
        access_token: 'phase8-secret-token',
        password: 'phase8-secret-password',
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/echo') {
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ echoed: raw }))
      })
      return
    }
    if (request.method === 'GET' && request.url === '/api/fail') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'expected server failure' }))
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

describe.skipIf(!available)('phase 8 local MVP API trial', () => {
  it('imports, configures, replays, persists and compares a realistic local API fixture', async () => {
    const evidenceDirectory = process.env.PHASE8_EVIDENCE_DIR
    const directory = evidenceDirectory === undefined
      ? await mkdtemp(join(tmpdir(), 'test-agent-phase8-api-'))
      : (await mkdir(evidenceDirectory, { recursive: true }), evidenceDirectory)
    const appData = join(directory, 'app-data')
    const projects = new ProjectService({ appDataDirectory: appData })
    await projects.initialize()
    await projects.create('Phase 8 MVP API', directory)

    const sourceHar = join(directory, 'source.har')
    await writeFile(sourceHar, JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'phase8', version: '1.0' },
        entries: [
          requestEntry('GET', '/api/health', [{ name: 'Authorization', value: 'Bearer phase8-input-secret' }]),
          requestEntry('POST', '/api/echo', [{ name: 'Content-Type', value: 'application/json' }], '{"password":"phase8-input-password","message":"ok"}'),
          requestEntry('GET', '/api/fail'),
        ],
      },
    }))

    const imported = await projects.importHar(sourceHar)
    expect(imported.config.target.baseUrl).toBe('')
    expect(imported.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      'GET /api/health',
      'POST /api/echo',
      'GET /api/fail',
    ])
    expect(JSON.stringify(imported.requests)).not.toContain('phase8-input-secret')
    expect(JSON.stringify(imported.requests)).not.toContain('phase8-input-password')

    await projects.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: { 'X-Test-Environment': 'phase8-local' } },
      api: {
        timeoutMs: 3000,
        concurrency: 1,
        assertions: [
          { index: 0, status: 200, jsonPath: '$.status', equals: 'ok' },
          { index: 1, status: 200, contains: 'ok' },
          { index: 2, status: 200 },
        ],
      },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 10000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'Phase 8 local MVP fixture only; no production target' },
    })

    const gate = new ProjectRunGate()
    const tasks = new TaskService({ projects, gate })
    const ui = new UiCaseService({ projects, tasks, gate })
    const assets = new AssetService({ projects, tasks, uiCases: ui })
    await assets.scanExisting()
    const asset = (await assets.list()).find(item => item.asset_id === 'api-imported-har')
    expect(asset).toBeDefined()

    const first = await assets.executeAndWait(asset!.asset_id)
    const second = await assets.executeAndWait(asset!.asset_id)
    expect(first.task.status).toBe('test_failed')
    expect(second.task.status).toBe('test_failed')
    expect(first.task.run_id).toMatch(/^run_/)
    expect(second.task.run_id).not.toBe(first.task.run_id)

    const firstReportDocument = JSON.parse(await readFile(join(projects.root!, first.task.report_path!), 'utf8')) as { requests?: Array<{ error_kind?: string }> }
    const firstReport = JSON.stringify(firstReportDocument)
    expect(firstReport).not.toContain('phase8-secret-token')
    expect(firstReport).not.toContain('phase8-secret-password')
    expect(firstReport).not.toContain('phase8-input-secret')
    expect(firstReport).not.toContain('phase8-input-password')
    expect(firstReportDocument.requests?.find(request => request.error_kind === 'http')).toBeDefined()
    expect(firstReport).toContain('HTTP status mismatch')
    expect(sawEnvironmentHeader).toBe(true)

    const comparison = await assets.compare(asset!.asset_id, first.task.run_id, second.task.run_id)
    expect(comparison.facts[0]).toContain('Compared real run')

    const reopenedProjects = new ProjectService({ appDataDirectory: appData })
    await reopenedProjects.initialize()
    await reopenedProjects.open(projects.root!)
    const reopenedTasks = new TaskService({ projects: reopenedProjects, gate })
    const records = await reopenedTasks.listTasks()
    expect(records.map(record => record.task_id)).toEqual(expect.arrayContaining([first.task.task_id, second.task.task_id]))
    const reopenedReport = await reopenedTasks.getTask(first.task.task_id)
    expect(reopenedReport.task.report_path).toBe(first.task.report_path)
    expect(reopenedReport.report).toBeDefined()

    if (evidenceDirectory !== undefined) {
      await writeFile(join(evidenceDirectory, 'api-trial-summary.json'), `${JSON.stringify({
        schema_version: 'test-agent.phase8-api-trial/v1',
        generated_at: new Date().toISOString(),
        environment_kind: 'local fixture',
        project: projects.root,
        target: { base_url: origin, environment_header: 'X-Test-Environment' },
        request_overview: imported.requests.map(request => ({ method: request.method, path: request.path })),
        assertions: projects.currentConfig().api.assertions,
        runs: [first.task, second.task].map(task => ({
          task_id: task.task_id,
          run_id: task.run_id,
          status: task.status,
          result_summary: task.result_summary,
          report_path: task.report_path,
        })),
        comparison,
        persistence_check: {
          reopened: true,
          task_records_found: 2,
          report_loaded: true,
        },
        security: {
          input_authorization_redacted: true,
          input_password_redacted: true,
          response_token_redacted: true,
          response_password_redacted: true,
        },
      }, null, 2)}\n`, { mode: 0o600 })
    }
  })
})

function requestEntry(method: string, path: string, headers: Array<{ name: string; value: string }> = [], body?: string) {
  return {
    request: {
      method,
      url: `https://production.example.test${path}`,
      headers,
      queryString: [],
      ...body === undefined ? {} : { postData: { mimeType: 'application/json', text: body } },
    },
  }
}
