import { randomBytes } from 'node:crypto'
import { redactSensitiveText } from '../desktop/security.ts'
import { validateTestPlan } from './plan.ts'
import {
  AGENT_PLAN_SCHEMA_VERSION,
  AGENT_TOOL_NAMES,
  type FailureAnalysis,
  type TestPlan,
} from './types.ts'

export interface ModelTextClient {
  complete(input: {
    system: string
    prompt: string
    signal?: AbortSignal
  }): Promise<string>
}

export interface PlanGenerationInput {
  goal: string
  taskId: string
  harPath: string
  baseUrl: string
  authorizationScope: string
  engine?: 'k6' | 'jmeter' | 'none'
  allowedOrigins?: string[]
  signal?: AbortSignal
}

export class PlanGenerationError extends Error {
  readonly code: 'model_unavailable' | 'invalid_model_output'
  readonly issues?: string[]

  constructor(code: 'model_unavailable' | 'invalid_model_output', message: string, issues?: string[]) {
    super(message)
    this.name = 'PlanGenerationError'
    this.code = code
    this.issues = issues
  }
}

const PLAN_SYSTEM_PROMPT = `You are the planning stage of a controlled API testing plugin.
Return exactly one JSON object, with no markdown fence and no prose.
You may only plan calls to these tools: ${AGENT_TOOL_NAMES.join(', ')}.
Never propose shell commands or arbitrary executables.
Every step must include id, title, tool, arguments, test_data_refs, assertions,
depends_on, risk, and acceptance_criteria. Dependencies may only name earlier steps.
Replay and engine steps have side effects and require confirmation.
Do not invent report results. The plan describes intended execution only.`

export async function generatePlanWithModel(
  input: PlanGenerationInput,
  model: ModelTextClient | undefined,
): Promise<TestPlan> {
  if (model === undefined) {
    throw new PlanGenerationError('model_unavailable', 'no model client is available for plan generation')
  }
  const engine = input.engine ?? 'k6'
  const goal = redactSensitiveText(input.goal)
  const authorizationScope = redactSensitiveText(input.authorizationScope)
  let text: string
  try {
    text = await model.complete({
      system: PLAN_SYSTEM_PROMPT,
      prompt: [
        `Goal: ${goal}`,
        `Task id (must be used verbatim): ${input.taskId}`,
        `HAR path: ${input.harPath}`,
        `Target base URL: ${input.baseUrl}`,
        `Requested engine: ${engine}`,
        `Authorization scope: ${authorizationScope}`,
        'Produce a complete plan. At minimum inspect the HAR, replay it, and run the requested engine unless the goal explicitly says otherwise.',
      ].join('\n'),
      signal: input.signal,
    })
  } catch (error) {
    throw new PlanGenerationError('model_unavailable', `model request failed: ${(error as Error).message}`)
  }

  let generated: Record<string, unknown>
  try {
    generated = parseModelJson(text)
  } catch (error) {
    throw new PlanGenerationError('invalid_model_output', (error as Error).message)
  }

  const plan = {
    schema_version: AGENT_PLAN_SCHEMA_VERSION,
    task_id: input.taskId,
    goal: typeof generated['goal'] === 'string' && generated['goal'].trim().length > 0 ? redactSensitiveText(generated['goal']) : goal,
    target: {
      base_url: input.baseUrl,
      ...input.allowedOrigins === undefined ? {} : { allowed_origins: input.allowedOrigins },
    },
    authorization: {
      confirmed: true,
      scope: authorizationScope,
    },
    test_data: generated['test_data'] ?? [{
      name: 'primary-har',
      kind: 'har',
      location: input.harPath,
      description: 'Sanitized HAR supplied by the user.',
    }],
    request_dependencies: generated['request_dependencies'] ?? [],
    steps: generated['steps'],
  }
  const validation = validateTestPlan(plan)
  if (!validation.valid || validation.plan === undefined) {
    throw new PlanGenerationError(
      'invalid_model_output',
      'model output did not produce a valid test plan',
      validation.issues.map(item => `${item.path}: ${item.message}`),
    )
  }
  return validation.plan
}

