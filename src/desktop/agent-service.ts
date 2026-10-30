import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentOrchestrator } from '../agent/orchestrator.ts'
import { planHash, summarizePlanRisk } from '../agent/plan.ts'
import { draftCodeAnalysisPlan, draftStructuredPlan, enrichAnalysisWithModel, generatePlanWithModel, testTaskId, type ModelTextClient } from '../agent/planner.ts'
import type { AgentTaskState, TestPlan } from '../agent/types.ts'
import type { EngineKind } from '../engines/types.ts'
import type { AgentPlanPreview, AgentTaskView, UnifiedTaskSummary } from './types.ts'
import type { ProjectService } from './project-service.ts'
import { ProjectRunGate } from './task-service.ts'
import { assertSafeTaskId, redactSensitiveText, resolveInside } from './security.ts'

export interface AgentServiceOptions {
  projects: ProjectService
  gate: ProjectRunGate
  model?: ModelTextClient
}

interface ActiveAgentTask {
  controller: AbortController
  promise: Promise<void>
}

const MODEL_UNAVAILABLE = 'No Harness model gateway is configured for the desktop process; deterministic planning remains available.'

export class AgentService {
  readonly projects: ProjectService
  readonly gate: ProjectRunGate
  private readonly active = new Map<string, ActiveAgentTask>()
  private readonly model?: ModelTextClient

  constructor(options: AgentServiceOptions) {
    this.projects = options.projects
    this.gate = options.gate
    this.model = options.model
  }

  async previewPlan(goal: string, engine: EngineKind | 'none'): Promise<AgentPlanPreview> {
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    const cleanGoal = validateGoal(goal)
    if (config.har_file === undefined) throw new Error('import a HAR file before asking the Agent to plan')
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    if (engine !== 'k6' && engine !== 'jmeter' && engine !== 'none') throw new Error('agent engine must be k6, jmeter, or none')
    const orchestrator = this.orchestrator(root)
    const taskId = testTaskId('agent')
    const deterministic = draftStructuredPlan({
      goal: cleanGoal,
      taskId,
      harPath: this.projects.harPath(),
      baseUrl: config.target.baseUrl,
      authorizationScope: config.authorization.scope,
      engine,
      allowedOrigins: config.target.allowedOrigins,
    })
    if (this.model === undefined) return await this.persistPreview(root, deterministic, {
      modelStatus: 'unavailable',
      modelError: MODEL_UNAVAILABLE,
      planSource: 'deterministic',
    })
    try {
      const plan = await generatePlanWithModel({
        goal: cleanGoal,
        taskId,
        harPath: this.projects.harPath(),
        baseUrl: config.target.baseUrl,
        authorizationScope: config.authorization.scope,
        engine,
        allowedOrigins: config.target.allowedOrigins,
      }, this.model)
      return await this.persistPreview(root, plan, {
        modelStatus: 'available',
        planSource: 'model',
      })
    } catch (error) {
      return await this.persistPreview(root, deterministic, {
        modelStatus: 'unavailable',
        modelError: redactSensitiveText((error as Error).message),
        planSource: 'deterministic',
      })
    }
  }

  async previewCodeAnalysisPlan(javaPath: string, goal: string): Promise<AgentPlanPreview> {
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    const cleanGoal = validateGoal(goal)
    requireAuthorizedTarget(config.target.baseUrl, config.authorization.confirmed)
    const taskId = testTaskId('agent')
    const canonicalJavaPath = await realpath(javaPath)
    const plan = draftCodeAnalysisPlan({
      goal: cleanGoal,
      taskId,
      javaPath: canonicalJavaPath,
      baseUrl: config.target.baseUrl,
      authorizationScope: config.authorization.scope,
      allowedOrigins: config.target.allowedOrigins,
    })
    const validation = this.orchestrator(root).validatePlan(plan)
    if (!validation.valid) throw new Error(`code analysis plan validation failed: ${validation.issues.map(item => item.message).join('; ')}`)
    await this.saveCodeInputAuthorization(root, plan.task_id, canonicalJavaPath)
    return await this.persistPreview(root, plan, {
      modelStatus: this.model === undefined ? 'unavailable' : 'available',
      ...this.model === undefined ? { modelError: MODEL_UNAVAILABLE } : { modelError: 'Code analysis planning is deterministic; model explanation is applied after tool execution.' },
      planSource: 'deterministic',
    })
  }

  async start(input: { plan: TestPlan; planHash: string; confirmed: boolean }): Promise<AgentTaskView> {
    if (input.confirmed !== true) throw new Error('explicit confirmation is required before executing an Agent plan')
    const root = this.requireRoot()
    const config = this.projects.currentConfig()
    if (!config.authorization.confirmed) throw new Error('confirm the authorized test scope before running the Agent')
    if (planHash(input.plan) !== input.planHash) throw new Error('plan content changed after review; generate and confirm the plan again')
    if (input.plan.target.base_url !== config.target.baseUrl) throw new Error('plan target no longer matches the project target')
    const orchestrator = this.orchestrator(root, await this.authorizedCodeInputRoots(root, input.plan))
    const validation = orchestrator.validatePlan(input.plan)
    if (!validation.valid) throw new Error(`plan validation failed: ${validation.issues.map(item => item.message).join('; ')}`)
    const release = this.gate.acquire(config.project_id)
    let state: AgentTaskState
    try {
      state = await orchestrator.createTask(input.plan)
      state = await orchestrator.confirmTask(state.task_id, state.confirmation.token)
    } catch (error) {
      release()
      throw error
    }
    const controller = new AbortController()
    const promise = orchestrator.executeTask(state.task_id, {
      confirmationToken: state.confirmation.token,
      signal: controller.signal,
    }).then(() => undefined).catch(() => undefined).finally(() => {
      release()
      this.active.delete(state.task_id)
    })
    this.active.set(state.task_id, { controller, promise })
    return { state }
  }

