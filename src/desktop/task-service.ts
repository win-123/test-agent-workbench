import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replayHar } from '../api/replay.ts'
import { createReport, type TestAgentReport } from '../results/result.ts'
import { generateK6Script } from '../generators/k6.ts'
import { generateJmx } from '../generators/jmeter.ts'
import { runEngine } from '../engines/executor.ts'
import { createEngineReport, type EnginePerformanceReport } from '../engines/report.ts'
import type { EngineKind } from '../engines/types.ts'
import {
  DESKTOP_LIMITS,
  DESKTOP_TASK_SCHEMA_VERSION,
  type DesktopTaskRecord,
  type EngineStatus,
  type LogChunk,
  type ScriptGenerationResult,
  type StartReplayInput,
  type TaskSnapshot,
} from './types.ts'
import type { ProjectService } from './project-service.ts'
import type { ProjectConfig } from './types.ts'
import { inspectEngine } from './engine-discovery.ts'
import { runUiTestCase } from '../ui/runner.ts'
import type { CredentialService } from './credential-service.ts'
import type { UiTestCase } from '../ui/types.ts'
import type { ParsedHar } from '../har/types.ts'
import {
  assertSafeEngine,
  assertSafeTaskId,
  redactSensitiveText,
  resolveInside,
} from './security.ts'

export class ProjectRunGate {
  private readonly active = new Set<string>()

  acquire(projectId: string): () => void {
    if (this.active.has(projectId)) throw new Error('this project already has a running task; stop it before starting another')
    this.active.add(projectId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(projectId)
    }
  }

  isActive(projectId: string): boolean {
    return this.active.has(projectId)
  }
}

interface ActiveTask {
  controller: AbortController
  root: string
  promise: Promise<void>
}

export interface TaskServiceOptions {
  projects: ProjectService
  gate: ProjectRunGate
  credentials?: CredentialService
}

export class TaskService {
  readonly projects: ProjectService
  readonly gate: ProjectRunGate
  private readonly credentials?: CredentialService
  private readonly active = new Map<string, ActiveTask>()

  constructor(options: TaskServiceOptions) {
    this.projects = options.projects
    this.gate = options.gate
    this.credentials = options.credentials
  }

  async checkEngines(): Promise<EngineStatus[]> {
    const config = this.projects.currentConfig()
    return await Promise.all((['k6', 'jmeter'] as const).map(async engine => {
      const configured = config.performance.enginePaths[engine]
      return await inspectEngine(engine, configured)
    }))
  }

  async checkEngine(engine: EngineKind): Promise<EngineStatus> {
    const config = this.projects.currentConfig()
    return await inspectEngine(assertSafeEngine(engine), config.performance.enginePaths[engine])
  }

  async generateScript(requestedEngine: EngineKind): Promise<ScriptGenerationResult> {
    const engine = assertSafeEngine(requestedEngine)
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    const har = await this.projects.readHar()
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    const content = engine === 'k6'
      ? generateK6Script(har, {
          baseUrl: config.target.baseUrl,
          allowedOrigins: config.target.allowedOrigins,
          vus: config.performance.vus,
          iterations: config.performance.iterations,
          duration: optional(config.performance.duration),
          assertions: config.api.assertions,
          correlations: config.correlations,
        })
      : generateJmx(har, {
          baseUrl: config.target.baseUrl,
          allowedOrigins: config.target.allowedOrigins,
          threads: config.performance.vus,
          loops: config.performance.iterations,
          durationSeconds: durationSeconds(config.performance.duration),
          correlations: config.correlations,
        })
    const extension = engine === 'k6' ? 'js' : 'jmx'
    const path = resolveInside(root, join('scripts', `${timestamp()}-${randomBytes(2).toString('hex')}.${extension}`))
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(path, content, { mode: 0o600 })
    return { engine, path, content }
  }

