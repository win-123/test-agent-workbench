import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { renderFailureAnalysis } from '../agent/analyzer.ts'
import { AgentOrchestrator } from '../agent/orchestrator.ts'
import { planHash, summarizePlanRisk } from '../agent/plan.ts'
import { draftStructuredPlan, testTaskId } from '../agent/planner.ts'
import type { AgentTaskState, TestPlan } from '../agent/types.ts'

export async function agentCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? ''
  const orchestrator = new AgentOrchestrator()

  if (subcommand === 'plan') {
    await planCommand(argv.slice(1), orchestrator)
    return
  }
  if (subcommand === 'validate') {
    await validateCommand(argv.slice(1), orchestrator)
    return
  }
  if (subcommand === 'create') {
    await createCommand(argv.slice(1), orchestrator)
    return
  }
  if (subcommand === 'confirm') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    const token = requireOption(argv.slice(2), '--token')
    printState(await orchestrator.confirmTask(taskId, token))
    return
  }
  if (subcommand === 'execute') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    const options = argv.slice(2)
    const state = await orchestrator.executeTask(taskId, {
      confirmationToken: option(options, '--confirm'),
      retryUncertain: retryUncertainSteps(options),
    })
    printState(state)
    if (state.status !== 'succeeded') process.exitCode = 1
    return
  }
  if (subcommand === 'resume') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    const options = argv.slice(2)
    const state = await orchestrator.resumeTask(taskId, {
      confirmationToken: option(options, '--confirm'),
      retryUncertain: retryUncertainSteps(options),
    })
    printState(state)
    if (state.status !== 'succeeded') process.exitCode = 1
    return
  }
  if (subcommand === 'status') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    printState(await orchestrator.store.load(taskId))
    return
  }
  if (subcommand === 'list') {
    const states = await orchestrator.store.list()
    console.log(JSON.stringify(states.map(taskSummary), null, 2))
    return
  }
  if (subcommand === 'cancel') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    printState(await orchestrator.cancelTask(taskId))
    return
  }
  if (subcommand === 'analyze') {
    const taskId = requireArg(argv[1] ?? '', 'task id')
    const state = await orchestrator.analyze(taskId)
    if (argv.includes('--json')) printState(state)
    else if (state.failure_analysis !== undefined) console.log(renderFailureAnalysis(state.failure_analysis))
    else throw new Error('task has no failure analysis')
    return
  }

  printAgentHelp()
}

async function planCommand(argv: string[], orchestrator: AgentOrchestrator): Promise<void> {
  const harPath = resolve(requireArg(argv[0] ?? '', 'HAR path'))
  const baseUrl = requireOption(argv, '--base-url')
  const goal = requireOption(argv, '--goal')
  const taskId = option(argv, '--task-id') ?? testTaskId('agent')
  const engine = parseEngine(option(argv, '--engine') ?? 'k6')
  const scope = option(argv, '--scope') ?? 'Only the explicitly supplied local test target is authorized.'
  const allowedOrigins = optionValues(argv, '--allowed-origin')
  if (allowedOrigins.length === 0) allowedOrigins.push(baseUrl)

  const plan = draftStructuredPlan({
    goal,
    taskId,
    harPath,
    baseUrl,
    authorizationScope: scope,
    engine,
    allowedOrigins,
  })
  const validation = orchestrator.validatePlan(plan)
  if (!validation.valid || validation.plan === undefined) {
    throw new Error(`generated plan is invalid: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  }
  const outputPath = resolve(option(argv, '--output') ?? join('.test-agent', 'plans', `${taskId}.json`))
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(validation.plan, null, 2)}\n`)
  console.log(JSON.stringify({
    model_status: 'unavailable',
    model_error: 'CLI plan generation is deterministic and does not load a Harness model; use the Harness plugin for model-driven planning.',
    plan_path: outputPath,
    plan_hash: planHash(validation.plan),
    risk_summary: summarizePlanRisk(validation.plan),
    plan: validation.plan,
  }, null, 2))
}

async function validateCommand(argv: string[], orchestrator: AgentOrchestrator): Promise<void> {
  const planPath = resolve(requireOption(argv, '--plan'))
  const raw = await readFile(planPath, 'utf8')
  const parsed = parsePlanJson(raw)
  const result = orchestrator.validatePlan(parsed)
  console.log(JSON.stringify({
    valid: result.valid,
    issues: result.issues,
    ...result.plan === undefined ? {} : { plan_hash: planHash(result.plan) },
  }, null, 2))
  if (!result.valid) process.exitCode = 1
}

async function createCommand(argv: string[], orchestrator: AgentOrchestrator): Promise<void> {
  const planPath = resolve(requireOption(argv, '--plan'))
  const plan = await readPlan(planPath, orchestrator)
  printState(await orchestrator.createTask(plan))
}

async function readPlan(path: string, orchestrator: AgentOrchestrator): Promise<TestPlan> {
  const raw = await readFile(path, 'utf8')
  const parsed = parsePlanJson(raw)
  const result = orchestrator.validatePlan(parsed)
  if (!result.valid || result.plan === undefined) {
    throw new Error(`test plan validation failed: ${result.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  }
  return result.plan
}

function parsePlanJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`invalid test plan JSON: ${(error as Error).message}`)
  }
}

function printState(state: AgentTaskState): void {
  console.log(JSON.stringify(state, null, 2))
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

function retryUncertainSteps(argv: string[]): string[] {
  return optionValues(argv, '--retry-uncertain')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0)
}

function parseEngine(value: string): 'k6' | 'jmeter' | 'none' {
  if (value === 'k6' || value === 'jmeter' || value === 'none') return value
  throw new Error('--engine must be k6, jmeter, or none')
}

function requireArg(value: string, name: string): string {
  if (value.length === 0) throw new Error(`missing required ${name}`)
  return value
}

function requireOption(argv: string[], name: string): string {
  const value = option(argv, name)
  if (value === undefined || value.length === 0) throw new Error(`missing required option ${name}`)
  return value
}

function option(argv: string[], name: string): string | undefined {
  const aliases = [name, `-${name.slice(2)}`]
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (aliases.includes(value)) {
      const next = argv[index + 1]
      return next !== undefined && !next.startsWith('-') ? next : undefined
    }
    const alias = aliases.find(item => value.startsWith(`${item}=`))
    if (alias !== undefined) return value.slice(alias.length + 1)
  }
  return undefined
}

function optionValues(argv: string[], name: string): string[] {
  const aliases = [name, `-${name.slice(2)}`]
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (aliases.includes(value)) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) values.push(next)
      continue
    }
    const alias = aliases.find(item => value.startsWith(`${item}=`))
    if (alias !== undefined) values.push(value.slice(alias.length + 1))
  }
  return values
}

function printAgentHelp(): void {
  console.log(`test-agent agent commands:
  test-agent agent plan <har-file> --base-url <url> --goal <text> [--task-id <id>] [--engine k6|jmeter|none] [--output <file>]
  test-agent agent validate --plan <plan-file>
  test-agent agent create --plan <plan-file>
  test-agent agent confirm <task-id> --token <token>
  test-agent agent execute <task-id> [--confirm <token>] [--retry-uncertain <step,...>]
  test-agent agent status <task-id>
  test-agent agent list
  test-agent agent resume <task-id> [--retry-uncertain <step,...>]
  test-agent agent cancel <task-id>
  test-agent agent analyze <task-id> [--json]`)
}
