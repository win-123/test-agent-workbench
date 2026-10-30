import { createServer, type Server } from 'node:http'
import { access, constants, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentOrchestrator } from '../../src/agent/orchestrator.ts'
import { draftStructuredPlan } from '../../src/agent/planner.ts'
import { AssetService } from '../../src/assets/service.ts'
import { CodeAnalysisService } from '../../src/code/service.ts'
import { CoverageService } from '../../src/coverage/service.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const localFixtureAvailable = await canBindLocalFixture()
const k6Path = process.env.TEST_AGENT_K6_PATH ?? '/Users/ztl/Downloads/k6-v1.8.2-macos-arm64/k6'
const k6Available = await access(k6Path, constants.X_OK).then(() => true, () => false)
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const chromeAvailable = await access(chromePath, constants.X_OK).then(() => true, () => false)
const available = localFixtureAvailable && k6Available && chromeAvailable
let server: Server | undefined
let origin = ''

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<main><button type="button">Ready</button><p data-testid="status">ready</p></main>')
      return
    }
    if (request.method === 'GET' && request.url === '/api/orders/ORD-1001') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'ORD-1001', status: 'paid' }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/orders') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ created: true }))
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

describe.skipIf(!available)('phase 7 end-to-end evidence chain', () => {
  it('links import, Java analysis, candidate planning, confirmation, real execution, assets and history', async () => {
    const evidenceDirectory = process.env.PHASE7_EVIDENCE_DIR
    const directory = evidenceDirectory === undefined
      ? await mkdtemp(join(tmpdir(), 'test-agent-phase7-e2e-'))
      : (await mkdir(evidenceDirectory, { recursive: true }), evidenceDirectory)
    const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
    await projects.initialize()
    await projects.create('Phase 7 E2E', directory)
    const imported = await projects.importHar('fixtures/java-project/orders.har')
    expect(imported.requests).toHaveLength(2)
    await projects.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 3000, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 30_000, enginePaths: { k6: k6Path } },
      correlations: [],
      authorization: { confirmed: true, scope: 'Phase 7 local fixture only' },
    })

    const gate = new ProjectRunGate()
    const tasks = new TaskService({ projects, gate })
    const ui = new UiCaseService({ projects, tasks, gate })
    const assets = new AssetService({ projects, tasks, uiCases: ui })
    const code = new CodeAnalysisService({ projects })
    const coverage = new CoverageService({ projects, tasks, assets })
    await assets.scanExisting()
    const apiAsset = (await assets.list()).find(asset => asset.asset_id === 'api-imported-har')!

    const firstApi = await assets.executeAndWait(apiAsset.asset_id)
    const secondApi = await assets.executeAndWait(apiAsset.asset_id)
    expect(firstApi.task.status).toBe('passed')
    expect(secondApi.task.status).toBe('passed')

    const codeResult = await code.analyze('fixtures/java-project')
    const java = codeResult.analysis
    expect(java.endpoints.map(endpoint => `${endpoint.http_method} ${endpoint.path}`)).toEqual(expect.arrayContaining([
      'GET /api/orders/{id}',
      'POST /api/orders',
    ]))
    const analysis = await coverage.analyze(java)
    const coveragePath = await coverage.save(analysis)
    expect(analysis.measurement).toMatchObject({ measured: false, percentage: null })
    const candidate = analysis.candidates.find(item => item.title.startsWith('findOrder') && item.executable_asset_id !== undefined)
    expect(candidate).toBeDefined()
    const executed = await coverage.executePersistedCandidate(analysis.analysis_id, candidate!.candidate_id)
    const executedCandidate = executed.candidates.find(item => item.candidate_id === candidate!.candidate_id)
    expect(executedCandidate?.execution).toMatchObject({ status: 'passed' })
    expect(executedCandidate?.coverage_assertion).toBe('not_measured')

    const now = new Date().toISOString()
    await ui.save({
      schema_version: 'test-agent.ui-case/v1',
      case_id: 'phase7-ui',
      name: 'Phase 7 UI readiness',
      version: 1,
      target_url: `${origin}/`,
      allowed_origins: [origin],
      timeout_ms: 5000,
      headless: true,
      steps: [
        { id: 'open', action: 'navigate', url: `${origin}/` },
        { id: 'ready', action: 'assert', assertion: 'containsText', locator: { kind: 'testId', value: 'status' }, expected: 'ready' },
      ],
      created_at: now,
      updated_at: now,
    })
    const uiSummary = (await ui.list()).find(item => item.case_id === 'phase7-ui')!
    await assets.scanExisting()
    const uiSnapshot = await assets.executeAndWait(`ui-${uiSummary.case_id}`)
    expect(uiSnapshot.task.status).toBe('passed')
    expect(uiSnapshot.task.run_id).toMatch(/^ui_/)

    const script = await tasks.generateScript('k6')
    expect(script.path.endsWith('.js')).toBe(true)
    await assets.scanExisting()
    const performanceAsset = (await assets.list()).find(asset => asset.source_path === script.path.slice(projects.root!.length + 1))
    expect(performanceAsset).toBeDefined()
    const performanceSnapshot = await assets.executeAndWait(performanceAsset!.asset_id)
    expect(performanceSnapshot.task.status).toBe('passed')
    expect(performanceSnapshot.task.run_id).toMatch(/^engine_/)

    const plan = draftStructuredPlan({
      goal: 'Phase 7: verify order API and generate a real performance report',
      taskId: 'agent_phase7_e2e',
      harPath: projects.harPath(),
      baseUrl: origin,
      authorizationScope: 'Phase 7 local fixture only',
      engine: 'k6',
      allowedOrigins: [origin],
    })
    const orchestrator = new AgentOrchestrator({
      workingDirectory: projects.root!,
      stateRoot: join(projects.root!, '.test-agent'),
      outputDir: join(projects.root!, 'output'),
      engineExecutables: { k6: k6Path },
    })
    expect(orchestrator.validatePlan(plan).valid).toBe(true)
    const task = await orchestrator.createTask(plan)
    await expect(orchestrator.executeTask(task.task_id, {})).rejects.toThrow('task requires confirmation')
    expect((await orchestrator.store.load(task.task_id)).tool_calls).toHaveLength(0)
    const confirmed = await orchestrator.confirmTask(task.task_id, task.confirmation.token)
    const agentState = await orchestrator.executeTask(confirmed.task_id, { confirmationToken: confirmed.confirmation.token })
    expect(agentState.status).toBe('succeeded')
    expect(agentState.tool_calls.map(call => call.tool)).toEqual(['har.inspect', 'api.replay', 'engine.run.k6'])
    expect(agentState.run_ids.length).toBeGreaterThanOrEqual(2)
    for (const artifact of agentState.tool_calls.flatMap(call => call.artifacts ?? [])) {
      await access(artifact)
    }

    const comparison = await assets.compare(apiAsset.asset_id, firstApi.task.run_id, secondApi.task.run_id)
    expect(comparison.left.run_id).not.toBe(comparison.right.run_id)
    expect(comparison.facts[0]).toContain('Compared real run')

    if (evidenceDirectory !== undefined) {
      const evidence = {
        schema_version: 'test-agent.phase7-evidence/v1',
        generated_at: new Date().toISOString(),
        project: projects.root,
        facts: [
          `Imported ${imported.requests.length} real HAR requests.`,
          `Java analysis ${java.analysis_id} found ${java.endpoints.length} endpoint declarations and ${java.branches.length} static branches.`,
          `API asset runs ${firstApi.task.run_id} and ${secondApi.task.run_id} both ended ${firstApi.task.status}.`,
          `Candidate ${candidate!.candidate_id} executed ${executedCandidate?.execution?.run_id} with status ${executedCandidate?.execution?.status}.`,
          `UI run ${uiSnapshot.task.run_id} ended ${uiSnapshot.task.status} with ${uiSnapshot.task.result_summary?.passed}/${uiSnapshot.task.result_summary?.total} steps passed.`,
          `k6 run ${performanceSnapshot.task.run_id} ended ${performanceSnapshot.task.status}.`,
          `Agent task ${agentState.task_id} executed tools ${agentState.tool_calls.map(call => call.tool).join(', ')}.`,
          `Coverage measurement is measured=${analysis.measurement.measured}, percentage=${String(analysis.measurement.percentage)}.`,
        ],
        inferences: [
          'The imported GET/POST HAR requests statically match the analyzed Spring order controller declarations by method and normalized path.',
          'The API, UI and performance evidence are associated through this project, task records, asset history and report paths.',
        ],
        hypotheses: [
          {
            statement: 'The identified Java branches may remain uncovered in the implementation runtime.',
            verification: 'Attach a runtime coverage export before assigning covered/uncovered status or a coverage percentage.',
          },
        ],
        code_analysis: { id: java.analysis_id, path: codeResult.path },
        coverage_analysis: { id: analysis.analysis_id, path: coveragePath, measurement: analysis.measurement },
        candidate_execution: executedCandidate?.execution,
        runs: [
          firstApi.task,
          secondApi.task,
          uiSnapshot.task,
          performanceSnapshot.task,
        ].map(task => ({ task_id: task.task_id, run_id: task.run_id, status: task.status, report_path: task.report_path })),
        agent_task: {
          task_id: agentState.task_id,
          status: agentState.status,
          run_ids: agentState.run_ids,
          tool_calls: agentState.tool_calls.map(call => ({ tool: call.tool, status: call.status, artifacts: call.artifacts })),
        },
        comparison,
        limitations: [
          'No runtime coverage input was supplied; static branch evidence is not coverage.',
          'The Java fixture is self-built, not a real business system.',
          'Model planning is not part of this deterministic evidence chain.',
        ],
      }
      await writeFile(join(evidenceDirectory, 'evidence-summary.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    }
    const taskIds = new Set((await tasks.listTasks()).map(record => record.task_id))
    for (const taskId of [firstApi.task.task_id, secondApi.task.task_id, uiSnapshot.task.task_id, performanceSnapshot.task.task_id]) {
      expect(taskIds.has(taskId)).toBe(true)
    }
  })
})