  async startReplay(input?: StartReplayInput): Promise<DesktopTaskRecord> {
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    const har = await this.projects.readHar()
    const requestOrders = validateReplayRequestOrders(har, input?.requestOrders)
    const count = requestOrders?.length ?? har.entries.length
    const title = requestOrders === undefined
      ? `API replay · ${count} requests`
      : `API replay · ${count}/${har.entries.length} selected requests`
    return await this.startApiHar(root, config, har, title, requestOrders)
  }

  async startApiSelection(har: ParsedHar, title: string): Promise<DesktopTaskRecord> {
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    if (har.entries.length === 0) throw new Error('API test selection contains no requests')
    return await this.startApiHar(root, config, har, title)
  }

  private async startApiHar(
    root: string,
    config: ProjectConfig,
    har: ParsedHar,
    title: string,
    requestOrders?: number[],
  ): Promise<DesktopTaskRecord> {
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    if (har.entries.length > DESKTOP_LIMITS.maxRequests) throw new Error(`replay is limited to ${DESKTOP_LIMITS.maxRequests} requests`)
    const release = this.gate.acquire(config.project_id)
    const record = this.newRecord(root, config.project_id, 'api-replay', title)
    await this.saveRecord(root, record)
    const controller = new AbortController()
    const promise = this.executeReplay(root, record, config, har, requestOrders, controller.signal)
      .catch(async error => {
        await this.failRecord(root, record, error).catch(() => undefined)
      })
      .finally(() => {
        release()
        this.active.delete(record.task_id)
      })
    this.active.set(record.task_id, { controller, root, promise })
    return record
  }

  async startPerformance(engine: EngineKind): Promise<DesktopTaskRecord> {
    const safeEngine = assertSafeEngine(engine)
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    const har = await this.projects.readHar()
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    const release = this.gate.acquire(config.project_id)
    const record = this.newRecord(root, config.project_id, 'performance', `${safeEngine.toUpperCase()} load test`, safeEngine)
    await this.saveRecord(root, record)
    const controller = new AbortController()
    const promise = this.executePerformance(root, record, config, har, safeEngine, controller.signal)
      .catch(async error => {
        await this.failRecord(root, record, error)
      })
      .finally(() => {
        release()
        this.active.delete(record.task_id)
      })
    this.active.set(record.task_id, { controller, root, promise })
    return record
  }

  async startUiTest(testCase: UiTestCase): Promise<DesktopTaskRecord> {
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    for (const origin of testCase.allowed_origins) {
      if (!config.target.allowedOrigins.includes(origin)) {
        throw new Error(`UI test origin is outside the project authorization: ${origin}`)
      }
    }
    const release = this.gate.acquire(config.project_id)
    const record = this.newRecord(root, config.project_id, 'ui-test', `UI · ${testCase.name}`)
    const runId = `ui_${timestamp()}_${randomBytes(3).toString('hex')}`
    record.run_id = runId
    await this.saveRecord(root, record)
    const controller = new AbortController()
    const promise = this.executeUiTest(root, record, testCase, runId, controller.signal)
      .catch(async error => {
        await this.failRecord(root, record, error)
      })
      .finally(() => {
        release()
        this.active.delete(record.task_id)
      })
    this.active.set(record.task_id, { controller, root, promise })
    return record
  }

  async startPerformanceScript(name: string, engine: EngineKind, scriptPath: string): Promise<DesktopTaskRecord> {
    const safeEngine = assertSafeEngine(engine)
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    const resolvedScript = resolveInside(root, scriptPath)
    const info = await stat(resolvedScript)
    if (!info.isFile()) throw new Error(`performance script is not a file: ${scriptPath}`)
    const extension = safeEngine === 'k6' ? '.js' : '.jmx'
    if (!resolvedScript.endsWith(extension)) throw new Error(`${safeEngine} asset must reference a ${extension} script`)
    const release = this.gate.acquire(config.project_id)
    const record = this.newRecord(root, config.project_id, 'performance', name, safeEngine)
    record.script_path = relativeInside(root, resolvedScript)
    const runId = `engine_${timestamp()}_${randomBytes(3).toString('hex')}`
    record.run_id = runId
    await this.saveRecord(root, record)
    const controller = new AbortController()
    const promise = this.executePerformanceScript(root, record, config, safeEngine, resolvedScript, runId, controller.signal)
      .catch(async error => {
        await this.failRecord(root, record, error)
      })
      .finally(() => {
        release()
        this.active.delete(record.task_id)
      })
    this.active.set(record.task_id, { controller, root, promise })
    return record
  }

