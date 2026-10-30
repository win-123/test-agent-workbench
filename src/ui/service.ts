import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertSafeTaskId,
  redactSensitiveText,
  resolveInside,
} from '../desktop/security.ts'
import { ProjectRunGate, TaskService } from '../desktop/task-service.ts'
import type { ProjectService } from '../desktop/project-service.ts'
import type { DesktopTaskRecord } from '../desktop/types.ts'
import {
  importUiRecording,
  parseUiTestCase,
  validateUiTestCase,
} from './validation.ts'
import type { UiCase, UiCaseSummary, UiRecording } from './types.ts'

export interface UiCaseServiceOptions {
  projects: ProjectService
  tasks: TaskService
  gate: ProjectRunGate
}

export class UiCaseService {
  private readonly projects: ProjectService
  private readonly tasks: TaskService

  constructor(options: UiCaseServiceOptions) {
    this.projects = options.projects
    this.tasks = options.tasks
  }

  async list(): Promise<UiCaseSummary[]> {
    const root = this.requireRoot()
    const directory = resolveInside(root, join('.test-agent', 'ui-cases'))
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const cases: UiCaseSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const summary = await this.readSummary(entry.name).catch(() => undefined)
      if (summary !== undefined) cases.push(summary)
    }
    return cases.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async get(caseId: string, version?: number): Promise<UiCase> {
    const root = this.requireRoot()
    assertSafeTaskId(caseId)
    const selectedVersion = version ?? (await this.readSummary(caseId)).version
    const path = resolveInside(root, this.versionPath(caseId, selectedVersion))
    return parseUiTestCase(await readFile(path, 'utf8'))
  }

  async save(input: unknown, expectedVersion?: number): Promise<UiCaseSummary> {
    const root = this.requireRoot()
    const validation = validateUiTestCase(input)
    if (!validation.valid || validation.testCase === undefined) {
      throw new Error(`UI test case validation failed: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
    }
    const testCase = sanitizeCase(validation.testCase)
    assertSafeTaskId(testCase.case_id)
    const existing = await this.readSummary(testCase.case_id).catch(() => undefined)
    if (existing === undefined) {
      if (testCase.version !== 1) throw new Error('a new UI test case must start at version 1')
    } else {
      if (expectedVersion === undefined) throw new Error('expectedVersion is required when updating a UI test case')
      if (existing.version !== expectedVersion) throw new Error(`UI test case changed: expected version ${expectedVersion}, current version ${existing.version}`)
      if (testCase.version !== existing.version + 1) throw new Error(`updated UI test case must use version ${existing.version + 1}`)
    }
    const versionPath = resolveInside(root, this.versionPath(testCase.case_id, testCase.version))
    await mkdir(join(versionPath, '..'), { recursive: true })
    const temporary = `${versionPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(testCase, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, versionPath)
    const summary = summarize(testCase)
    await this.writeSummary(summary)
    return summary
  }

  async importRecording(recording: UiRecording, caseId: string, expectedVersion?: number): Promise<UiCaseSummary> {
    const existing = await this.readSummary(caseId).catch(() => undefined)
    const version = existing === undefined ? 1 : existing.version + 1
    const testCase = importUiRecording(recording, { caseId, version })
    return await this.save(testCase, expectedVersion)
  }

  async execute(caseId: string, version?: number): Promise<DesktopTaskRecord> {
    const testCase = await this.get(caseId, version)
    return await this.tasks.startUiTest(testCase)
  }

  private async readSummary(caseId: string): Promise<UiCaseSummary> {
    assertSafeTaskId(caseId)
    const root = this.requireRoot()
    const path = resolveInside(root, join('.test-agent', 'ui-cases', caseId, 'current.json'))
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`UI test case not found: ${caseId}`)
      throw new Error(`cannot read UI test case metadata: ${(error as Error).message}`)
    }
    if (!isSummary(parsed) || parsed.case_id !== caseId) throw new Error('invalid UI test case metadata')
    return parsed
  }

  private async writeSummary(summary: UiCaseSummary): Promise<void> {
    const root = this.requireRoot()
    const path = resolveInside(root, join('.test-agent', 'ui-cases', summary.case_id, 'current.json'))
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private versionPath(caseId: string, version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('UI test case version must be a positive integer')
    return join('.test-agent', 'ui-cases', assertSafeTaskId(caseId), 'versions', `v${version}.json`)
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}

function sanitizeCase(input: UiCase): UiCase {
  return {
    ...input,
    name: redactSensitiveText(input.name),
    target_url: redactSensitiveText(input.target_url),
    steps: input.steps.map(step => {
      if (step.action === 'navigate') return { ...step, url: redactSensitiveText(step.url) }
      if (step.action === 'fill') return { ...step, description: step.description === undefined ? undefined : redactSensitiveText(step.description) }
      return { ...step, description: step.description === undefined ? undefined : redactSensitiveText(step.description) }
    }),
  }
}

function summarize(testCase: UiCase): UiCaseSummary {
  return {
    case_id: testCase.case_id,
    name: testCase.name,
    version: testCase.version,
    target_url: testCase.target_url,
    step_count: testCase.steps.length,
    updated_at: testCase.updated_at,
    path: join('.test-agent', 'ui-cases', testCase.case_id, 'versions', `v${testCase.version}.json`),
  }
}

function isSummary(value: unknown): value is UiCaseSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['case_id'] === 'string'
    && typeof record['name'] === 'string'
    && Number.isSafeInteger(record['version'])
    && typeof record['target_url'] === 'string'
    && Number.isSafeInteger(record['step_count'])
    && typeof record['updated_at'] === 'string'
    && typeof record['path'] === 'string'
}
