import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { AgentService } from './agent-service.ts'
import { ProjectService } from './project-service.ts'
import { ProjectRunGate, TaskService } from './task-service.ts'
import { UiCaseService } from '../ui/service.ts'
import { AssetService } from '../assets/service.ts'
import { CodeAnalysisService } from '../code/service.ts'
import { CoverageService } from '../coverage/service.ts'
import { ModelConfigService, type PublicModelConfig, type SaveModelConfigInput, type SecretCodec } from './model-service.ts'
import { CredentialService, type CredentialTestResult, type PublicCredential, type SaveCredentialInput } from './credential-service.ts'
import type { EngineKind } from '../engines/types.ts'
import {
  type AgentPlanPreview,
  type AgentTaskView,
  type BootstrapInfo,
  type CreateProjectInput,
  type DesktopTaskRecord,
  type LogChunk,
  type ProjectSnapshot,
  type SaveProjectConfigInput,
  type ScriptGenerationResult,
  type StartAgentInput,
  type StartPerformanceInput,
  type StartReplayInput,
  type TaskSnapshot,
  type UnifiedTaskSummary,
} from './types.ts'
import { assertSafeEngine, assertSafeTaskId, resolveInside } from './security.ts'

export interface DesktopAppServiceOptions {
  appDataDirectory: string
  appVersion: string
  secretCodec?: SecretCodec
}

export class DesktopAppService {
  readonly projects: ProjectService
  readonly tasks: TaskService
  readonly agents: AgentService
  readonly uiCases: UiCaseService
  readonly assets: AssetService
  readonly code: CodeAnalysisService
  readonly coverage: CoverageService
  readonly models: ModelConfigService
  readonly credentials: CredentialService
  readonly appVersion: string
  private readonly gate: ProjectRunGate

  constructor(options: DesktopAppServiceOptions) {
    this.appVersion = options.appVersion
    this.models = new ModelConfigService({ appDataDirectory: options.appDataDirectory, codec: options.secretCodec ?? unavailableSecretCodec() })
    this.credentials = new CredentialService({ appDataDirectory: options.appDataDirectory, codec: options.secretCodec ?? unavailableSecretCodec() })
    this.projects = new ProjectService({ appDataDirectory: options.appDataDirectory })
    this.gate = new ProjectRunGate()
    this.tasks = new TaskService({ projects: this.projects, gate: this.gate, credentials: this.credentials })
    this.agents = new AgentService({ projects: this.projects, gate: this.gate })
    this.uiCases = new UiCaseService({ projects: this.projects, tasks: this.tasks, gate: this.gate })
    this.assets = new AssetService({ projects: this.projects, tasks: this.tasks, uiCases: this.uiCases })
    this.code = new CodeAnalysisService({ projects: this.projects })
    this.coverage = new CoverageService({ projects: this.projects, tasks: this.tasks, assets: this.assets })
  }

  async initialize(): Promise<void> {
    await this.projects.initialize()
  }

  async bootstrap(): Promise<BootstrapInfo> {
    const project = this.projects.root === undefined ? undefined : await this.projects.snapshotCurrent()
    const assets = project === undefined ? [] : await this.assets.scanExisting()
    return {
      appVersion: this.appVersion,
      platform: process.platform,
      modelConfig: await this.models.publicConfig(),
      credentials: await this.credentials.list(),
      ...project === undefined ? {} : { project },
      tasks: project === undefined ? [] : await this.listTasks(),
      engines: project === undefined ? [] : await this.tasks.checkEngines(),
      uiCases: project === undefined ? [] : await this.uiCases.list(),
      assets,
      codeAnalyses: project === undefined ? [] : await this.code.list(),
      coverageAnalyses: project === undefined ? [] : await this.coverage.list(),
    }
  }

  async getModelConfig(): Promise<PublicModelConfig> {
    return await this.models.publicConfig()
  }

  async saveModelConfig(input: SaveModelConfigInput): Promise<PublicModelConfig> {
    return await this.models.save(input)
  }

  async testModelConnection(): Promise<import('./model-service.ts').ModelConnectionResult> {
    return await this.models.testConnection()
  }

  async listCredentials(): Promise<PublicCredential[]> {
    return await this.credentials.list()
  }

