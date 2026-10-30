import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  draftStructuredPlan,
  enrichAnalysisWithModel,
  generatePlanWithModel,
  PlanGenerationError,
} from '../../src/agent/planner.ts'
import { validateTestPlan } from '../../src/agent/plan.ts'
import { analyzeTask } from '../../src/agent/analyzer.ts'
import type { TestPlan } from '../../src/agent/types.ts'

const harPath = resolve('samples/demo.har')

describe('structured test plans', () => {
  it('accepts a generated plan with side-effect confirmation', () => {
    const plan = draftStructuredPlan({
      goal: 'Replay the demo HAR safely',
      taskId: 'unit-plan-valid',
      harPath,
      baseUrl: 'http://127.0.0.1:8089',
      authorizationScope: 'Local fixture only',
      engine: 'none',
    })
    const result = validateTestPlan(plan)
    expect(result.valid).toBe(true)
    expect(result.plan?.steps.map(step => step.tool)).toEqual(['har.inspect', 'api.replay'])
    expect(result.plan?.steps[1]?.risk.requires_confirmation).toBe(true)
  })

  it('rejects shell tools and undeclared tool arguments', () => {
    const plan = basePlan()
    ;(plan.steps[1] as unknown as { tool: string }).tool = 'shell.run'
    let result = validateTestPlan(plan)
    expect(result.valid).toBe(false)
    expect(result.issues.map(item => item.code)).toContain('unknown_tool')

    const withCommand = basePlan()
    withCommand.steps[1]!.arguments['command'] = 'rm -rf /tmp/example'
    result = validateTestPlan(withCommand)
    expect(result.valid).toBe(false)
    expect(result.issues.map(item => item.code)).toContain('unknown_tool_argument')
  })

  it('redacts sensitive goal/scope text and rejects credential-bearing target URLs', () => {
    const plan = draftStructuredPlan({
      goal: 'Use token=super-secret-value safely',
      taskId: 'unit-plan-redaction',
      harPath,
      baseUrl: 'http://127.0.0.1:8089',
      authorizationScope: 'password=hunter2 scope',
      engine: 'none',
    })
    expect(plan.goal).not.toContain('super-secret-value')
    expect(plan.goal).toContain('[REDACTED]')
    expect(plan.authorization.scope).not.toContain('hunter2')

    const query = basePlan()
    query.target.base_url = 'http://127.0.0.1:8089/?token=secret'
    expect(validateTestPlan(query).issues.map(item => item.code)).toContain('base_url_query')
  })

  it('rejects missing authorization and unsafe dependency references', () => {
    const unauthorized = basePlan()
    unauthorized.authorization.confirmed = false
    expect(validateTestPlan(unauthorized).issues.map(item => item.code)).toContain('authorization_not_confirmed')

    const dependency = basePlan()
    dependency.request_dependencies = [{ from: -1, to: 20, kind: 'token', description: 'HAR request dependency' }]
    expect(validateTestPlan(dependency).issues.map(item => item.code)).toContain('invalid_request_dependency_index')

    dependency.request_dependencies = [{ from: 0, to: 20, kind: 'token', description: 'HAR request dependency' }]
    expect(validateTestPlan(dependency).valid).toBe(true)
  })
})

describe('model planning boundaries', () => {
  it('accepts a valid model plan while retaining server-owned target and authorization fields', async () => {
    const draft = basePlan()
    const plan = await generatePlanWithModel({
      goal: 'Model-generated replay plan',
      taskId: 'unit-model-valid',
      harPath,
      baseUrl: 'http://127.0.0.1:8089',
      authorizationScope: 'Local fixture only',
      engine: 'none',
    }, {
      complete: async () => JSON.stringify({
        goal: 'Model-generated replay plan',
        steps: draft.steps,
        request_dependencies: [],
      }),
    })
    expect(plan.task_id).toBe('unit-model-valid')
    expect(plan.target.base_url).toBe('http://127.0.0.1:8089')
    expect(plan.authorization.scope).toBe('Local fixture only')
    expect(plan.steps.map(step => step.tool)).toEqual(['har.inspect', 'api.replay'])
  })

  it('reports model unavailable without inventing a plan', async () => {
    await expect(generatePlanWithModel({
      goal: 'test',
      taskId: 'unit-model-unavailable',
      harPath,
      baseUrl: 'http://127.0.0.1:8089',
      authorizationScope: 'local',
    }, undefined)).rejects.toMatchObject({ code: 'model_unavailable' })
  })

  it('rejects invalid model JSON', async () => {
    const error = await generatePlanWithModel({
      goal: 'test',
      taskId: 'unit-model-invalid',
      harPath,
      baseUrl: 'http://127.0.0.1:8089',
      authorizationScope: 'local',
    }, {
      complete: async () => 'this is not JSON',
    }).catch(value => value)
    expect(error).toBeInstanceOf(PlanGenerationError)
    expect(error.code).toBe('invalid_model_output')
  })

  it('keeps deterministic analysis when model enrichment is unavailable', async () => {
    const plan = basePlan()
    const analysis = analyzeTask({
      schema_version: 'test-agent.task/v1',
      task_id: plan.task_id,
      plan_hash: 'unused',
      plan,
      status: 'succeeded',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      confirmation: { required: true, token: 'hidden', confirmed_at: new Date(0).toISOString() },
      steps: plan.steps.map(step => ({ step_id: step.id, title: step.title, status: 'completed' as const })),
      tool_calls: [],
      run_ids: [],
    })
    const enriched = await enrichAnalysisWithModel(analysis, undefined)
    expect(enriched.model_status).toBe('unavailable')
    expect(enriched.facts.length).toBeGreaterThan(0)
  })

  it('adds evidence-linked model hypotheses without replacing deterministic facts', async () => {
    const plan = basePlan()
    const analysis = analyzeTask({
      schema_version: 'test-agent.task/v1',
      task_id: plan.task_id,
      plan_hash: 'unused',
      plan,
      status: 'succeeded',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      confirmation: { required: true, token: 'hidden', confirmed_at: new Date(0).toISOString() },
      steps: plan.steps.map(step => ({ step_id: step.id, title: step.title, status: 'completed' as const })),
      tool_calls: [],
      run_ids: [],
    })
    const enriched = await enrichAnalysisWithModel(analysis, {
      complete: async () => JSON.stringify({
        inferences: [{ statement: 'No failed tool calls were recorded.', evidence: 'Tool-call count is zero.' }],
        hypotheses: [{ statement: 'A missing report may hide a test failure.', verification: 'Attach and read the expected run report.' }],
        recommendations: ['Read the recorded artifacts.'],
      }),
    })
    expect(enriched.model_status).toBe('available')
    expect(enriched.facts).toEqual(analysis.facts)
    expect(enriched.hypotheses.some(item => item.statement.includes('missing report'))).toBe(true)
  })
})

function basePlan(): TestPlan {
  return structuredClone(draftStructuredPlan({
    goal: 'Replay the demo HAR safely',
    taskId: 'unit-plan-base',
    harPath,
    baseUrl: 'http://127.0.0.1:8089',
    authorizationScope: 'Local fixture only',
    engine: 'none',
  }))
}
