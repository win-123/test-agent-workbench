import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AssetService } from '../../src/assets/service.ts'
import { analyzeJavaSource } from '../../src/code/java-analyzer.ts'
import { CoverageService } from '../../src/coverage/service.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const available = await canBindLocalFixture()
let server: Server | undefined
let origin = ''

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/orders/ORD-1001') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'ORD-1001', status: 'paid' }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
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

describe.skipIf(!available)('candidate execution evidence', () => {
  it('runs a generated API candidate through the existing replay executor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-candidate-execution-'))
    const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
    await projects.initialize()
    await projects.create('Candidate execution', directory)
    await projects.importHar('fixtures/java-project/orders.har')
    await projects.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 2000, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'local candidate fixture only' },
    })
    const gate = new ProjectRunGate()
    const tasks = new TaskService({ projects, gate })
    const ui = new UiCaseService({ projects, tasks, gate })
    const assets = new AssetService({ projects, tasks, uiCases: ui })
    await assets.scanExisting()
    const coverage = new CoverageService({ projects, tasks, assets })
    const analysis = await coverage.analyze(await analyzeJavaSource('fixtures/java-project'))
    const candidate = analysis.candidates.find(item => item.executable_asset_id !== undefined && item.title.startsWith('findOrder'))
    expect(candidate).toBeDefined()
    const executed = await coverage.executeCandidate(analysis, candidate!.candidate_id)
    expect(executed.execution).toMatchObject({ status: 'passed' })
    expect(executed.execution?.run_id).toMatch(/^run_/)
    expect(executed.execution?.report_path).toContain('output/')
    expect(executed.coverage_assertion).toBe('not_measured')
  })
})