  async saveCredential(input: SaveCredentialInput): Promise<PublicCredential> {
    return await this.credentials.save(input)
  }

  async deleteCredential(id: string): Promise<void> {
    await this.credentials.delete(id)
  }

  async testCredential(reference: string): Promise<CredentialTestResult> {
    return await this.credentials.testConnection(reference, this.projects.currentConfig().target.baseUrl)
  }

  async createProject(input: CreateProjectInput, parentDirectory: string): Promise<ProjectSnapshot> {
    return await this.projects.create(input.name, parentDirectory)
  }

  async openProject(path: string): Promise<ProjectSnapshot> {
    this.assertNoActiveRun()
    return await this.projects.open(path)
  }

  async switchProject(path: string): Promise<ProjectSnapshot> {
    this.assertNoActiveRun()
    return await this.projects.switchTo(path)
  }

  async importHar(path: string): Promise<ProjectSnapshot> {
    return await this.projects.importHar(path)
  }

  async saveConfig(input: SaveProjectConfigInput): Promise<ProjectSnapshot> {
    this.assertNoActiveRun()
    return await this.projects.saveConfig(input)
  }

  async checkEngines() {
    return await this.tasks.checkEngines()
  }

  async generateScript(engine: EngineKind): Promise<ScriptGenerationResult> {
    this.assertNoActiveRun()
    return await this.tasks.generateScript(assertSafeEngine(engine))
  }

  async startReplay(input?: StartReplayInput): Promise<DesktopTaskRecord> {
    return await this.tasks.startReplay(input)
  }

  async startPerformance(input: StartPerformanceInput): Promise<DesktopTaskRecord> {
    return await this.tasks.startPerformance(assertSafeEngine(input.engine))
  }

  async listTasks(): Promise<UnifiedTaskSummary[]> {
    if (this.projects.root === undefined) return []
    const [direct, agent] = await Promise.all([
      this.tasks.listTasks(),
      this.agents.listSummaries(),
    ])
    const fromDirect: UnifiedTaskSummary[] = direct.map(task => ({
      task_id: task.task_id,
      kind: task.kind,
      title: task.title,
      status: task.status,
      created_at: task.created_at,
      started_at: task.started_at,
      finished_at: task.finished_at,
      run_id: task.run_id,
      engine: task.engine,
      report_path: task.report_path,
      error: task.error,
    }))
    return [...fromDirect, ...agent].sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    assertSafeTaskId(taskId)
    if (taskId.startsWith('agent_')) {
      const view = await this.agents.getTask(taskId)
      return {
        task: agentRecord(view),
        agent: view.state,
      }
    }
    return await this.tasks.getTask(taskId)
  }

  async cancelTask(taskId: string): Promise<TaskSnapshot> {
    assertSafeTaskId(taskId)
    if (taskId.startsWith('agent_')) {
      const view = await this.agents.cancelTask(taskId)
      return { task: agentRecord(view), agent: view.state }
    }
    return await this.tasks.cancelTask(taskId)
  }

  async taskLogs(taskId: string): Promise<LogChunk[]> {
    if (assertSafeTaskId(taskId).startsWith('agent_')) {
      const view = await this.agents.getTask(taskId)
      return [{
        path: 'agent://tool-calls',
        content: JSON.stringify(view.state.tool_calls, null, 2),
        truncated: false,
      }]
    }
    return await this.tasks.taskLogs(taskId)
  }

  async previewAgentPlan(goal: string, engine: EngineKind | 'none'): Promise<AgentPlanPreview> {
    return await this.agents.previewPlan(goal, engine)
  }

  async previewCodeAgentPlan(javaPath: string, goal: string): Promise<AgentPlanPreview> {
    return await this.agents.previewCodeAnalysisPlan(javaPath, goal)
  }

  async startAgent(input: StartAgentInput): Promise<AgentTaskView> {
    return await this.agents.start(input)
  }

  async getAgentTask(taskId: string): Promise<AgentTaskView> {
    return await this.agents.getTask(assertSafeTaskId(taskId))
  }

  async analyzeAgentTask(taskId: string): Promise<AgentTaskView> {
    return await this.agents.analyze(assertSafeTaskId(taskId))
  }

