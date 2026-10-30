import { readFile, readdir } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AssetService } from '../assets/service.ts'
import type { TestAsset } from '../assets/types.ts'
import type { JavaAnalysis, JavaBranch } from '../code/types.ts'
import type { ProjectService } from '../desktop/project-service.ts'
import type { TaskService } from '../desktop/task-service.ts'
import { assertSafeTaskId, resolveInside } from '../desktop/security.ts'
import {
  COVERAGE_SCHEMA_VERSION,
  RUNTIME_COVERAGE_SCHEMA_VERSION,
  type CoverageAnalysis,
  type CoverageAnalysisSummary,
  type CoverageBranchState,
  type CoverageMeasurement,
  type EndpointTestLink,
  type RuntimeCoverageInput,
  type TestCandidate,
} from './types.ts'

export interface CoverageServiceOptions {
  projects: ProjectService
  tasks: TaskService
  assets: AssetService
  maxCandidates?: number
}

export class CoverageService {
  private readonly projects: ProjectService
  private readonly tasks: TaskService
  private readonly assets: AssetService
  private readonly maxCandidates: number

  constructor(options: CoverageServiceOptions) {
    this.projects = options.projects
    this.tasks = options.tasks
    this.assets = options.assets
    this.maxCandidates = Math.min(Math.max(options.maxCandidates ?? 40, 1), 200)
  }

  async analyze(java: JavaAnalysis, runtimeCoveragePath?: string): Promise<CoverageAnalysis> {
    const runtime = runtimeCoveragePath === undefined
      ? undefined
      : validateRuntimeCoverage(JSON.parse(await readFile(runtimeCoveragePath, 'utf8')) as unknown)
    const branchStates = measureBranches(java, runtime)
    const measurement = summarizeMeasurement(branchStates, runtime)
    const assets = await this.assets.list()
    const links = await this.buildLinks(java, assets)
    const candidates: TestCandidate[] = []
    for (const branchState of branchStates) {
      if (candidates.length >= this.maxCandidates) break
      if (branchState.runtime === 'covered') continue
      const link = links.find(item => item.endpoint.class_name === branchState.branch.class_name && item.endpoint.method === branchState.branch.method)
      const candidate = await this.createBranchCandidate(java, branchState, link, branchState.runtime === 'uncovered' ? 'runtime' : 'static')
      if (candidate !== undefined) candidates.push(candidate)
    }
    if (java.branches.length > this.maxCandidates) {
      candidates.push({
        candidate_id: `candidate-limit-${shortId()}`,
        title: 'Additional branches require manual prioritization',
        kind: 'manual',
        priority: 'medium',
        basis: { evidence_type: 'static', evidence: java.branches.slice(this.maxCandidates).map(branch => branch.evidence) },
        hypothesis: {
          statement: `${java.branches.length - this.maxCandidates} additional static branches were not auto-converted into candidates.`,
          verification: 'Review the Java analysis and select branches that carry business risk.',
        },
        proposed_test: { steps: ['Review remaining branch evidence', 'Select explicit test data', 'Create a versioned test asset'] },
        coverage_assertion: 'not_measured',
        created_at: new Date().toISOString(),
      })
    }
    return {
      schema_version: COVERAGE_SCHEMA_VERSION,
      analysis_id: `coverage_${timestamp()}_${shortId()}`,
      code_analysis_id: java.analysis_id,
      created_at: new Date().toISOString(),
      measurement,
      branch_states: branchStates,
      links,
      candidates,
      limitations: [
        'Static endpoint mapping does not prove runtime reachability.',
        'Executing a candidate does not imply its target branch was covered unless runtime coverage separately proves it.',
        ...(runtime === undefined ? ['No runtime coverage input was supplied; no coverage percentage is calculated.'] : []),
      ],
    }
  }

  async executeCandidate(analysis: CoverageAnalysis, candidateId: string): Promise<TestCandidate> {
    const candidate = analysis.candidates.find(item => item.candidate_id === candidateId)
    if (candidate === undefined) throw new Error(`test candidate not found: ${candidateId}`)
    if (candidate.executable_asset_id === undefined) throw new Error('candidate is manual-review only and has no executable asset')
    if (candidate.execution !== undefined) throw new Error('candidate already has an execution record; create a new candidate for a repeat run')
    const started = await this.assets.execute(candidate.executable_asset_id)
    const snapshot = await this.tasks.waitForTask(started.task_id)
    const runId = snapshot.task.run_id ?? started.run_id
    candidate.execution = {
      task_id: started.task_id,
      ...runId === undefined ? {} : { run_id: runId },
      status: snapshot.task.status,
      ...snapshot.task.report_path === undefined ? {} : { report_path: snapshot.task.report_path },
      completed_at: new Date().toISOString(),
    }
    return candidate
  }

