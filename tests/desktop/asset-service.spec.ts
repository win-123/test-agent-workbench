import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetService } from '../../src/assets/service.ts'
import { ASSET_SCHEMA_VERSION } from '../../src/assets/types.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'
import { validCase } from '../helpers/ui-case.ts'
import { fakeEngine } from './helpers.ts'

describe('unified test asset service', () => {
  it('discovers native HAR, UI and performance assets without converting their formats', async () => {
    const { assets, ui, projects } = await setup()
    await ui.save(validCase())
    await writeFile(join(projects.root!, 'scripts', 'saved.k6.js'), 'export default function () {}\n')
    const scanned = await assets.scanExisting()
    expect(scanned.map(asset => asset.kind)).toEqual(expect.arrayContaining(['api', 'ui', 'performance']))
    const api = scanned.find(asset => asset.kind === 'api')!
    expect(api.source_format).toBe('har')
    expect((await assets.get(api.asset_id)).execution).toMatchObject({
      mode: 'api-selection',
      request_orders: [0, 1, 2],
    })
    const secondScan = await assets.scanExisting()
    expect(secondScan).toHaveLength(scanned.length)
  })

  it('versions metadata, rejects secrets in references, and records real repeated runs', async () => {
    const { assets, projects, tasks, directory } = await setup()
    const scanned = await assets.scanExisting()
    const api = scanned.find(asset => asset.kind === 'api')!
    const current = await assets.get(api.asset_id)
    await assets.save({
      ...current,
      name: 'API asset v2',
      version: 2,
      environment: { name: 'staging', variable_refs: ['BASE_URL'] },
      credential_refs: ['env://TEST_API_TOKEN'],
      updated_at: new Date().toISOString(),
    }, current.version)
    await expect(assets.save({
      ...current,
      version: 2,
      credential_refs: ['Bearer plaintext-secret'],
    }, current.version)).rejects.toThrow('opaque references')

    const executable = await fakeEngine(directory, 'pass')
    const config = projects.currentConfig()
    await projects.saveConfig({
      target: config.target,
      environment: config.environment,
      api: config.api,
      performance: { ...config.performance, enginePaths: { k6: executable } },
      correlations: config.correlations,
      authorization: config.authorization,
    })

    for (let index = 0; index < 2; index += 1) {
      const started = await assets.execute(api.asset_id)
      await tasks.waitForTask(started.task_id)
    }
    const history = await waitForHistory(assets, api.asset_id)
    expect(history.runs).toHaveLength(2)
    expect(history.runs.every(run => run.report_path?.endsWith('.json'))).toBe(true)
    const comparison = await assets.compare(api.asset_id)
    expect(comparison.left.run_id).not.toBe(comparison.right.run_id)
    expect(comparison.facts[0]).toContain('Compared real run')
  })

  it('rejects an execution that escapes the project through an execution path', async () => {
    const { assets } = await setup()
    const now = new Date().toISOString()
    await expect(assets.save({
      schema_version: ASSET_SCHEMA_VERSION,
      asset_id: 'bad-path',
      name: 'bad path',
      kind: 'performance',
      version: 1,
      source_format: 'k6-js',
      source_path: '../escape.js',
      execution: { mode: 'performance-script', engine: 'k6', script_path: '../escape.js' },
      environment: { name: 'default', variable_refs: [] },
      credential_refs: [],
      test_data_refs: [],
      tags: [],
      created_at: now,
      updated_at: now,
    })).rejects.toThrow('stay inside the project')
  })
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-assets-'))
  const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
  await projects.initialize()
  await projects.create('Assets', directory)
  await projects.importHar('samples/demo.har')
  await projects.saveConfig({
    target: {
      baseUrl: 'http://127.0.0.1:9',
      allowedOrigins: ['http://127.0.0.1:9'],
      allowedPaths: [],
    },
    environment: { headers: {} },
    api: { timeoutMs: 500, concurrency: 1, assertions: [] },
    performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
    correlations: [],
    authorization: { confirmed: true, scope: 'local failure evidence only' },
  })
  const gate = new ProjectRunGate()
  const tasks = new TaskService({ projects, gate })
  const ui = new UiCaseService({ projects, tasks, gate })
  return {
    directory,
    projects,
    tasks,
    ui,
    assets: new AssetService({ projects, tasks, uiCases: ui }),
  }
}

async function waitForHistory(assets: AssetService, assetId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const history = await assets.history(assetId)
    if (history.runs.length >= 2) return history
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return await assets.history(assetId)
}