  async resolveArtifact(path: string): Promise<string> {
    const root = this.requireRoot()
    const absolute = resolveInside(root, path)
    await stat(absolute)
    const extension = extname(absolute).toLowerCase()
    const allowed = new Set(['.json', '.log', '.jtl', '.js', '.jmx', '.har', '.txt', '.md', '.png'])
    if (!allowed.has(extension)) throw new Error(`file type is not openable from the workbench: ${extension || 'none'}`)
    if (absolute.endsWith('/project.json')) throw new Error('project configuration is not exposed as a raw artifact')
    return absolute
  }

  async listUiCases() {
    return await this.uiCases.list()
  }

  async getUiCase(caseId: string, version?: number) {
    return await this.uiCases.get(caseId, version)
  }

  async saveUiCase(input: unknown, expectedVersion?: number) {
    this.assertNoActiveRun()
    return await this.uiCases.save(input, expectedVersion)
  }

  async importUiRecording(input: unknown, caseId: string) {
    this.assertNoActiveRun()
    return await this.uiCases.importRecording(input as never, caseId)
  }

  async runUiCase(caseId: string, version?: number) {
    return await this.uiCases.execute(caseId, version)
  }

  async listAssets() {
    return await this.assets.list()
  }

  async scanAssets() {
    this.assertNoActiveRun()
    return await this.assets.scanExisting()
  }

  async getAsset(assetId: string, version?: number) {
    return await this.assets.get(assetId, version)
  }

  async saveAsset(input: unknown, expectedVersion?: number) {
    this.assertNoActiveRun()
    return await this.assets.save(input, expectedVersion)
  }

  async executeAsset(assetId: string) {
    return await this.assets.execute(assetId)
  }

  async assetHistory(assetId: string) {
    return await this.assets.history(assetId)
  }

  async compareAssetRuns(assetId: string, leftRunId?: string, rightRunId?: string) {
    return await this.assets.compare(assetId, leftRunId, rightRunId)
  }

  async listCodeAnalyses() {
    return await this.code.list()
  }

  async getCodeAnalysis(analysisId: string) {
    return await this.code.get(analysisId)
  }

  async analyzeCode(path: string) {
    this.assertNoActiveRun()
    return await this.code.analyze(path)
  }

  async listCoverageAnalyses() {
    return await this.coverage.list()
  }

  async getCoverageAnalysis(analysisId: string) {
    return await this.coverage.get(analysisId)
  }

  async analyzeCoverage(codeAnalysisId: string, runtimeCoveragePath?: string) {
    this.assertNoActiveRun()
    const codeAnalysis = await this.code.get(codeAnalysisId)
    const analysis = await this.coverage.analyze(codeAnalysis, runtimeCoveragePath)
    await this.coverage.save(analysis)
    return analysis
  }

  async executeCoverageCandidate(analysisId: string, candidateId: string) {
    return await this.coverage.executePersistedCandidate(analysisId, candidateId)
  }

  async shutdown(): Promise<void> {
    await this.agents.shutdown()
    await this.tasks.shutdown()
  }

  private assertNoActiveRun(): void {
    if (this.projects.root === undefined) return
    const projectId = this.projects.currentConfig().project_id
    if (this.gate.isActive(projectId)) throw new Error('stop the running task before changing projects or configuration')
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}

function agentRecord(view: AgentTaskView): DesktopTaskRecord {
  const state = view.state
  return {
    schema_version: 'test-agent.desktop-task/v1',
    task_id: state.task_id,
    project_id: '',
    kind: 'agent',
    title: state.plan.goal,
    status: state.status,
    created_at: state.created_at,
    started_at: state.steps.find(step => step.started_at !== undefined)?.started_at,
    finished_at: state.updated_at,
    run_id: state.run_ids[0],
    report_path: state.tool_calls.flatMap(call => call.artifacts ?? []).find(path => path.endsWith('.report.json')),
    log_path: 'agent://tool-calls',
    error: state.error,
  }
}

function unavailableSecretCodec(): SecretCodec {
  return {
    isEncryptionAvailable: () => false,
    encrypt: () => {
      throw new Error('secure secret storage is unavailable in this process')
    },
    decrypt: () => {
      throw new Error('secure secret storage is unavailable in this process')
    },
  }
}
