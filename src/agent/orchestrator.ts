import { join } from 'node:path'
import { createTargetPolicy, DEFAULT_ALLOWED_ORIGINS } from '../api/policy.ts'
import { analyzeTask } from './analyzer.ts'
import { parseAndValidateTestPlan, planHash, validateTestPlan } from './plan.ts'
import { TaskStore } from './state.ts'
import { createDefaultToolCatalog, type ToolCatalog } from './tools.ts'
import type {
  AgentTaskState,
  ExecuteTaskOptions,
  PlanValidationResult,
  TaskStepState,
  TestPlan,
  ToolCallRecord,
  ToolExecutionContext,
} from './types.ts'

export interface AgentOrchestratorOptions {
  workingDirectory?: string
  stateRoot?: string
  outputDir?: string
  allowedInputRoots?: string[]
  toolCatalog?: ToolCatalog
  engineExecutables?: {
    k6?: string
    jmeter?: string
  }
}

export class AgentOrchestrator {
  readonly workingDirectory: string
  readonly store: TaskStore
  readonly outputDir: string
  readonly toolCatalog: ToolCatalog
  readonly allowedInputRoots: string[]

  constructor(options: AgentOrchestratorOptions = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd()
    this.store = new TaskStore(options.stateRoot ?? join(this.workingDirectory, '.test-agent'))
    this.outputDir = options.outputDir ?? join(this.workingDirectory, 'output')
    this.allowedInputRoots = [this.workingDirectory, ...options.allowedInputRoots ?? []]
    this.toolCatalog = options.toolCatalog ?? createDefaultToolCatalog({
      outputDir: this.outputDir,
      engineExecutables: options.engineExecutables,
      allowedInputRoots: this.allowedInputRoots,
    })
  }

  validatePlan(input: unknown): PlanValidationResult {
    const result = validateTestPlan(input)
    if (!result.valid || result.plan === undefined) return result
    const issues = [...result.issues]
    try {
      createTargetPolicy(result.plan.target.base_url, result.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS)
    } catch (error) {
      issues.push({ code: 'target_policy', path: '$.target', message: (error as Error).message })
    }
    for (const [index, step] of result.plan.steps.entries()) {
      const tool = this.toolCatalog.get(step.tool)
      if (tool === undefined) {
        issues.push({ code: 'unknown_tool', path: `$.steps[${index}].tool`, message: `tool is not registered: ${step.tool}` })
        continue
      }
      for (const toolIssue of tool.validate(step.arguments)) {
        issues.push({
          code: toolIssue.code,
          path: `$.steps[${index}].${toolIssue.path}`,
          message: toolIssue.message,
        })
      }
    }
    return {
      valid: issues.length === 0,
      issues,
      ...issues.length === 0 ? { plan: result.plan } : {},
    }
  }

