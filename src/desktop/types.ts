import type { AssertionConfig } from '../api/assertions.ts'
import type { CorrelationConfig } from '../generators/k6.ts'
import type { AgentTaskState, FailureAnalysis, TestPlan } from '../agent/types.ts'
import type { EngineKind } from '../engines/types.ts'
import type { EnginePerformanceReport } from '../engines/report.ts'
import type { TestAgentReport } from '../results/result.ts'
import type { HarHeader, HarQueryParameter } from '../har/types.ts'
import type { UiCaseSummary, UiTestReport } from '../ui/types.ts'
import type { AssetComparison, AssetRunHistory, AssetSummary, TestAsset } from '../assets/types.ts'
import type { JavaAnalysis, JavaAnalysisSummary } from '../code/types.ts'
import type { CoverageAnalysis, CoverageAnalysisSummary } from '../coverage/types.ts'
import type { ModelConnectionResult, PublicModelConfig, SaveModelConfigInput } from './model-service.ts'
import type { CredentialTestResult, PublicCredential, SaveCredentialInput } from './credential-service.ts'

export const PROJECT_SCHEMA_VERSION = 'test-agent.desktop-project/v1' as const
export const DESKTOP_TASK_SCHEMA_VERSION = 'test-agent.desktop-task/v1' as const

export interface ProjectTarget {
  baseUrl: string
  allowedOrigins: string[]
  allowedPaths: string[]
}

export interface ProjectEnvironment {
  headers: Record<string, string>
}

export interface ProjectApiConfig {
  timeoutMs: number
  concurrency: number
  assertions: AssertionConfig[]
}

export interface ProjectPerformanceConfig {
  engine: EngineKind
  vus: number
  duration: string
  iterations: number
  timeoutMs: number
  enginePaths: Partial<Record<EngineKind, string>>
}

export interface ProjectAuthorization {
  confirmed: boolean
  scope: string
}

export interface ProjectConfig {
  schema_version: typeof PROJECT_SCHEMA_VERSION
  project_id: string
  name: string
  created_at: string
  updated_at: string
  har_file?: string
  target: ProjectTarget
  environment: ProjectEnvironment
  api: ProjectApiConfig
  performance: ProjectPerformanceConfig
  correlations: CorrelationConfig[]
  authorization: ProjectAuthorization
  credentialRef?: string
}

export interface DesktopRequestView {
  order: number
  method: string
  url: string
  path: string
  headers: HarHeader[]
  query: HarQueryParameter[]
  body?: string
}

export interface RecentProject {
  name: string
  path: string
  openedAt: string
}

export interface ProjectSnapshot {
  path: string
  config: ProjectConfig
  harFileName?: string
  requests: DesktopRequestView[]
  recentProjects: RecentProject[]
}

export type DesktopTaskKind = 'api-replay' | 'performance' | 'ui-test' | 'agent'
export type DesktopTaskStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'test_failed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'
  | 'awaiting_confirmation'
  | 'succeeded'

export interface DesktopTaskRecord {
  schema_version: typeof DESKTOP_TASK_SCHEMA_VERSION
  task_id: string
  project_id: string
  kind: DesktopTaskKind
  title: string
  status: DesktopTaskStatus
  created_at: string
  started_at?: string
  finished_at?: string
  run_id?: string
  engine?: EngineKind
  script_path?: string
  report_path?: string
  log_path: string
  stdout_path?: string
  stderr_path?: string
  error?: string
  result_summary?: Record<string, unknown>
}

export interface TaskSnapshot {
  task: DesktopTaskRecord
  report?: TestAgentReport | EnginePerformanceReport | UiTestReport
  agent?: AgentTaskState
}


export interface UnifiedTaskSummary {
  task_id: string
  kind: DesktopTaskKind
  title: string
  status: DesktopTaskStatus
  created_at: string
  started_at?: string
  finished_at?: string
  run_id?: string
  engine?: EngineKind
  report_path?: string
  error?: string
}

export interface EngineStatus {
  engine: EngineKind
  installed: boolean
  executable?: string
  version?: string
  error?: string
}

export interface ScriptGenerationResult {
  engine: EngineKind
  path: string
  content: string
}

export interface AgentPlanPreview {
  plan: TestPlan
  planHash: string
  planPath: string
  riskSummary: string
  modelStatus: 'available' | 'unavailable'
  modelError?: string
  planSource: 'model' | 'deterministic'
  validation: {
    valid: boolean
    issues: Array<{ code: string; path: string; message: string }>
  }
}

export interface AgentTaskView {
  state: AgentTaskState
  analysis?: FailureAnalysis
}

export interface LogChunk {
  path: string
  content: string
  truncated: boolean
}

export interface BootstrapInfo {
  appVersion: string
  platform: string
  project?: ProjectSnapshot
  tasks: UnifiedTaskSummary[]
  engines: EngineStatus[]
  uiCases: UiCaseSummary[]
  assets: AssetSummary[]
  codeAnalyses: JavaAnalysisSummary[]
  coverageAnalyses: CoverageAnalysisSummary[]
  modelConfig: PublicModelConfig
  credentials: PublicCredential[]
}

