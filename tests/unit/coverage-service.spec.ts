import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetService } from '../../src/assets/service.ts'
import { analyzeJavaSource } from '../../src/code/java-analyzer.ts'
import { CoverageService } from '../../src/coverage/service.ts'
import { RUNTIME_COVERAGE_SCHEMA_VERSION } from '../../src/coverage/types.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'

describe('coverage analysis and candidate generation', () => {
  it('never invents a percentage without runtime evidence and creates executable API candidates', async () => {
    const { coverage, java } = await setup()
    const analysis = await coverage.analyze(java)
    expect(analysis.measurement).toMatchObject({
      measured: false,
      percentage: null,
      covered_branches: 0,
    })
    expect(analysis.limitations).toContain('No runtime coverage input was supplied; no coverage percentage is calculated.')
    expect(analysis.links.find(link => link.endpoint.method === 'findOrder')?.asset_ids.length).toBeGreaterThan(0)
    const candidate = analysis.candidates.find(item => item.title.startsWith('findOrder') && item.executable_asset_id !== undefined)
    expect(candidate).toMatchObject({
      kind: 'api',
      coverage_assertion: 'not_measured',
      basis: { evidence_type: 'static' },
    })
    expect(candidate?.hypothesis.verification).toContain('separately obtain runtime coverage')
  })

  it('marks a branch from supplied runtime data as uncovered and computes only the scoped percentage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-coverage-'))
    const { coverage, java } = await setup()
    const branch = java.branches.find(item => item.method === 'findOrder')!
    const coveragePath = join(directory, 'coverage.json')
    await writeFile(coveragePath, JSON.stringify({
      schema_version: RUNTIME_COVERAGE_SCHEMA_VERSION,
      tool: 'test-fixture',
      measured_at: new Date().toISOString(),
      branches: [{
        file: branch.evidence.file,
        line: branch.line,
        covered: false,
      }],
    }))
    const analysis = await coverage.analyze(java, coveragePath)
    expect(analysis.measurement).toMatchObject({
      measured: true,
      tool: 'test-fixture',
      matched_branches: 1,
      covered_branches: 0,
      percentage: 0,
    })
    expect(analysis.measurement.note).toContain('not whole-project coverage')
    expect(analysis.candidates.find(item => item.title.startsWith('findOrder'))?.coverage_assertion).toBe('runtime_uncovered')
    expect(analysis.branch_states.find(state => state.branch.id === branch.id)?.runtime).toBe('uncovered')
  })

  it('persists candidate evidence and rejects manual candidates from execution', async () => {
    const { coverage, java } = await setup()
    const analysis = await coverage.analyze(java)
    const path = await coverage.save(analysis)
    expect(path).toContain('.test-agent/coverage/')
    const manual = analysis.candidates.find(item => item.kind === 'manual')
    expect(manual).toBeDefined()
    await expect(coverage.executeCandidate(analysis, manual!.candidate_id)).rejects.toThrow('manual-review')
  })
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-coverage-setup-'))
  const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
  await projects.initialize()
  await projects.create('Coverage fixture', directory)
  await projects.importHar('fixtures/java-project/orders.har')
  await projects.saveConfig({
    target: {
      baseUrl: 'http://127.0.0.1:18090',
      allowedOrigins: ['http://127.0.0.1:18090'],
      allowedPaths: [],
    },
    environment: { headers: {} },
    api: { timeoutMs: 1000, concurrency: 1, assertions: [] },
    performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
    correlations: [],
    authorization: { confirmed: true, scope: 'local fixture only' },
  })
  const gate = new ProjectRunGate()
  const tasks = new TaskService({ projects, gate })
  const ui = new UiCaseService({ projects, tasks, gate })
  const assets = new AssetService({ projects, tasks, uiCases: ui })
  await assets.scanExisting()
  return {
    java: await analyzeJavaSource('fixtures/java-project'),
    coverage: new CoverageService({ projects, tasks, assets }),
  }
}
