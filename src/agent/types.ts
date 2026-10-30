import type { AssertionConfig } from '../api/assertions.ts'

export const AGENT_PLAN_SCHEMA_VERSION = 'test-agent.plan/v1' as const
export const AGENT_TASK_SCHEMA_VERSION = 'test-agent.task/v1' as const

export const AGENT_TOOL_NAMES = [
  'har.inspect',
  'api.replay',
  'script.generate.k6',
  'script.generate.jmeter',
  'engine.run.k6',
  'engine.run.jmeter',
  'report.read',
  'code.analyze.java',
] as const

export type AgentToolName = typeof AGENT_TOOL_NAMES[number]
export type PlanRiskLevel = 'low' | 'medium' | 'high'
export type TaskStatus =
  | 'awaiting_confirmation'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'succeeded'

export interface PlanTestData {
  name: string
  kind: 'har' | 'fixture' | 'inline' | 'environment'
  location?: string
  value?: unknown
  description?: string
}

export interface PlanRequestDependency {
  from: number
  to: number
  kind: 'cookie' | 'token' | 'resource' | 'ordering'
  description: string
}

export interface PlanAssertion extends AssertionConfig {
  description?: string
}

export interface TestPlanStep {
  id: string
  title: string
  tool: AgentToolName
  arguments: Record<string, unknown>
  test_data_refs: string[]
  assertions: PlanAssertion[]
  depends_on: string[]
  risk: {
    level: PlanRiskLevel
    side_effects: boolean
    requires_confirmation: boolean
    reasons: string[]
  }
  acceptance_criteria: string[]
}

export interface TestPlan {
  schema_version: typeof AGENT_PLAN_SCHEMA_VERSION
  task_id: string
  goal: string
  target: {
    base_url: string
    allowed_origins?: string[]
    allowed_paths?: string[]
  }
  authorization: {
    confirmed: boolean
    scope: string
    notes?: string
  }
  test_data: PlanTestData[]
  request_dependencies: PlanRequestDependency[]
  steps: TestPlanStep[]
}

export interface PlanValidationIssue {
  code: string
  path: string
  message: string
}

export interface PlanValidationResult {
  valid: boolean
  issues: PlanValidationIssue[]
  plan?: TestPlan
}

export interface ToolExecutionContext {
  plan: TestPlan
  taskId: string
  step: TestPlanStep
  workingDirectory: string
  allowedInputRoots: string[]
  artifactDir: string
  outputDir: string
  signal: AbortSignal
}

export interface ToolExecutionResult {
  summary: Record<string, unknown>
  result: unknown
  artifacts: string[]
  runIds: string[]
  testFailure: boolean
}

export interface TaskStepState {
  step_id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_review'
  started_at?: string
  finished_at?: string
  tool_call_id?: string
  result_summary?: Record<string, unknown>
  run_ids?: string[]
  artifacts?: string[]
  error?: string
}

export interface ToolCallRecord {
  id: string
  task_id: string
  step_id: string
  tool: AgentToolName
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  side_effects: boolean
  idempotency_key: string
  input: Record<string, unknown>
  started_at: string
  finished_at?: string
  result_summary?: Record<string, unknown>
  result?: unknown
  artifacts?: string[]
  error?: string
}

export interface FailureAnalysis {
  model_status: 'not_requested' | 'available' | 'unavailable'
  model_error?: string
  facts: string[]
  inferences: Array<{ statement: string; evidence: string }>
  hypotheses: Array<{ statement: string; verification: string }>
  recommendations: string[]
}

export interface AgentTaskState {
  schema_version: typeof AGENT_TASK_SCHEMA_VERSION
  task_id: string
  plan_hash: string
  plan: TestPlan
  status: TaskStatus
  created_at: string
  updated_at: string
  confirmation: {
    required: boolean
    token: string
    confirmed_at?: string
  }
  current_step_id?: string
  steps: TaskStepState[]
  tool_calls: ToolCallRecord[]
  run_ids: string[]
  failure_analysis?: FailureAnalysis
  error?: string
}

export interface ExecuteTaskOptions {
  confirmationToken?: string
  signal?: AbortSignal
  retryUncertain?: string[]
}