export interface CreateProjectInput {
  name: string
}

export interface SaveProjectConfigInput {
  target: ProjectTarget
  environment: ProjectEnvironment
  api: ProjectApiConfig
  performance: ProjectPerformanceConfig
  correlations: CorrelationConfig[]
  authorization: ProjectAuthorization
  credentialRef?: string
}

export interface StartPerformanceInput {
  engine: EngineKind
}

export interface StartReplayInput {
  requestOrders?: number[]
}

export interface StartAgentInput {
  plan: TestPlan
  planHash: string
  confirmed: boolean
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapInfo>
  getModelConfig(): Promise<PublicModelConfig>
  saveModelConfig(input: SaveModelConfigInput): Promise<PublicModelConfig>
  testModelConnection(): Promise<ModelConnectionResult>
  listCredentials(): Promise<PublicCredential[]>
  saveCredential(input: SaveCredentialInput): Promise<PublicCredential>
  deleteCredential(id: string): Promise<void>
  testCredential(reference: string): Promise<CredentialTestResult>
  createProject(input: CreateProjectInput): Promise<ProjectSnapshot | null>
  openProject(): Promise<ProjectSnapshot | null>
  switchProject(path: string): Promise<ProjectSnapshot>
  importHar(): Promise<ProjectSnapshot | null>
  saveConfig(input: SaveProjectConfigInput): Promise<ProjectSnapshot>
  chooseEngineExecutable(engine: EngineKind): Promise<string | null>
  checkEngines(): Promise<EngineStatus[]>
  generateScript(engine: EngineKind): Promise<ScriptGenerationResult>
  startReplay(input?: StartReplayInput): Promise<DesktopTaskRecord>
  startPerformance(input: StartPerformanceInput): Promise<DesktopTaskRecord>
  listTasks(): Promise<UnifiedTaskSummary[]>
  getTask(taskId: string): Promise<TaskSnapshot>
  cancelTask(taskId: string): Promise<TaskSnapshot>
  taskLogs(taskId: string): Promise<LogChunk[]>
  previewAgentPlan(goal: string, engine: EngineKind | 'none'): Promise<AgentPlanPreview>
  previewCodeAgentPlan(javaPath: string, goal: string): Promise<AgentPlanPreview>
  startAgent(input: StartAgentInput): Promise<AgentTaskView>
  getAgentTask(taskId: string): Promise<AgentTaskView>
  analyzeAgentTask(taskId: string): Promise<AgentTaskView>
  openArtifact(path: string): Promise<void>
  listUiCases(): Promise<UiCaseSummary[]>
  getUiCase(caseId: string, version?: number): Promise<import('../ui/types.ts').UiTestCase>
  saveUiCase(input: unknown, expectedVersion?: number): Promise<UiCaseSummary>
  importUiRecording(input: unknown, caseId: string): Promise<UiCaseSummary>
  chooseUiRecording(): Promise<unknown | null>
  runUiCase(caseId: string, version?: number): Promise<DesktopTaskRecord>
  listAssets(): Promise<AssetSummary[]>
  scanAssets(): Promise<AssetSummary[]>
  getAsset(assetId: string, version?: number): Promise<TestAsset>
  saveAsset(input: unknown, expectedVersion?: number): Promise<AssetSummary>
  executeAsset(assetId: string): Promise<{ task_id: string; run_id?: string }>
  assetHistory(assetId: string): Promise<AssetRunHistory>
  compareAssetRuns(assetId: string, leftRunId?: string, rightRunId?: string): Promise<AssetComparison>
  listCodeAnalyses(): Promise<JavaAnalysisSummary[]>
  getCodeAnalysis(analysisId: string): Promise<JavaAnalysis>
  analyzeCode(path: string): Promise<{ analysis: JavaAnalysis; path: string }>
  chooseJavaSource(): Promise<string | null>
  chooseJavaArchive(): Promise<string | null>
  chooseRuntimeCoverage(): Promise<string | null>
  listCoverageAnalyses(): Promise<CoverageAnalysisSummary[]>
  getCoverageAnalysis(analysisId: string): Promise<CoverageAnalysis>
  analyzeCoverage(codeAnalysisId: string, runtimeCoveragePath?: string): Promise<CoverageAnalysis>
  executeCoverageCandidate(analysisId: string, candidateId: string): Promise<CoverageAnalysis>
}

export const DESKTOP_LIMITS = {
  maxHarBytes: 25 * 1024 * 1024,
  maxRequests: 100,
  maxConcurrency: 10,
  minTimeoutMs: 100,
  maxTimeoutMs: 30 * 60 * 1000,
  maxVus: 100,
  maxIterations: 10_000,
  maxDurationSeconds: 600,
  maxLogBytes: 256 * 1024,
  maxHeaderValueBytes: 4096,
} as const