  async save(analysis: CoverageAnalysis): Promise<string> {
    const root = this.requireRoot()
    assertSafeTaskId(analysis.analysis_id)
    const path = resolveInside(root, join('.test-agent', 'coverage', `${analysis.analysis_id}.json`))
    await this.assetsWrite(path, `${JSON.stringify(analysis, null, 2)}\n`)
    return path
  }

  async get(analysisId: string): Promise<CoverageAnalysis> {
    const root = this.requireRoot()
    assertSafeTaskId(analysisId)
    const path = resolveInside(root, join('.test-agent', 'coverage', `${analysisId}.json`))
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('coverage analysis must be an object')
    const analysis = parsed as CoverageAnalysis
    if (analysis.schema_version !== COVERAGE_SCHEMA_VERSION || analysis.analysis_id !== analysisId) throw new Error('invalid coverage analysis record')
    return analysis
  }

  async list(): Promise<CoverageAnalysisSummary[]> {
    const root = this.requireRoot()
    const directory = resolveInside(root, join('.test-agent', 'coverage'))
    const entries = await readdir(directory).catch(() => [])
    const values: CoverageAnalysisSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const analysis = await this.get(entry.slice(0, -5))
        values.push({
          analysis_id: analysis.analysis_id,
          code_analysis_id: analysis.code_analysis_id,
          created_at: analysis.created_at,
          measurement: analysis.measurement,
          candidates: analysis.candidates,
          path: join('.test-agent', 'coverage', entry),
        })
      } catch {
        // Ignore incomplete coverage files.
      }
    }
    return values.sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  async executePersistedCandidate(analysisId: string, candidateId: string): Promise<CoverageAnalysis> {
    const analysis = await this.get(analysisId)
    await this.executeCandidate(analysis, candidateId)
    await this.save(analysis)
    return analysis
  }

  private async buildLinks(java: JavaAnalysis, assets: Awaited<ReturnType<AssetService['list']>>): Promise<EndpointTestLink[]> {
    const links: EndpointTestLink[] = []
    for (const endpoint of java.endpoints) {
      const implementation = endpoint.evidence
      const linkedAssets: TestAsset[] = []
      for (const summary of assets) {
        const asset = await this.assets.get(summary.asset_id)
        if (asset.execution.mode !== 'api-selection' || asset.source_path !== this.projects.currentConfig().har_file) continue
        const history = await this.assets.history(asset.asset_id)
        const requests = await this.projects.readHar()
        if (asset.execution.request_orders.some(order => {
          const request = requests.entries.find(entry => entry.order === order)
          return request !== undefined && requestMatches(endpoint.http_method, endpoint.path, request.method, request.path)
        })) {
          linkedAssets.push(asset)
          links.push({
            endpoint,
            implementation,
            asset_ids: [asset.asset_id],
            run_ids: history.runs.map(run => run.run_id),
            evidence: history.runs.length > 0 ? 'runtime-evidence' : 'static-mapping',
          })
        }
      }
      if (linkedAssets.length === 0) {
        links.push({ endpoint, implementation, asset_ids: [], run_ids: [], evidence: 'static-mapping' })
      }
    }
    return links
  }

  private async createBranchCandidate(
    java: JavaAnalysis,
    branchState: CoverageBranchState,
    link: EndpointTestLink | undefined,
    evidenceType: 'static' | 'runtime',
  ): Promise<TestCandidate | undefined> {
    const branch = branchState.branch
    const branchKey = createHash('sha256')
      .update(`${branch.class_name}.${branch.method}:${branch.id}:${branch.line ?? ''}`)
      .digest('hex')
      .slice(0, 10)
    const candidateId = `candidate-${java.analysis_id}-${branchKey}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100)
    let executableAssetId: string | undefined
    let requestOrder: number | undefined
    if (link !== undefined) {
      const match = await this.findMatchingRequest(link.endpoint.http_method, link.endpoint.path)
      if (match !== undefined) {
        requestOrder = match.order
        if (link.asset_ids[0] === undefined) return undefined
        const asset = await this.assets.get(link.asset_ids[0])
        try {
          await this.assets.save({
            ...asset,
            asset_id: candidateId,
            name: `Candidate · ${branch.class_name}.${branch.method} · ${branch.condition}`.slice(0, 200),
            description: 'Generated from static Java branch evidence. Execution does not prove branch coverage.',
            version: 1,
            execution: {
              mode: 'api-selection',
              har_path: asset.execution.mode === 'api-selection' ? asset.execution.har_path : this.projects.currentConfig().har_file!,
              request_orders: [match.order],
            },
            tags: ['candidate', 'static-branch', branch.kind],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          executableAssetId = candidateId
        } catch (error) {
          if (!(error as Error).message.includes('already')) throw error
          const existing = await this.assets.get(candidateId)
          executableAssetId = existing.asset_id
        }
      }
    }
    return {
      candidate_id: candidateId,
      title: `${branch.method} · ${branch.kind} branch at line ${branch.line ?? 'unknown'}`,
      kind: executableAssetId === undefined ? 'manual' : 'api',
      priority: branch.risk,
      basis: {
        evidence_type: evidenceType,
        evidence: [branch.evidence, ...link === undefined ? [] : [link.implementation]],
      },
      hypothesis: {
        statement: `The branch \`${branch.condition}\` may hide an untested behavior in ${branch.class_name}.${branch.method}.`,
        verification: requestOrder === undefined
          ? 'Create explicit request data and run it through the existing API or UI executor.'
          : 'Execute the linked HAR request with explicit input designed for this branch; separately obtain runtime coverage before claiming it covered.',
      },
      proposed_test: {
        ...link === undefined ? {} : { http_method: link.endpoint.http_method, path: link.endpoint.path },
        ...requestOrder === undefined ? {} : { request_order: requestOrder },
        steps: [
          `Prepare data that forces ${branch.kind} at ${branch.evidence.file}:${branch.line ?? '?'}`,
          'Observe the real HTTP/UI result',
          'Attach runtime coverage evidence before marking the branch covered',
        ],
      },
      ...executableAssetId === undefined ? {} : { executable_asset_id: executableAssetId },
      coverage_assertion: branchState.runtime === 'uncovered' ? 'runtime_uncovered' : 'not_measured',
      created_at: new Date().toISOString(),
    }
  }

  private async findMatchingRequest(httpMethod: string, path: string) {
    const har = await this.projects.readHar()
    return har.entries.find(entry => requestMatches(httpMethod, path, entry.method, entry.path))
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }

  private async assetsWrite(path: string, content: string): Promise<void> {
    const { mkdir, rename, writeFile } = await import('node:fs/promises')
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, path)
  }
}