  private async persistPreview(
    root: string,
    plan: TestPlan,
    model: { modelStatus: 'available' | 'unavailable'; modelError?: string; planSource: 'model' | 'deterministic' },
  ): Promise<AgentPlanPreview> {
    const orchestrator = this.orchestrator(root)
    const validation = orchestrator.validatePlan(plan)
    const planPath = resolveInside(root, join('.test-agent', 'plans', `${plan.task_id}.json`))
    await mkdir(join(planPath, '..'), { recursive: true })
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
    return {
      plan,
      planHash: planHash(plan),
      planPath,
      riskSummary: summarizePlanRisk(plan),
      ...model,
      validation: { valid: validation.valid, issues: validation.issues },
    }
  }

  async getTask(taskId: string): Promise<AgentTaskView> {
    const orchestrator = this.orchestrator(this.requireRoot())
    const state = await orchestrator.store.load(assertSafeTaskId(taskId))
    return { state, ...state.failure_analysis === undefined ? {} : { analysis: state.failure_analysis } }
  }

  async analyze(taskId: string): Promise<AgentTaskView> {
    const orchestrator = this.orchestrator(this.requireRoot())
    const state = await orchestrator.analyze(assertSafeTaskId(taskId))
    if (this.model !== undefined && state.failure_analysis !== undefined) {
      state.failure_analysis = await enrichAnalysisWithModel(state.failure_analysis, this.model)
      state.updated_at = new Date().toISOString()
      await orchestrator.store.save(state)
    }
    return { state, ...state.failure_analysis === undefined ? {} : { analysis: state.failure_analysis } }
  }

  async cancelTask(taskId: string): Promise<AgentTaskView> {
    const orchestrator = this.orchestrator(this.requireRoot())
    const active = this.active.get(assertSafeTaskId(taskId))
    const state = await orchestrator.cancelTask(taskId)
    if (active !== undefined) {
      active.controller.abort(new Error('agent task cancelled by user'))
      await active.promise
      return await this.getTask(taskId)
    }
    return { state, ...state.failure_analysis === undefined ? {} : { analysis: state.failure_analysis } }
  }

  async listSummaries(): Promise<UnifiedTaskSummary[]> {
    if (this.projects.root === undefined) return []
    const states = await this.orchestrator(this.projects.root).store.list()
    return states.map(state => ({
      task_id: state.task_id,
      kind: 'agent',
      title: state.plan.goal,
      status: state.status,
      created_at: state.created_at,
      started_at: state.steps.find(step => step.started_at !== undefined)?.started_at,
      finished_at: state.updated_at,
      run_id: state.run_ids[0],
      report_path: state.tool_calls.flatMap(call => call.artifacts ?? []).find(path => path.endsWith('.report.json')),
      error: state.error,
    }))
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    const entries = [...this.active.entries()]
    for (const [taskId, active] of entries) {
      active.controller.abort(new Error('application is shutting down'))
      await this.orchestrator(this.requireRoot()).cancelTask(taskId).catch(() => undefined)
    }
    await Promise.race([
      Promise.allSettled(entries.map(([, active]) => active.promise)),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId)
  }

  private orchestrator(root: string, inputRoots: string[] = []): AgentOrchestrator {
    return new AgentOrchestrator({
      workingDirectory: root,
      stateRoot: join(root, '.test-agent'),
      outputDir: join(root, 'output'),
      allowedInputRoots: inputRoots,
      engineExecutables: this.projects.currentConfig().performance.enginePaths,
    })
  }

  private async authorizedCodeInputRoots(root: string, plan: TestPlan): Promise<string[]> {
    const step = plan.steps.find(item => item.tool === 'code.analyze.java')
    if (step === undefined) return []
    const path = resolveInside(root, join('.test-agent', 'code-inputs', `${assertSafeTaskId(plan.task_id)}.json`))
    let authorization: { task_id?: unknown; input_root?: unknown }
    try {
      authorization = JSON.parse(await readFile(path, 'utf8')) as typeof authorization
    } catch {
      throw new Error('code analysis input authorization is missing; generate the plan again')
    }
    if (authorization.task_id !== plan.task_id || typeof authorization.input_root !== 'string') {
      throw new Error('code analysis input authorization is invalid')
    }
    const authorizedRoot = await realpath(authorization.input_root)
    const plannedRoot = await realpath(String(step.arguments['path']))
    if (plannedRoot !== authorizedRoot) {
      throw new Error('code analysis plan path differs from the authorized input')
    }
    return [authorizedRoot]
  }

  private async saveCodeInputAuthorization(root: string, taskId: string, inputRoot: string): Promise<void> {
    const path = resolveInside(root, join('.test-agent', 'code-inputs', `${assertSafeTaskId(taskId)}.json`))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify({
      schema_version: 'test-agent.code-input/v1',
      task_id: taskId,
      input_root: inputRoot,
      authorized_at: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 })
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}

function validateGoal(goal: string): string {
  if (typeof goal !== 'string') throw new Error('test goal must be text')
  const clean = goal.trim()
  if (clean.length < 3 || clean.length > 4000) throw new Error('test goal must be between 3 and 4000 characters')
  return redactSensitiveText(clean)
}

function requireAuthorizedTarget(baseUrl: string, confirmed: boolean): void {
  if (baseUrl.trim().length === 0) throw new Error('configure the target base URL before using the Agent')
  if (!confirmed) throw new Error('confirm the authorized test scope before using the Agent')
}

export async function readPlanFile(path: string): Promise<TestPlan> {
  return JSON.parse(await readFile(path, 'utf8')) as TestPlan
}