  async listTasks(root = this.requireRoot()): Promise<DesktopTaskRecord[]> {
    await this.recoverInterrupted(root)
    const directory = resolveInside(root, join('.test-agent', 'desktop-tasks'))
    const entries = await readdir(directory).catch(() => [])
    const records: DesktopTaskRecord[] = []
    for (const entry of entries) {
      if (!entry.startsWith('task_')) continue
      try {
        records.push(await this.loadRecord(root, entry))
      } catch {
        // Corrupt records are omitted rather than blocking history.
      }
    }
    return records.sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const root = this.requireRoot()
    assertSafeTaskId(taskId)
    await this.recoverInterrupted(root)
    const task = await this.loadRecord(root, taskId)
    let report: TestAgentReport | EnginePerformanceReport | undefined
    if (task.report_path !== undefined) {
      try {
        report = JSON.parse(await readFile(resolveInside(root, task.report_path), 'utf8')) as TestAgentReport | EnginePerformanceReport
      } catch {
        // The task record remains useful when an evidence file was removed.
      }
    }
    return { task, report }
  }

  async cancelTask(taskId: string): Promise<TaskSnapshot> {
    const root = this.requireRoot()
    assertSafeTaskId(taskId)
    const active = this.active.get(taskId)
    if (active === undefined) {
      const record = await this.loadRecord(root, taskId)
      if (record.status === 'queued' || record.status === 'running') {
        record.status = 'interrupted'
        record.error = 'task had no active process and was marked interrupted'
        record.finished_at = new Date().toISOString()
        await this.saveRecord(root, record)
      }
      return { task: record }
    }
    active.controller.abort(new Error('cancelled by user'))
    await active.promise
    return await this.getTask(taskId)
  }

  async taskLogs(taskId: string): Promise<LogChunk[]> {
    const root = this.requireRoot()
    const record = await this.loadRecord(root, assertSafeTaskId(taskId))
    const candidates = [record.log_path, record.stdout_path, record.stderr_path].filter((value): value is string => value !== undefined)
    const chunks: LogChunk[] = []
    for (const relativePath of candidates) {
      const path = resolveInside(root, relativePath)
      const content = await readTail(path, DESKTOP_LIMITS.maxLogBytes)
      if (content !== undefined) chunks.push({ path, content: redactSensitiveText(content), truncated: content.length >= DESKTOP_LIMITS.maxLogBytes })
    }
    return chunks
  }