export function draftStructuredPlan(input: Omit<PlanGenerationInput, 'signal'>): TestPlan {
  const engine = input.engine ?? 'k6'
  const goal = redactSensitiveText(input.goal)
  const authorizationScope = redactSensitiveText(input.authorizationScope)
  const steps: TestPlan['steps'] = [
    {
      id: 'inspect-har',
      title: 'Inspect and sanitize the HAR',
      tool: 'har.inspect',
      arguments: { path: input.harPath },
      test_data_refs: ['primary-har'],
      assertions: [],
      depends_on: [],
      risk: {
        level: 'low',
        side_effects: false,
        requires_confirmation: false,
        reasons: ['Reads a local HAR file only.'],
      },
      acceptance_criteria: ['HAR parses successfully and reports the expected request count.'],
    },
    {
      id: 'api-replay',
      title: 'Replay requests against the authorized target',
      tool: 'api.replay',
      arguments: { path: input.harPath, timeout_ms: 5000, concurrency: 1 },
      test_data_refs: ['primary-har'],
      assertions: [{ status: 200, description: 'Expected successful response status.' }],
      depends_on: ['inspect-har'],
      risk: {
        level: 'medium',
        side_effects: true,
        requires_confirmation: true,
        reasons: ['POST/PUT/PATCH/DELETE requests can change target data.'],
      },
      acceptance_criteria: ['Every recorded response matches its configured assertion or failure is captured in the report.'],
    },
  ]
  if (engine !== 'none') {
    steps.push({
      id: `engine-${engine}`,
      title: `Execute the real ${engine} engine`,
      tool: `engine.run.${engine}`,
      arguments: {
        path: input.harPath,
        iterations: 1,
        vus: 1,
        timeout_ms: 60000,
      },
      test_data_refs: ['primary-har'],
      assertions: [],
      depends_on: ['inspect-har'],
      risk: {
        level: 'medium',
        side_effects: true,
        requires_confirmation: true,
        reasons: ['Executes a real load engine against the authorized target.'],
      },
      acceptance_criteria: ['Engine exits, raw evidence is saved, and the unified report records metrics without fabricated values.'],
    })
  }
  const plan: TestPlan = {
    schema_version: AGENT_PLAN_SCHEMA_VERSION,
    task_id: input.taskId,
    goal,
    target: {
      base_url: input.baseUrl,
      ...input.allowedOrigins === undefined ? {} : { allowed_origins: input.allowedOrigins },
    },
    authorization: {
      confirmed: true,
      scope: authorizationScope,
    },
    test_data: [{
      name: 'primary-har',
      kind: 'har',
      location: input.harPath,
      description: 'Sanitized HAR supplied by the user.',
    }],
    request_dependencies: [],
    steps,
  }
  const validation = validateTestPlan(plan)
  if (!validation.valid || validation.plan === undefined) {
    throw new PlanGenerationError(
      'invalid_model_output',
      'local plan draft is invalid',
      validation.issues.map(item => `${item.path}: ${item.message}`),
    )
  }
  return validation.plan
}

export function draftCodeAnalysisPlan(input: {
  goal: string
  taskId: string
  javaPath: string
  baseUrl: string
  authorizationScope: string
  allowedOrigins?: string[]
}): TestPlan {
  const goal = redactSensitiveText(input.goal)
  const authorizationScope = redactSensitiveText(input.authorizationScope)
  const plan: TestPlan = {
    schema_version: AGENT_PLAN_SCHEMA_VERSION,
    task_id: input.taskId,
    goal,
    target: {
      base_url: input.baseUrl,
      ...input.allowedOrigins === undefined ? {} : { allowed_origins: input.allowedOrigins },
    },
    authorization: {
      confirmed: true,
      scope: authorizationScope,
    },
    test_data: [{
      name: 'java-input',
      kind: 'fixture',
      location: input.javaPath,
      description: 'User-selected Java source directory, WAR, or class file.',
    }],
    request_dependencies: [],
    steps: [{
      id: 'analyze-java',
      title: 'Analyze Java code without executing it',
      tool: 'code.analyze.java',
      arguments: { path: input.javaPath },
      test_data_refs: ['java-input'],
      assertions: [],
      depends_on: [],
      risk: {
        level: 'low',
        side_effects: false,
        requires_confirmation: false,
        reasons: ['Reads a local source repository or archive; no target request or shell command is executed.'],
      },
      acceptance_criteria: [
        'Every finding includes deterministic file/class/method/line evidence where available.',
        'Dynamic calls and missing dependencies are marked uncertain rather than reported as complete call chains.',
      ],
    }],
  }
  const validation = validateTestPlan(plan)
  if (!validation.valid || validation.plan === undefined) {
    throw new PlanGenerationError(
      'invalid_model_output',
      'code analysis plan is invalid',
      validation.issues.map(item => `${item.path}: ${item.message}`),
    )
  }
  return validation.plan
}

