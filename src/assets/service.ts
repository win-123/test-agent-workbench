import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseHar } from '../har/parser.ts'
import type { EngineKind } from '../engines/types.ts'
import type { ProjectService } from '../desktop/project-service.ts'
import type { TaskService } from '../desktop/task-service.ts'
import type { TaskSnapshot } from '../desktop/types.ts'
import { assertSafeTaskId, resolveInside } from '../desktop/security.ts'
import type { UiCaseService } from '../ui/service.ts'
import {
  ASSET_RUNS_SCHEMA_VERSION,
  ASSET_SCHEMA_VERSION,
  type AssetComparison,
  type AssetExecution,
  type AssetRunHistory,
  type AssetRunRecord,
  type AssetSourceFormat,
  type AssetSummary,
  type TestAsset,
} from './types.ts'

export interface AssetServiceOptions {
  projects: ProjectService
  tasks: TaskService
  uiCases: UiCaseService
}

export class AssetService {
  private readonly projects: ProjectService
  private readonly tasks: TaskService
  private readonly uiCases: UiCaseService

  constructor(options: AssetServiceOptions) {
    this.projects = options.projects
    this.tasks = options.tasks
    this.uiCases = options.uiCases
  }

  async list(): Promise<AssetSummary[]> {
    const root = this.requireRoot()
    const directory = resolveInside(root, join('.test-agent', 'assets'))
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const summaries: AssetSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const asset = await this.get(entry.name)
        const runs = await this.history(entry.name)
        summaries.push({
          asset_id: asset.asset_id,
          name: asset.name,
          kind: asset.kind,
          version: asset.version,
          source_format: asset.source_format,
          source_path: asset.source_path,
          environment: asset.environment.name,
          updated_at: asset.updated_at,
          run_count: runs.runs.length,
        })
      } catch {
        // Ignore a partially written asset until its next atomic update.
      }
    }
    return summaries.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async get(assetId: string, version?: number): Promise<TestAsset> {
    const root = this.requireRoot()
    assertSafeTaskId(assetId)
    const selectedVersion = version ?? (await this.readPointer(assetId)).version
    const path = resolveInside(root, this.versionPath(assetId, selectedVersion))
    return validateAsset(JSON.parse(await readFile(path, 'utf8')) as unknown)
  }

  async save(input: unknown, expectedVersion?: number): Promise<AssetSummary> {
    const root = this.requireRoot()
    const asset = validateAsset(input)
    assertSafeTaskId(asset.asset_id)
    const existing = await this.readPointer(asset.asset_id).catch(() => undefined)
    if (existing === undefined) {
      if (asset.version !== 1) throw new Error('a new test asset must start at version 1')
    } else {
      if (expectedVersion === undefined) throw new Error('expectedVersion is required when updating a test asset')
      if (existing.version !== expectedVersion) throw new Error(`test asset changed: expected version ${expectedVersion}, current version ${existing.version}`)
      if (asset.version !== existing.version + 1) throw new Error(`updated test asset must use version ${existing.version + 1}`)
    }
    const path = resolveInside(root, this.versionPath(asset.asset_id, asset.version))
    await mkdir(join(path, '..'), { recursive: true })
    await writeAtomic(path, `${JSON.stringify(asset, null, 2)}\n`)
    await writeAtomic(resolveInside(root, join('.test-agent', 'assets', asset.asset_id, 'current.json')), `${JSON.stringify(summaryOf(asset, 0), null, 2)}\n`)
    return summaryOf(asset, (await this.history(asset.asset_id)).runs.length)
  }

  async scanExisting(): Promise<AssetSummary[]> {
    const root = this.requireRoot()
    const current = await this.list()
    const byId = new Map(current.map(asset => [asset.asset_id, asset]))
    const config = this.projects.currentConfig()
    if (config.har_file !== undefined) {
      const assetId = 'api-imported-har'
      const har = await this.projects.readHar()
      await this.ensureAsset(assetId, byId, {
        schema_version: ASSET_SCHEMA_VERSION,
        asset_id: assetId,
        name: `${config.name} API replay`,
        description: 'Native HAR selection executed through the existing API replay engine.',
        kind: 'api',
        version: 1,
        source_format: 'har',
        source_path: config.har_file,
        execution: {
          mode: 'api-selection',
          har_path: config.har_file,
          request_orders: har.entries.map(entry => entry.order),
        },
        environment: { name: 'project-default', variable_refs: [] },
        credential_refs: [],
        test_data_refs: [],
        tags: ['imported', 'har'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    }

    for (const uiCase of await this.uiCases.list()) {
      const assetId = `ui-${uiCase.case_id}`.slice(0, 100)
      const existing = byId.get(assetId)
      if (existing !== undefined && existing.version === uiCase.version) continue
      const nextVersion = existing === undefined ? 1 : existing.version + 1
      await this.save({
        schema_version: ASSET_SCHEMA_VERSION,
        asset_id: assetId,
        name: uiCase.name,
        description: 'Native versioned UI case executed with Playwright.',
        kind: 'ui',
        version: nextVersion,
        source_format: 'ui-case-json',
        source_path: uiCase.path,
        execution: {
          mode: 'ui-case',
          case_id: uiCase.case_id,
          case_version: uiCase.version,
        },
        environment: { name: 'project-default', variable_refs: [] },
        credential_refs: [],
        test_data_refs: [],
        tags: ['ui', 'playwright'],
        created_at: existing === undefined ? new Date().toISOString() : new Date().toISOString(),
        updated_at: uiCase.updated_at,
      }, existing?.version)
    }

    const scriptDirectory = resolveInside(root, 'scripts')
    const scripts = await readdir(scriptDirectory).catch(() => [])
    for (const script of scripts) {
      const engine: EngineKind | undefined = script.endsWith('.js') ? 'k6' : script.endsWith('.jmx') ? 'jmeter' : undefined
      if (engine === undefined) continue
      const assetId = `performance-${createHash('sha256').update(script).digest('hex').slice(0, 10)}`
      if (byId.has(assetId)) continue
      const relativePath = join('scripts', script)
      await this.ensureAsset(assetId, byId, {
        schema_version: ASSET_SCHEMA_VERSION,
        asset_id: assetId,
        name: `${engine.toUpperCase()} · ${script}`,
        description: 'Generated native load-test script. Existing engine format is preserved.',
        kind: 'performance',
        version: 1,
        source_format: engine === 'k6' ? 'k6-js' : 'jmeter-jmx',
        source_path: relativePath,
        execution: { mode: 'performance-script', engine, script_path: relativePath },
        environment: { name: 'project-default', variable_refs: [] },
        credential_refs: [],
        test_data_refs: [],
        tags: ['performance', engine],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    }
    return await this.list()
  }

  async execute(assetId: string): Promise<{ task_id: string; run_id?: string }> {
    const { asset, task } = await this.start(assetId)
    void this.recordWhenComplete(asset, task.task_id)
    return { task_id: task.task_id, run_id: task.run_id }
  }

  async executeAndWait(assetId: string): Promise<TaskSnapshot> {
    const { asset, task } = await this.start(assetId)
    const snapshot = await this.tasks.waitForTask(task.task_id)
    await this.appendRun(asset, snapshot)
    return snapshot
  }

  async history(assetId: string): Promise<AssetRunHistory> {
    const root = this.requireRoot()
    assertSafeTaskId(assetId)
    const path = resolveInside(root, join('.test-agent', 'assets', assetId, 'runs.json'))
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as AssetRunHistory).schema_version === ASSET_RUNS_SCHEMA_VERSION
        && (value as AssetRunHistory).asset_id === assetId
        && Array.isArray((value as AssetRunHistory).runs)
      ) return value as AssetRunHistory
      throw new Error('invalid asset run history')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schema_version: ASSET_RUNS_SCHEMA_VERSION, asset_id: assetId, runs: [] }
      }
      throw new Error(`cannot read asset history: ${(error as Error).message}`)
    }
  }

  async compare(assetId: string, leftRunId?: string, rightRunId?: string): Promise<AssetComparison> {
    const history = await this.history(assetId)
    if (history.runs.length < 2) throw new Error('at least two real runs are required for comparison')
    const left = leftRunId === undefined
      ? history.runs[history.runs.length - 2]
      : history.runs.find(run => run.run_id === leftRunId)
    const right = rightRunId === undefined
      ? history.runs[history.runs.length - 1]
      : history.runs.find(run => run.run_id === rightRunId)
    if (left === undefined || right === undefined) throw new Error('comparison run id was not found')
    if (left.run_id === right.run_id) throw new Error('comparison requires two different runs')
    const names = [...new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)])].sort()
    const metrics = names.map(name => {
      const leftValue = left.metrics[name] ?? null
      const rightValue = right.metrics[name] ?? null
      const delta = leftValue === null || rightValue === null ? null : rightValue - leftValue
      const deltaPercent = delta === null || leftValue === null || leftValue === 0 ? null : (delta / leftValue) * 100
      return { name, left: leftValue, right: rightValue, delta, delta_percent: deltaPercent }
    })
    const facts = [
      `Compared real run ${left.run_id} (${left.status}) with ${right.run_id} (${right.status}).`,
      ...metrics.filter(item => item.delta !== null).map(item => `${item.name}: ${item.left} -> ${item.right} (delta ${item.delta}).`),
    ]
    const caveats = metrics.some(item => item.delta === null)
      ? ['Some metrics were absent from one run and are reported as unavailable, not as zero.']
      : []
    return { asset_id: assetId, left, right, metrics, facts, caveats }
  }

  private async recordWhenComplete(asset: TestAsset, taskId: string): Promise<void> {
    try {
      const snapshot = await this.tasks.waitForTask(taskId)
      await this.appendRun(asset, snapshot)
    } catch {
      // The original task record remains the source of truth if asset indexing fails.
    }
  }

  private async start(assetId: string): Promise<{ asset: TestAsset; task: Awaited<ReturnType<TaskService['startApiSelection']>> }> {
    const root = this.requireRoot()
    const asset = await this.get(assetId)
    validateSourceInside(root, asset)
    let task
    if (asset.execution.mode === 'api-selection') {
      const har = parseHar(await readFile(resolveInside(root, asset.execution.har_path), 'utf8'))
      const selected = new Set(asset.execution.request_orders)
      const entries = har.entries.filter(entry => selected.has(entry.order))
      if (entries.length !== selected.size) throw new Error('API asset references request orders that are no longer present in the HAR')
      task = await this.tasks.startApiSelection({ entries }, `Asset · ${asset.name}`)
    } else if (asset.execution.mode === 'ui-case') {
      task = await this.uiCases.execute(asset.execution.case_id, asset.execution.case_version)
    } else {
      task = await this.tasks.startPerformanceScript(`Asset · ${asset.name}`, asset.execution.engine, asset.execution.script_path)
    }
    return { asset, task }
  }

  private async appendRun(asset: TestAsset, snapshot: TaskSnapshot): Promise<void> {
    if (snapshot.task.run_id === undefined) return
    const history = await this.history(asset.asset_id)
    if (history.runs.some(run => run.run_id === snapshot.task.run_id)) return
    const run: AssetRunRecord = {
      run_id: snapshot.task.run_id,
      task_id: snapshot.task.task_id,
      asset_id: asset.asset_id,
      asset_version: asset.version,
      status: snapshot.task.status,
      started_at: snapshot.task.started_at,
      finished_at: snapshot.task.finished_at,
      report_path: snapshot.task.report_path,
      log_paths: [snapshot.task.log_path, snapshot.task.stdout_path, snapshot.task.stderr_path]
        .filter((value): value is string => value !== undefined),
      metrics: extractMetrics(snapshot),
      recorded_at: new Date().toISOString(),
    }
    history.runs.push(run)
    const path = resolveInside(this.requireRoot(), join('.test-agent', 'assets', asset.asset_id, 'runs.json'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeAtomic(path, `${JSON.stringify(history, null, 2)}\n`)
  }

  private async ensureAsset(assetId: string, known: Map<string, AssetSummary>, candidate: TestAsset): Promise<void> {
    const existing = known.get(assetId)
    if (existing === undefined) {
      const saved = await this.save(candidate)
      known.set(assetId, saved)
      return
    }
    const current = await this.get(assetId)
    if (assetFingerprint(current) === assetFingerprint(candidate)) return
    const saved = await this.save({
      ...candidate,
      version: current.version + 1,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    }, current.version)
    known.set(assetId, saved)
  }

  private async readPointer(assetId: string): Promise<AssetSummary> {
    assertSafeTaskId(assetId)
    const path = resolveInside(this.requireRoot(), join('.test-agent', 'assets', assetId, 'current.json'))
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isAssetSummary(value) || value.asset_id !== assetId) throw new Error('invalid test asset pointer')
    return value
  }

  private versionPath(assetId: string, version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('asset version must be a positive integer')
    return join('.test-agent', 'assets', assertSafeTaskId(assetId), 'versions', `v${version}.json`)
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}

function validateAsset(value: unknown): TestAsset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('test asset must be an object')
  const record = value as Partial<TestAsset>
  if (record.schema_version !== ASSET_SCHEMA_VERSION) throw new Error(`unsupported asset schema: ${String(record.schema_version)}`)
  const assetId = requiredId(record.asset_id, 'asset_id')
  const name = requiredText(record.name, 'name', 200)
  if (!['api', 'ui', 'performance'].includes(String(record.kind))) throw new Error('asset kind must be api, ui, or performance')
  const kind = record.kind as TestAsset['kind']
  if (!Number.isSafeInteger(record.version) || Number(record.version) < 1) throw new Error('asset version must be a positive integer')
  if (!['har', 'ui-case-json', 'k6-js', 'jmeter-jmx'].includes(String(record.source_format))) throw new Error('invalid asset source_format')
  const sourceFormat = record.source_format as AssetSourceFormat
  const sourcePath = relativePath(record.source_path, 'source_path')
  const execution = validateExecution(record.execution)
  if (!consistentKind(kind, sourceFormat, execution)) throw new Error('asset kind, source format, and execution mode do not match')
  if (record.environment === null || typeof record.environment !== 'object') throw new Error('asset environment is required')
  const environmentName = requiredText(record.environment.name, 'environment.name', 100)
  const variableRefs = stringArray(record.environment.variable_refs, 'environment.variable_refs', 100)
  for (const ref of variableRefs) if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(ref)) throw new Error(`invalid environment variable reference: ${ref}`)
  const credentialRefs = stringArray(record.credential_refs, 'credential_refs', 100)
  for (const ref of credentialRefs) {
    if (!/^(env|keychain|vault):\/\/[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`credential_refs must be opaque references, not secret values: ${ref}`)
  }
  const testDataRefs = stringArray(record.test_data_refs, 'test_data_refs', 100).map(path => relativePath(path, 'test_data_refs'))
  const tags = stringArray(record.tags, 'tags', 20)
  const createdAt = timestamp(record.created_at, 'created_at')
  const updatedAt = timestamp(record.updated_at, 'updated_at')
  return {
    schema_version: ASSET_SCHEMA_VERSION,
    asset_id: assetId,
    name,
    ...record.description === undefined ? {} : { description: requiredText(record.description, 'description', 2000) },
    kind,
    version: Number(record.version),
    source_format: sourceFormat,
    source_path: sourcePath,
    execution,
    environment: { name: environmentName, variable_refs: [...new Set(variableRefs)] },
    credential_refs: [...new Set(credentialRefs)],
    test_data_refs: [...new Set(testDataRefs)],
    tags: [...new Set(tags)],
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function validateExecution(value: unknown): AssetExecution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('asset execution is required')
  const record = value as Record<string, unknown>
  if (record['mode'] === 'api-selection') {
    const orders = Array.isArray(record['request_orders']) ? record['request_orders'] : []
    if (!orders.every(order => Number.isSafeInteger(order) && Number(order) >= 0) || new Set(orders).size !== orders.length) {
      throw new Error('request_orders must contain unique non-negative integers')
    }
    return {
      mode: 'api-selection',
      har_path: relativePath(record['har_path'], 'execution.har_path'),
      request_orders: orders.map(Number),
    }
  }
  if (record['mode'] === 'ui-case') {
    return {
      mode: 'ui-case',
      case_id: requiredId(record['case_id'], 'execution.case_id'),
      case_version: positiveInteger(record['case_version'], 'execution.case_version'),
    }
  }
  if (record['mode'] === 'performance-script') {
    if (record['engine'] !== 'k6' && record['engine'] !== 'jmeter') throw new Error('performance asset engine must be k6 or jmeter')
    return {
      mode: 'performance-script',
      engine: record['engine'],
      script_path: relativePath(record['script_path'], 'execution.script_path'),
    }
  }
  throw new Error('invalid asset execution mode')
}

function consistentKind(kind: TestAsset['kind'], format: AssetSourceFormat, execution: AssetExecution): boolean {
  if (kind === 'api') return format === 'har' && execution.mode === 'api-selection'
  if (kind === 'ui') return format === 'ui-case-json' && execution.mode === 'ui-case'
  return (format === 'k6-js' || format === 'jmeter-jmx')
    && execution.mode === 'performance-script'
    && (format === 'k6-js' ? execution.engine === 'k6' : execution.engine === 'jmeter')
}

function validateSourceInside(root: string, asset: TestAsset): void {
  resolveInside(root, asset.source_path)
  if (asset.execution.mode === 'api-selection') resolveInside(root, asset.execution.har_path)
  if (asset.execution.mode === 'performance-script') resolveInside(root, asset.execution.script_path)
}

function assetFingerprint(asset: TestAsset): string {
  return JSON.stringify({
    kind: asset.kind,
    name: asset.name,
    source_format: asset.source_format,
    source_path: asset.source_path,
    execution: asset.execution,
    environment: asset.environment,
    credential_refs: asset.credential_refs,
    test_data_refs: asset.test_data_refs,
    tags: asset.tags,
  })
}

function summaryOf(asset: TestAsset, runCount: number): AssetSummary {
  return {
    asset_id: asset.asset_id,
    name: asset.name,
    kind: asset.kind,
    version: asset.version,
    source_format: asset.source_format,
    source_path: asset.source_path,
    environment: asset.environment.name,
    updated_at: asset.updated_at,
    run_count: runCount,
  }
}

function extractMetrics(snapshot: TaskSnapshot): Record<string, number | null> {
  const report = snapshot.report
  if (report === undefined) return {}
  if ('metrics' in report) {
    return {
      total: report.metrics.total,
      passed: report.metrics.passed,
      failed: report.metrics.failed,
      error_rate: report.metrics.error_rate,
      throughput_per_second: report.metrics.throughput_per_second,
      p90_response_ms: report.metrics.p90_response_ms,
      p95_response_ms: report.metrics.p95_response_ms,
      p99_response_ms: report.metrics.p99_response_ms,
    }
  }
  if ('steps_total' in report) {
    return {
      total: report.steps_total,
      passed: report.steps_passed,
      failed: report.steps_failed,
      duration_ms: report.duration_ms,
    }
  }
  return {
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    duration_ms: report.requests.reduce((sum, request) => sum + request.duration_ms, 0),
  }
}

function isAssetSummary(value: unknown): value is AssetSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['asset_id'] === 'string'
    && typeof record['name'] === 'string'
    && Number.isSafeInteger(record['version'])
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${name} must be a bounded non-empty string`)
  return value.trim()
}

function relativePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) throw new Error(`${name} must be a relative path`)
  if (value.startsWith('/') || value.includes('..') || /^[a-zA-Z]:[\\/]/.test(value)) throw new Error(`${name} must stay inside the project`)
  return value
}

function stringArray(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 500)) {
    throw new Error(`${name} must be a bounded string array`)
  }
  return value
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
  return value
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}