  parsePlan(raw: string): TestPlan {
    const parsed = parseAndValidateTestPlan(raw)
    const result = this.validatePlan(parsed)
    if (!result.valid || result.plan === undefined) {
      throw new Error(`test plan validation failed: ${result.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
    }
    return result.plan
  }

  async createTask(plan: TestPlan): Promise<AgentTaskState> {
    const validation = this.validatePlan(plan)
    if (!validation.valid || validation.plan === undefined) {
      throw new Error(`test plan validation failed: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
    }
    return await this.store.createTask(validation.plan)
  }

  async confirmTask(taskId: string, token: string): Promise<AgentTaskState> {
    const state = await this.store.load(taskId)
    if (token !== state.confirmation.token) {
      throw new Error('confirmation token does not match the task')
    }
    if (state.confirmation.confirmed_at === undefined) {
      state.confirmation.confirmed_at = new Date().toISOString()
      state.updated_at = state.confirmation.confirmed_at
      await this.store.save(state)
    }
    return state
  }

  async executeTask(taskId: string, options: ExecuteTaskOptions = {}): Promise<AgentTaskState> {
    const state = await this.store.load(taskId)
    if (state.status === 'running') {
      throw new Error(`task is already marked running: ${taskId}`)
    }
    if (state.status === 'succeeded') {
      throw new Error(`task already succeeded: ${taskId}; create a new task to run it again`)
    }
    if (options.confirmationToken !== undefined) {
      await this.confirmTask(taskId, options.confirmationToken)
    } else {
      const refreshed = await this.store.load(taskId)
      if (refreshed.confirmation.confirmed_at === undefined) {
        throw new Error(`task requires confirmation: pass --confirm ${taskId}`)
      }
    }
    if (planHash(state.plan) !== state.plan_hash) {
      throw new Error('stored plan hash does not match the task plan; refusing to execute')
    }
    if (state.status === 'cancelled') {
      await this.store.clearCancellation(taskId)
    }
    await this.store.clearCancellation(taskId)
    return await this.runLocked(taskId, options)
  }

  async resumeTask(taskId: string, options: ExecuteTaskOptions = {}): Promise<AgentTaskState> {
    const state = await this.store.load(taskId)
    if (state.status === 'succeeded') throw new Error(`task already succeeded: ${taskId}`)
    await this.store.clearCancellation(taskId)
    return await this.executeTask(taskId, options)
  }

  async cancelTask(taskId: string): Promise<AgentTaskState> {
    const state = await this.store.load(taskId)
    if (state.status === 'succeeded' || state.status === 'failed') return state
    await this.store.requestCancellation(taskId)
    if (state.status === 'running') return state
    state.status = 'cancelled'
    state.updated_at = new Date().toISOString()
    await this.store.save(state)
    return state
  }

  async analyze(taskId: string): Promise<AgentTaskState> {
    const state = await this.store.load(taskId)
    state.failure_analysis = analyzeTask(state)
    state.updated_at = new Date().toISOString()
    await this.store.save(state)
    return state
  }

  private async runLocked(taskId: string, options: ExecuteTaskOptions): Promise<AgentTaskState> {
    const release = await this.store.acquireLock(taskId)
    const controller = new AbortController()
    const externalAbort = (): void => controller.abort(options.signal?.reason ?? new Error('task cancelled'))
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    if (options.signal?.aborted === true) externalAbort()
    const interval = setInterval(() => {
      void this.store.cancellationRequested(taskId).then(requested => {
        if (requested && !controller.signal.aborted) controller.abort(new Error('task cancellation requested'))
      }).catch(() => undefined)
    }, 200)
    interval.unref()

    try {
      return await this.runSteps(taskId, options, controller.signal)
    } finally {
      clearInterval(interval)
      options.signal?.removeEventListener('abort', externalAbort)
      await release()
    }
  }

  private async runSteps(taskId: string, options: ExecuteTaskOptions, signal: AbortSignal): Promise<AgentTaskState> {
    let state = await this.store.load(taskId)
    if (state.status === 'running') {
      state.status = 'interrupted'
      state.updated_at = new Date().toISOString()
      await this.store.save(state)
    }
    state.status = 'running'
    state.error = undefined
    state.updated_at = new Date().toISOString()
    await this.store.save(state)

    for (const [index, step] of state.plan.steps.entries()) {
      const stepState = state.steps[index]
      if (stepState === undefined || stepState.step_id !== step.id) {
        return await this.failState(state, `task state is missing step ${step.id}`)
      }
      if (stepState.status === 'completed') continue

      if (signal.aborted) return await this.cancelState(state, stepState)

      const recoveryIssue = this.recoveryIssue(state, stepState, step.risk.side_effects, options.retryUncertain)
      if (recoveryIssue !== undefined) {
        stepState.status = 'needs_review'
        return await this.failState(state, recoveryIssue)
      }
      if (stepState.status === 'failed' || stepState.status === 'cancelled' || stepState.status === 'needs_review' || stepState.status === 'running') {
        stepState.status = 'pending'
        stepState.error = undefined
      }

      const tool = this.toolCatalog.get(step.tool)
      if (tool === undefined) return await this.failState(state, `tool is not allowlisted: ${step.tool}`)
      const toolIssues = tool.validate(step.arguments)
      if (toolIssues.length > 0) {
        stepState.status = 'failed'
        return await this.failState(state, `invalid arguments for ${step.tool}: ${toolIssues.map(item => item.message).join('; ')}`)
      }

      const toolCallId = `call_${Date.now().toString(36)}_${index}`
      const call: ToolCallRecord = {
        id: toolCallId,
        task_id: taskId,
        step_id: step.id,
        tool: step.tool,
        status: 'running',
        side_effects: tool.sideEffects,
        idempotency_key: `${state.plan_hash}:${step.id}`,
        input: step.arguments,
        started_at: new Date().toISOString(),
      }
      state.tool_calls.push(call)
      stepState.status = 'running'
      stepState.started_at = call.started_at
      stepState.tool_call_id = toolCallId
      state.current_step_id = step.id
      state.updated_at = call.started_at
      await this.store.save(state)

      const context: ToolExecutionContext = {
        plan: state.plan,
        taskId,
        step,
        workingDirectory: this.workingDirectory,
        allowedInputRoots: this.allowedInputRoots,
        artifactDir: this.store.artifactDir(taskId),
        outputDir: this.outputDir,
        signal,
      }
      try {
        const result = await this.toolCatalog.execute(context)
        if (signal.aborted) return await this.cancelState(state, stepState, call)
        call.status = 'succeeded'
        call.finished_at = new Date().toISOString()
        call.result_summary = result.summary
        call.result = result.result
        call.artifacts = result.artifacts
        stepState.status = 'completed'
        stepState.finished_at = call.finished_at
        stepState.result_summary = result.summary
        stepState.run_ids = result.runIds
        stepState.artifacts = result.artifacts
        state.run_ids = [...new Set([...state.run_ids, ...result.runIds])]
        state.updated_at = call.finished_at
        await this.store.save(state)
      } catch (error) {
        if (signal.aborted || (error as Error).name === 'AbortError') {
          return await this.cancelState(state, stepState, call)
        }
        call.status = 'failed'
        call.finished_at = new Date().toISOString()
        call.error = (error as Error).message
        stepState.status = 'failed'
        stepState.finished_at = call.finished_at
        stepState.error = call.error
        state.updated_at = call.finished_at
        return await this.failState(state, call.error)
      }
    }

    state.status = 'succeeded'
    state.current_step_id = undefined
    state.updated_at = new Date().toISOString()
    state.failure_analysis = analyzeTask(state)
    await this.store.save(state)
    return state
  }

  private recoveryIssue(
    state: AgentTaskState,
    stepState: TaskStepState,
    sideEffects: boolean,
    retryUncertain: string[] | undefined,
  ): string | undefined {
    if (!sideEffects) return undefined
    const uncertain = stepState.status === 'running'
      || stepState.status === 'failed'
      || stepState.status === 'cancelled'
      || stepState.status === 'needs_review'
    if (!uncertain || state.status !== 'running' && state.status !== 'interrupted' && state.status !== 'failed' && state.status !== 'cancelled') {
      return undefined
    }
    if (retryUncertain?.includes(stepState.step_id) === true) return undefined
    if (stepState.status === 'failed' || stepState.status === 'running' || stepState.status === 'cancelled' || stepState.status === 'needs_review') {
      return `step ${stepState.step_id} can produce side effects and did not complete; inspect its tool-call record and pass --retry-uncertain ${stepState.step_id} to retry explicitly`
    }
    return undefined
  }

  private async failState(state: AgentTaskState, message: string): Promise<AgentTaskState> {
    state.status = 'failed'
    state.error = message
    state.current_step_id = undefined
    state.updated_at = new Date().toISOString()
    state.failure_analysis = analyzeTask(state)
    await this.store.save(state)
    return state
  }

  private async cancelState(state: AgentTaskState, stepState: TaskStepState, call?: ToolCallRecord): Promise<AgentTaskState> {
    const now = new Date().toISOString()
    if (call !== undefined && call.status === 'running') {
      call.status = 'cancelled'
      call.finished_at = now
      call.error = 'cancelled'
    }
    if (stepState.status === 'running') {
      stepState.status = 'cancelled'
      stepState.finished_at = now
      stepState.error = 'cancelled'
    }
    state.status = 'cancelled'
    state.current_step_id = undefined
    state.updated_at = now
    state.failure_analysis = analyzeTask(state)
    await this.store.save(state)
    return state
  }
}