export async function enrichAnalysisWithModel(
  base: FailureAnalysis,
  model: ModelTextClient | undefined,
  signal?: AbortSignal,
): Promise<FailureAnalysis> {
  if (model === undefined) {
    return {
      ...base,
      model_status: 'unavailable',
      model_error: 'no model client is available for report analysis',
    }
  }
  let text: string
  try {
    text = await model.complete({
      system: `You are the report-analysis stage of a controlled API testing plugin.
Return one JSON object with arrays "inferences", "hypotheses", and "recommendations".
Do not restate or alter facts. Do not claim that an unobserved cause is confirmed.
Each inference and hypothesis must be tied to evidence already present in the supplied facts.`,
      prompt: JSON.stringify({
        facts: base.facts,
        existing_inferences: base.inferences,
        existing_hypotheses: base.hypotheses,
        existing_recommendations: base.recommendations,
      }),
      signal,
    })
  } catch (error) {
    return {
      ...base,
      model_status: 'unavailable',
      model_error: truncate((error as Error).message),
    }
  }
  try {
    const parsed = parseModelJson(text)
    const inferences = parseEvidenceItems(parsed['inferences'])
    const hypotheses = parseHypothesisItems(parsed['hypotheses'])
    const recommendations = parseStringItems(parsed['recommendations'])
    return {
      ...base,
      model_status: 'available',
      inferences: mergeByStatement(base.inferences, inferences),
      hypotheses: mergeByStatement(base.hypotheses, hypotheses),
      recommendations: [...new Set([...base.recommendations, ...recommendations])].slice(0, 20),
    }
  } catch (error) {
    return {
      ...base,
      model_status: 'unavailable',
      model_error: truncate(`invalid model analysis: ${(error as Error).message}`),
    }
  }
}

export function testTaskId(prefix = 'task'): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`
}

function parseModelJson(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutFence) as unknown
  } catch (error) {
    throw new Error(`model did not return valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model output must be one JSON object')
  }
  return parsed as Record<string, unknown>
}

function parseEvidenceItems(value: unknown): FailureAnalysis['inferences'] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('inferences must be an array')
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`inferences[${index}] must be an object`)
    const record = item as Record<string, unknown>
    if (typeof record['statement'] !== 'string' || typeof record['evidence'] !== 'string') {
      throw new Error(`inferences[${index}] must contain statement and evidence strings`)
    }
    return { statement: truncate(record['statement']), evidence: truncate(record['evidence']) }
  }).slice(0, 10)
}

function parseHypothesisItems(value: unknown): FailureAnalysis['hypotheses'] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('hypotheses must be an array')
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`hypotheses[${index}] must be an object`)
    const record = item as Record<string, unknown>
    if (typeof record['statement'] !== 'string' || typeof record['verification'] !== 'string') {
      throw new Error(`hypotheses[${index}] must contain statement and verification strings`)
    }
    return { statement: truncate(record['statement']), verification: truncate(record['verification']) }
  }).slice(0, 10)
}

function parseStringItems(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error('recommendations must be an array of strings')
  }
  return value.map(item => truncate(item)).slice(0, 10)
}

function mergeByStatement<T extends { statement: string }>(left: T[], right: T[]): T[] {
  const seen = new Set(left.map(item => item.statement))
  return [...left, ...right.filter(item => !seen.has(item.statement))].slice(0, 20)
}

function truncate(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...[truncated]` : value
}
