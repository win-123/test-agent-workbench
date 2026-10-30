import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { analyzeTask } from '../agent/analyzer.ts'
import { AgentOrchestrator } from '../agent/orchestrator.ts'
import { planHash, summarizePlanRisk } from '../agent/plan.ts'
import {
  draftStructuredPlan,
  enrichAnalysisWithModel,
  generatePlanWithModel,
  PlanGenerationError,
  testTaskId,
  type ModelTextClient,
} from '../agent/planner.ts'
import type { AgentTaskState, TestPlan } from '../agent/types.ts'
import type { JsonValue } from '../results/result.ts'

interface AgentRoute {
  provider: string
  model: string
}

interface AgentLike {
  options: {
    provider?: string
    model?: string
  }
  session: {
    requestHeader(): { config?: { provider?: string; model?: string } } | undefined
  }
}

interface StreamChunkLike {
  type: string
  index?: number
  text?: string
  block?: { type?: string; text?: string }
  reason?: {
    kind?: string
    failure?: { message?: string }
  }
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<StreamChunkLike>
}

interface ApprovalLike {
  request(request: {
    agent: unknown
    toolName: string
    callId: unknown
    reason: string
    signal: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

interface PlanToolResult {
  model_status: 'available' | 'unavailable'
  model_error?: string
  plan_source: 'model' | 'deterministic'
  plan: TestPlan
  plan_hash: string
  risk_summary: string
}

export function registerAgentTools(ctx: Context): void {
  const workingDirectory = process.env.TEST_AGENT_WORKING_DIRECTORY ?? process.cwd()
  const orchestrator = new AgentOrchestrator({
    workingDirectory,
    stateRoot: process.env.TEST_AGENT_STATE_ROOT ?? join(workingDirectory, '.test-agent'),
    outputDir: process.env.TEST_AGENT_OUTPUT_DIR ?? join(workingDirectory, 'output'),
  })

  ctx.tools.register(defineTool({
    name: 'test_agent_plan',
    description: 'Create a validated structured test plan for a described API testing goal. Uses the current Harness model when available; otherwise returns an explicitly labelled deterministic draft.',
    parameters: {
      goal: { type: 'string', required: true, description: 'Testing goal in natural language' },
      har_path: { type: 'string', required: true, description: 'Absolute path to a sanitized HAR file' },
      base_url: { type: 'string', required: true, description: 'Explicitly authorized target base URL' },
      task_id: { type: 'string', description: 'Optional task id; generated when omitted' },
      engine: { type: 'string', description: 'k6, jmeter, or none' },
      authorization_scope: { type: 'string', description: 'Explicit authorization scope for the target' },
      allowed_origins: { type: 'json', description: 'Optional array of allowed origins' },
      use_model: { type: 'boolean', description: 'Set false to request a deterministic plan only' },
    },
    output: jsonOutput(),
    async execute(args: {
      goal: string
      har_path: string
      base_url: string
      task_id?: string
      engine?: string
      authorization_scope?: string
      allowed_origins?: unknown
      use_model?: boolean
    }, exec: ToolRunContext) {
      return jsonValue(await createPlanResult(ctx, exec, {
        goal: args.goal,
        harPath: resolve(args.har_path),
        baseUrl: args.base_url,
        taskId: args.task_id ?? testTaskId('agent'),
        engine: parseEngine(args.engine ?? 'k6'),
        authorizationScope: args.authorization_scope ?? 'Only the explicitly supplied test target is authorized.',
        allowedOrigins: parseStringArray(args.allowed_origins, 'allowed_origins'),
        useModel: args.use_model ?? true,
      }, orchestrator))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_validate_plan',
    description: 'Validate a structured test plan, including tool allowlisting, argument shape, risk declarations, dependencies, and authorization.',
    parameters: {
      plan: { type: 'json', required: true, description: 'Structured test-agent.plan/v1 object' },
    },
    output: jsonOutput(),
    async execute(args: { plan: unknown }) {
      const result = orchestrator.validatePlan(args.plan)
      return jsonValue({
        valid: result.valid,
        issues: result.issues,
        ...result.plan === undefined ? {} : {
          plan_hash: planHash(result.plan),
          risk_summary: summarizePlanRisk(result.plan),
        },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_create_task',
    description: 'Persist a validated test plan as an awaiting-confirmation task. Returns the confirmation token and initial task state.',
    parameters: {
      plan: { type: 'json', required: true, description: 'Structured test-agent.plan/v1 object' },
    },
    output: jsonOutput(),
    async execute(args: { plan: unknown }) {
      const validation = orchestrator.validatePlan(args.plan)
      if (!validation.valid || validation.plan === undefined) {
        throw new Error(`test plan validation failed: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
      }
      return jsonValue(publicTaskState(await orchestrator.createTask(validation.plan)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_run',
    description: 'Plan, request user approval, execute, persist, and analyze a test task. The target must already be explicitly authorized; execution never bypasses the Harness approval service.',
    parameters: {
      goal: { type: 'string', required: true, description: 'Testing goal in natural language' },
      har_path: { type: 'string', required: true, description: 'Absolute path to a sanitized HAR file' },
      base_url: { type: 'string', required: true, description: 'Explicitly authorized target base URL' },
      task_id: { type: 'string', description: 'Optional task id; generated when omitted' },
      engine: { type: 'string', description: 'k6, jmeter, or none' },
      authorization_scope: { type: 'string', description: 'Explicit authorization scope for the target' },
      allowed_origins: { type: 'json', description: 'Optional array of allowed origins' },
      use_model: { type: 'boolean', description: 'Set false to request a deterministic plan only' },
    },
    output: jsonOutput(),
    async execute(args: {
      goal: string
      har_path: string
      base_url: string
      task_id?: string
      engine?: string
      authorization_scope?: string
      allowed_origins?: unknown
      use_model?: boolean
    }, exec: ToolRunContext) {
      const planResult = await createPlanResult(ctx, exec, {
        goal: args.goal,
        harPath: resolve(args.har_path),
        baseUrl: args.base_url,
        taskId: args.task_id ?? testTaskId('agent'),
        engine: parseEngine(args.engine ?? 'k6'),
        authorizationScope: args.authorization_scope ?? 'Only the explicitly supplied test target is authorized.',
        allowedOrigins: parseStringArray(args.allowed_origins, 'allowed_origins'),
        useModel: args.use_model ?? true,
      }, orchestrator)
      const task = await orchestrator.createTask(planResult.plan)
      const executed = await executeWithApproval(
        ctx,
        exec,
        orchestrator,
        task.task_id,
        [],
      )
      const analyzed = await analyzeWithModel(ctx, exec, orchestrator, executed.task_id)
      return jsonValue({
        plan_result: planResult,
        task: publicTaskState(executed),
        analysis: analyzed.failure_analysis ?? analyzeTask(analyzed),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_execute_task',
    description: 'Execute an awaiting-confirmation task after explicit Harness user approval. Completed steps are skipped; uncertain side-effecting steps require retry_uncertain.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id' },
      retry_uncertain: { type: 'json', description: 'Optional array of step ids explicitly approved for retry' },
    },
    output: jsonOutput(),
    async execute(args: { task_id: string; retry_uncertain?: unknown }, exec: ToolRunContext) {
      const retryUncertain = parseStringArray(args.retry_uncertain, 'retry_uncertain')
      return jsonValue(publicTaskState(await executeWithApproval(ctx, exec, orchestrator, args.task_id, retryUncertain)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_resume_task',
    description: 'Resume a failed, interrupted, or cancelled task after user approval, skipping completed steps and refusing uncertain side effects unless explicitly listed.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id' },
      retry_uncertain: { type: 'json', description: 'Optional array of step ids explicitly approved for retry' },
    },
    output: jsonOutput(),
    async execute(args: { task_id: string; retry_uncertain?: unknown }, exec: ToolRunContext) {
      const retryUncertain = parseStringArray(args.retry_uncertain, 'retry_uncertain')
      return jsonValue(publicTaskState(await executeWithApproval(ctx, exec, orchestrator, args.task_id, retryUncertain, true)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_cancel_task',
    description: 'Request cancellation of a pending, interrupted, or running test task while preserving state and completed-step evidence.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id' },
    },
    output: jsonOutput(),
    async execute(args: { task_id: string }) {
      return jsonValue(publicTaskState(await orchestrator.cancelTask(args.task_id)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_task_status',
    description: 'Read a persisted test task, including plan, completed steps, run IDs, tool-call records, artifacts, and failure analysis.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id' },
    },
    output: jsonOutput(),
    async execute(args: { task_id: string }) {
      return jsonValue(publicTaskState(await orchestrator.store.load(args.task_id)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_list_tasks',
    description: 'List persisted test tasks with status, completed steps, remaining steps, and run IDs.',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      return jsonValue((await orchestrator.store.list()).map(taskSummary))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_agent_analyze_task',
    description: 'Analyze real recorded reports and tool failures, separating facts, evidence-backed inferences, unverified hypotheses, and recommendations.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id' },
    },
    output: jsonOutput(),
    async execute(args: { task_id: string }, exec: ToolRunContext) {
      const state = await analyzeWithModel(ctx, exec, orchestrator, args.task_id)
      return jsonValue({
        task_id: state.task_id,
        status: state.status,
        analysis: state.failure_analysis ?? analyzeTask(state),
      })
    },
  }))
}

async function createPlanResult(
  ctx: Context,
  exec: ToolRunContext,
  input: {
    goal: string
    harPath: string
    baseUrl: string
    taskId: string
    engine: 'k6' | 'jmeter' | 'none'
    authorizationScope: string
    allowedOrigins: string[]
    useModel: boolean
  },
  orchestrator: AgentOrchestrator,
): Promise<PlanToolResult> {
  exec.signal.throwIfAborted()
  const fallback = (): PlanToolResult => {
    exec.signal.throwIfAborted()
    const plan = draftStructuredPlan({
      goal: input.goal,
      taskId: input.taskId,
      harPath: input.harPath,
      baseUrl: input.baseUrl,
      authorizationScope: input.authorizationScope,
      engine: input.engine,
      allowedOrigins: input.allowedOrigins.length === 0 ? [input.baseUrl] : input.allowedOrigins,
    })
    const validation = orchestrator.validatePlan(plan)
    if (!validation.valid || validation.plan === undefined) {
      throw new Error(`deterministic plan is invalid: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
    }
    return {
      model_status: 'unavailable',
      ...(!input.useModel ? {} : {
        model_error: 'no usable Harness model route was available',
      }),
      plan_source: 'deterministic',
      plan: validation.plan,
      plan_hash: planHash(validation.plan),
      risk_summary: summarizePlanRisk(validation.plan),
    }
  }

  if (!input.useModel) return fallback()
  const model = createModelClient(ctx, exec)
  if (model === undefined) return fallback()
  try {
    const plan = await generatePlanWithModel({
      goal: input.goal,
      taskId: input.taskId,
      harPath: input.harPath,
      baseUrl: input.baseUrl,
      authorizationScope: input.authorizationScope,
      engine: input.engine,
      allowedOrigins: input.allowedOrigins.length === 0 ? [input.baseUrl] : input.allowedOrigins,
      signal: exec.signal,
    }, model)
    const validation = orchestrator.validatePlan(plan)
    if (!validation.valid || validation.plan === undefined) {
      throw new PlanGenerationError(
        'invalid_model_output',
        `model plan failed tool-catalog validation: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`,
      )
    }
    return {
      model_status: 'available',
      plan_source: 'model',
      plan: validation.plan,
      plan_hash: planHash(validation.plan),
      risk_summary: summarizePlanRisk(validation.plan),
    }
  } catch (error) {
    const result = fallback()
    result.model_error = error instanceof PlanGenerationError
      ? `${error.code}: ${error.message}`
      : `model plan generation failed: ${(error as Error).message}`
    return result
  }
}

async function executeWithApproval(
  ctx: Context,
  exec: ToolRunContext,
  orchestrator: AgentOrchestrator,
  taskId: string,
  retryUncertain: string[],
  resume = false,
): Promise<AgentTaskState> {
  exec.signal.throwIfAborted()
  const state = await orchestrator.store.load(taskId)
  if (state.status === 'succeeded') throw new Error(`task already succeeded: ${taskId}`)
  const approval = getService<ApprovalLike>(ctx, 'approval')
  if (approval === undefined) {
    throw new Error('task execution requires user confirmation, but the Harness approval service is unavailable')
  }
  if (exec.agent === undefined) {
    throw new Error('task execution requires an agent-scoped approval request')
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: resume ? 'test_agent_resume_task' : 'test_agent_execute_task',
    callId: exec.callId,
    reason: summarizePlanRisk(state.plan),
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`task execution was not confirmed: ${outcome}`)
  }
  const options = {
    confirmationToken: state.confirmation.token,
    retryUncertain: retryUncertain.length === 0 ? undefined : retryUncertain,
    signal: exec.signal,
  }
  return resume
    ? await orchestrator.resumeTask(taskId, options)
    : await orchestrator.executeTask(taskId, options)
}

async function analyzeWithModel(
  ctx: Context,
  exec: ToolRunContext,
  orchestrator: AgentOrchestrator,
  taskId: string,
): Promise<AgentTaskState> {
  exec.signal.throwIfAborted()
  const state = await orchestrator.store.load(taskId)
  const deterministic = analyzeTask(state)
  const enriched = await enrichAnalysisWithModel(deterministic, createModelClient(ctx, exec), exec.signal)
  state.failure_analysis = enriched
  state.updated_at = new Date().toISOString()
  await orchestrator.store.save(state)
  return state
}

function createModelClient(ctx: Context, exec: ToolRunContext): ModelTextClient | undefined {
  const llm = getService<LlmLike>(ctx, 'llm')
  const route = resolveAgentRoute(exec)
  if (llm === undefined || route === undefined) return undefined
  return {
    async complete(input) {
      const textByIndex = new Map<number, string>()
      const closedText = new Map<number, string>()
      let finish: StreamChunkLike['reason']
      for await (const chunk of llm.stream({
        ...route,
        system: input.system,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
        }],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })) {
        if (chunk.type === 'text-delta' && chunk.index !== undefined && chunk.text !== undefined) {
          textByIndex.set(chunk.index, (textByIndex.get(chunk.index) ?? '') + chunk.text)
        } else if (chunk.type === 'block-end' && chunk.index !== undefined && chunk.block?.type === 'text') {
          closedText.set(chunk.index, chunk.block.text ?? '')
        } else if (chunk.type === 'finish') {
          finish = chunk.reason
        }
      }
      if (finish === undefined) throw new Error('model stream ended without a terminal finish')
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        throw new Error(finish.failure?.message ?? `model request ${finish.kind}`)
      }
      if (finish?.kind === 'max-tokens') throw new Error('model output was truncated at the token cap')
      const indexes = [...new Set([...textByIndex.keys(), ...closedText.keys()])].sort((left, right) => left - right)
      return indexes.map(index => textByIndex.get(index) || closedText.get(index) || '').join('')
    },
  }
}

function resolveAgentRoute(exec: ToolRunContext): AgentRoute | undefined {
  const agent = exec.agent as unknown as AgentLike | undefined
  if (agent === undefined) return undefined
  const latest = safeRequestHeader(agent)
  const provider = agent.options.provider ?? latest?.provider
  const model = agent.options.model ?? latest?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
  return { provider, model }
}

function safeRequestHeader(agent: AgentLike): { provider?: string; model?: string } | undefined {
  try {
    return agent.session.requestHeader()?.config
  } catch {
    return undefined
  }
}

function getService<T>(ctx: Context, name: string): T | undefined {
  const holder = ctx as unknown as { get(serviceName: string): unknown }
  try {
    return holder.get(name) as T | undefined
  } catch {
    return undefined
  }
}

function publicTaskState(state: AgentTaskState, includeToken = false): Record<string, unknown> {
  return {
    ...state,
    confirmation: {
      required: state.confirmation.required,
      token: includeToken ? state.confirmation.token : '[REDACTED]',
      ...state.confirmation.confirmed_at === undefined ? {} : { confirmed_at: state.confirmation.confirmed_at },
    },
  }
}

function taskSummary(state: AgentTaskState): Record<string, unknown> {
  return {
    task_id: state.task_id,
    goal: state.plan.goal,
    status: state.status,
    created_at: state.created_at,
    updated_at: state.updated_at,
    completed_steps: state.steps.filter(step => step.status === 'completed').map(step => step.step_id),
    remaining_steps: state.steps.filter(step => step.status !== 'completed').map(step => step.step_id),
    run_ids: state.run_ids,
  }
}

function parseEngine(value: string): 'k6' | 'jmeter' | 'none' {
  if (value === 'k6' || value === 'jmeter' || value === 'none') return value
  throw new Error('engine must be k6, jmeter, or none')
}

function parseStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value
}

function jsonOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