  async waitForTask(taskId: string): Promise<TaskSnapshot> {
    assertSafeTaskId(taskId)
    const active = this.active.get(taskId)
    if (active !== undefined) await active.promise
    return await this.getTask(taskId)
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    const pending = [...this.active.values()]
    for (const task of pending) task.controller.abort(new Error('application is shutting down'))
    await Promise.race([
      Promise.allSettled(pending.map(task => task.promise)),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
  }

  private async executeReplay(
    root: string,
    record: DesktopTaskRecord,
    config: ProjectConfig,
    har: Awaited<ReturnType<ProjectService['readHar']>>,
    requestOrders: number[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    record.status = 'running'
    record.started_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `Starting API replay for ${har.entries.length} request(s) against ${config.target.baseUrl}`)
    const credentialHeaders = await this.credentials?.resolveHeaders(config.credentialRef)
    const replay = await replayHar(har, {
      baseUrl: config.target.baseUrl,
      allowedOrigins: config.target.allowedOrigins,
      allowedPaths: config.target.allowedPaths.length === 0 ? undefined : config.target.allowedPaths,
      timeoutMs: config.api.timeoutMs,
      concurrency: config.api.concurrency,
      headers: { ...config.environment.headers, ...credentialHeaders },
      assertions: config.api.assertions,
      correlations: config.correlations,
      ...requestOrders === undefined ? {} : { requestOrders },
    }, signal)
    const report = createReport(replay, {}, {
      base_url: config.target.baseUrl,
      timeout_ms: config.api.timeoutMs,
      concurrency: config.api.concurrency,
      assertion_count: config.api.assertions.length,
    }, replay.startedAt, replay.finishedAt)
    const reportPath = resolveInside(root, join('output', `${report.run_id}.json`))
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    record.run_id = report.run_id
    record.report_path = relativeInside(root, reportPath)
    record.result_summary = { total: report.total, passed: report.passed, failed: report.failed }
    const cancelled = signal.aborted || replay.results.some(result => result.errorKind === 'cancelled')
    const timedOut = replay.results.some(result => result.errorKind === 'timeout')
    record.status = cancelled ? 'cancelled' : timedOut ? 'timeout' : report.failed === 0 ? 'passed' : 'test_failed'
    record.finished_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `Replay finished: ${report.passed}/${report.total} passed; report ${report.run_id}`)
  }

  private async executePerformance(
    root: string,
    record: DesktopTaskRecord,
    config: ProjectConfig,
    har: Awaited<ReturnType<ProjectService['readHar']>>,
    engine: EngineKind,
    signal: AbortSignal,
  ): Promise<void> {
    const runId = `engine_${timestamp()}_${randomBytes(3).toString('hex')}`
    const extension = engine === 'k6' ? 'js' : 'jmx'
    const scriptPath = resolveInside(root, join('scripts', `${runId}.${extension}`))
    const taskDirectory = resolveInside(root, join('.test-agent', 'desktop-tasks', record.task_id))
    const contract = engine === 'k6'
      ? generateK6Script(har, {
          baseUrl: config.target.baseUrl,
          allowedOrigins: config.target.allowedOrigins,
          vus: config.performance.vus,
          iterations: config.performance.iterations,
          duration: optional(config.performance.duration),
          assertions: config.api.assertions,
          correlations: config.correlations,
        })
      : generateJmx(har, {
          baseUrl: config.target.baseUrl,
          allowedOrigins: config.target.allowedOrigins,
          threads: config.performance.vus,
          loops: config.performance.iterations,
          durationSeconds: durationSeconds(config.performance.duration),
          correlations: config.correlations,
        })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(scriptPath, contract, { mode: 0o600 })
    record.status = 'running'
    record.run_id = runId
    record.engine = engine
    record.script_path = relativeInside(root, scriptPath)
    record.started_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `Starting ${engine} run ${runId} with ${config.performance.vus} VU(s)`)

    const execution = await runEngine({
      kind: engine,
      scriptPath,
      timeoutMs: config.performance.timeoutMs,
      outputDirectory: taskDirectory,
      runId,
      executable: config.performance.enginePaths[engine],
      signal,
    })
    record.stdout_path = relativeInside(root, execution.stdoutPath)
    record.stderr_path = relativeInside(root, execution.stderrPath)
    const report = await createEngineReport(execution, {
      concurrency: config.performance.vus,
      duration: optional(config.performance.duration),
      iterations: config.performance.iterations,
    })
    const reportPath = resolveInside(root, join('output', `${runId}.report.json`))
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    record.report_path = relativeInside(root, reportPath)
    record.result_summary = {
      status: report.evidence.status,
      total: report.metrics.total,
      passed: report.metrics.passed,
      failed: report.metrics.failed,
    }
    if (report.evidence.status === 'cancelled') record.status = 'cancelled'
    else if (report.evidence.status === 'timeout') record.status = 'timeout'
    else if (report.evidence.status === 'passed' && report.metrics.failed === 0) record.status = 'passed'
    else if (report.evidence.status === 'passed') record.status = 'test_failed'
    else record.status = 'failed'
    record.error = report.evidence.error
    record.finished_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `${engine} finished with status ${report.evidence.status}; report ${runId}`)
  }

  private async executePerformanceScript(
    root: string,
    record: DesktopTaskRecord,
    config: ProjectConfig,
    engine: EngineKind,
    scriptPath: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const taskDirectory = resolveInside(root, join('.test-agent', 'desktop-tasks', record.task_id))
    await mkdir(taskDirectory, { recursive: true })
    record.status = 'running'
    record.started_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `Starting saved ${engine} asset run ${runId}`)
    const execution = await runEngine({
      kind: engine,
      scriptPath,
      timeoutMs: config.performance.timeoutMs,
      outputDirectory: taskDirectory,
      runId,
      executable: config.performance.enginePaths[engine],
      signal,
    })
    record.stdout_path = relativeInside(root, execution.stdoutPath)
    record.stderr_path = relativeInside(root, execution.stderrPath)
    const report = await createEngineReport(execution, {
      concurrency: config.performance.vus,
      duration: optional(config.performance.duration),
      iterations: config.performance.iterations,
    })
    const reportPath = resolveInside(root, join('output', `${runId}.report.json`))
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    record.report_path = relativeInside(root, reportPath)
    record.result_summary = {
      status: report.evidence.status,
      total: report.metrics.total,
      passed: report.metrics.passed,
      failed: report.metrics.failed,
    }
    record.status = report.evidence.status === 'cancelled'
      ? 'cancelled'
      : report.evidence.status === 'timeout'
        ? 'timeout'
        : report.evidence.status === 'passed' && report.metrics.failed === 0
          ? 'passed'
          : report.evidence.status === 'passed'
            ? 'test_failed'
            : 'failed'
    record.error = report.evidence.error
    record.finished_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `${engine} asset finished with status ${report.evidence.status}; report ${runId}`)
  }

  private async executeUiTest(
    root: string,
    record: DesktopTaskRecord,
    testCase: UiTestCase,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    record.status = 'running'
    record.started_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `Starting UI case ${testCase.case_id} v${testCase.version} with ${testCase.steps.length} step(s)`)
    const report = await runUiTestCase(testCase, {
      outputDirectory: root,
      runId,
      signal,
      chromeExecutable: process.env.TEST_AGENT_CHROME_EXECUTABLE,
    })
    const reportPath = resolveInside(root, join('output', `${runId}.report.json`))
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    record.report_path = relativeInside(root, reportPath)
    record.result_summary = {
      status: report.status,
      total: report.steps_total,
      passed: report.steps_passed,
      failed: report.steps_failed,
      screenshots: report.screenshots.length,
    }
    record.status = report.status === 'passed'
      ? 'passed'
      : report.status === 'failed'
        ? 'test_failed'
        : report.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
    record.error = report.error
    record.finished_at = new Date().toISOString()
    await this.saveRecord(root, record)
    await this.log(root, record, `UI case finished with status ${report.status}; report ${runId}`)
  }

  private newRecord(root: string, projectId: string, kind: DesktopTaskRecord['kind'], title: string, engine?: EngineKind): DesktopTaskRecord {
    const taskId = `task_${timestamp()}_${randomBytes(3).toString('hex')}`
    const directory = resolveInside(root, join('.test-agent', 'desktop-tasks', taskId))
    return {
      schema_version: DESKTOP_TASK_SCHEMA_VERSION,
      task_id: taskId,
      project_id: projectId,
      kind,
      title,
      status: 'queued',
      created_at: new Date().toISOString(),
      engine,
      log_path: relativeInside(root, join(directory, 'task.log')),
    }
  }

  private async loadRecord(root: string, taskId: string): Promise<DesktopTaskRecord> {
    const path = resolveInside(root, join('.test-agent', 'desktop-tasks', assertSafeTaskId(taskId), 'state.json'))
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`task not found: ${taskId}`)
      throw new Error(`cannot read task state: ${(error as Error).message}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('task state must be an object')
    const record = parsed as DesktopTaskRecord
    if (record.schema_version !== DESKTOP_TASK_SCHEMA_VERSION) throw new Error('unsupported desktop task schema')
    if (record.task_id !== taskId) throw new Error('task id mismatch')
    return record
  }

  private async saveRecord(root: string, record: DesktopTaskRecord): Promise<void> {
    const path = resolveInside(root, join('.test-agent', 'desktop-tasks', assertSafeTaskId(record.task_id), 'state.json'))
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private async failRecord(root: string, record: DesktopTaskRecord, error: unknown): Promise<void> {
    const message = redactSensitiveText((error as Error).message)
    record.error = message
    record.finished_at = new Date().toISOString()
    if (record.status !== 'cancelled') record.status = 'failed'
    await this.saveRecord(root, record)
    await this.log(root, record, `Task failed: ${message}`).catch(() => undefined)
  }

  private async log(root: string, record: DesktopTaskRecord, message: string): Promise<void> {
    const path = resolveInside(root, record.log_path)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `[${new Date().toISOString()}] ${redactSensitiveText(message)}\n`, { mode: 0o600 })
  }

  private async recoverInterrupted(root: string): Promise<void> {
    const records = await this.listRecordsRaw(root)
    const now = new Date().toISOString()
    for (const record of records) {
      if ((record.status === 'queued' || record.status === 'running') && !this.active.has(record.task_id)) {
        record.status = 'interrupted'
        record.error = record.error ?? 'application ended or process disappeared before task completion'
        record.finished_at = now
        await this.saveRecord(root, record)
      }
    }
  }

  private async listRecordsRaw(root: string): Promise<DesktopTaskRecord[]> {
    const directory = resolveInside(root, join('.test-agent', 'desktop-tasks'))
    const entries = await readdir(directory).catch(() => [])
    const records: DesktopTaskRecord[] = []
    for (const entry of entries) {
      if (!entry.startsWith('task_')) continue
      try {
        records.push(await this.loadRecord(root, entry))
      } catch {
        // A partially written record is ignored until the next successful write.
      }
    }
    return records
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}

async function readTail(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const raw = await readFile(path)
    return raw.subarray(Math.max(0, raw.length - maxBytes)).toString('utf8')
  } catch {
    return undefined
  }
}

function requireAuthorizedTarget(baseUrl: string, confirmed: boolean): void {
  if (baseUrl.trim().length === 0) throw new Error('configure the target base URL before running a test')
  if (!confirmed) throw new Error('confirm the authorized test scope before running a test')
}

function validateReplayRequestOrders(har: ParsedHar, requestOrders: number[] | undefined): number[] | undefined {
  if (requestOrders === undefined) return undefined
  if (!Array.isArray(requestOrders) || requestOrders.length === 0) {
    throw new Error('select at least one request for replay')
  }
  if (requestOrders.length > DESKTOP_LIMITS.maxRequests) {
    throw new Error(`replay is limited to ${DESKTOP_LIMITS.maxRequests} requests`)
  }
  const available = new Set(har.entries.map(entry => entry.order))
  const unique = new Set<number>()
  for (const order of requestOrders) {
    if (!Number.isSafeInteger(order) || !available.has(order)) {
      throw new Error(`replay request order is invalid: ${String(order)}`)
    }
    if (unique.has(order)) throw new Error(`replay request order is duplicated: ${order}`)
    unique.add(order)
  }
  return [...unique].sort((left, right) => left - right)
}

function durationSeconds(value: string): number | undefined {
  if (value.length === 0) return undefined
  const match = value.match(/^(\d+)(s|m)$/)
  if (match === null) throw new Error('duration must look like 30s or 2m')
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}

function relativeInside(root: string, path: string): string {
  const absolute = resolveInside(root, path)
  return absolute.slice(root.length + 1)
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}