function validateRuntimeCoverage(value: unknown): RuntimeCoverageInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime coverage must be an object')
  const record = value as Partial<RuntimeCoverageInput>
  if (record.schema_version !== RUNTIME_COVERAGE_SCHEMA_VERSION) throw new Error('unsupported runtime coverage schema')
  if (typeof record.tool !== 'string' || record.tool.trim().length === 0) throw new Error('runtime coverage tool is required')
  if (typeof record.measured_at !== 'string' || Number.isNaN(Date.parse(record.measured_at))) throw new Error('runtime coverage measured_at must be an ISO timestamp')
  if (!Array.isArray(record.branches) || record.branches.length > 100_000) throw new Error('runtime coverage branches must be a bounded array')
  const branches = record.branches.map((item, index) => {
    if (
      item === null
      || typeof item !== 'object'
      || typeof item.file !== 'string'
      || item.file.length === 0
      || !Number.isSafeInteger(item.line)
      || item.line < 1
      || typeof item.covered !== 'boolean'
    ) throw new Error(`invalid runtime coverage branch at index ${index}`)
    return { file: item.file, line: item.line, covered: item.covered }
  })
  return { schema_version: RUNTIME_COVERAGE_SCHEMA_VERSION, tool: record.tool, measured_at: record.measured_at, branches }
}

function measureBranches(java: JavaAnalysis, runtime: RuntimeCoverageInput | undefined): CoverageBranchState[] {
  const map = new Map((runtime?.branches ?? []).map(branch => [`${branch.file}:${branch.line}`, branch.covered]))
  return java.branches.map(branch => {
    const covered = branch.evidence.file !== undefined && branch.line !== undefined
      ? map.get(`${branch.evidence.file}:${branch.line}`)
      : undefined
    return {
      branch,
      runtime: covered === undefined ? 'not_measured' : covered ? 'covered' : 'uncovered',
    }
  })
}

function summarizeMeasurement(states: CoverageBranchState[], runtime: RuntimeCoverageInput | undefined): CoverageMeasurement {
  if (runtime === undefined) {
    return {
      measured: false,
      matched_branches: 0,
      covered_branches: 0,
      percentage: null,
      note: 'No runtime coverage report was supplied. Static branch evidence is not a coverage percentage.',
    }
  }
  const matched = states.filter(state => state.runtime !== 'not_measured')
  const covered = matched.filter(state => state.runtime === 'covered').length
  return {
    measured: true,
    tool: runtime.tool,
    measured_at: runtime.measured_at,
    matched_branches: matched.length,
    covered_branches: covered,
    percentage: matched.length === 0 ? null : (covered / matched.length) * 100,
    note: 'Percentage is scoped to static branches that matched the supplied runtime evidence, not whole-project coverage.',
  }
}

function requestMatches(httpMethod: string, endpointPath: string, requestMethod: string, requestPath: string): boolean {
  if (httpMethod !== 'ANY' && httpMethod !== requestMethod.toUpperCase()) return false
  const pattern = endpointPath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+\\\}/g, '[^/]+')
  return new RegExp(`^${pattern}/?$`).test(requestPath)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function shortId(): string {
  return randomBytes(3).toString('hex')
}
