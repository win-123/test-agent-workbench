import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentService } from '../../src/desktop/agent-service.ts'
import { AgentOrchestrator } from '../../src/agent/orchestrator.ts'
import { draftCodeAnalysisPlan, draftStructuredPlan, type ModelTextClient } from '../../src/agent/planner.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate } from '../../src/desktop/task-service.ts'

describe('desktop Agent model planning', () => {
  it('uses a validated model plan and falls back deterministically on invalid model output', async () => {
    const { projects, gate } = await setup()
    const validModel: ModelTextClient = {
      complete: async () => JSON.stringify({
        ...basePlan(),
        goal: 'Model-generated goal',
      }),
    }
    const available = new AgentService({ projects, gate, model: validModel })
    const preview = await available.previewPlan('验证本地 API', 'none')
    expect(preview.modelStatus).toBe('available')
    expect(preview.planSource).toBe('model')
    expect(preview.plan.goal).toBe('Model-generated goal')
    expect(preview.validation.valid).toBe(true)
    await expect(available.start({ plan: preview.plan, planHash: preview.planHash, confirmed: false }))
      .rejects.toThrow('explicit confirmation')

    const invalidModel: ModelTextClient = { complete: async () => '{invalid json' }
    const fallback = await new AgentService({ projects, gate, model: invalidModel }).previewPlan('验证本地 API', 'none')
    expect(fallback.modelStatus).toBe('unavailable')
    expect(fallback.planSource).toBe('deterministic')
    expect(fallback.modelError).toContain('model did not return valid JSON')

    const noModel = await new AgentService({ projects, gate }).previewPlan('验证本地 API', 'none')
    expect(noModel.modelStatus).toBe('unavailable')
    expect(noModel.planSource).toBe('deterministic')
  })
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-model-plan-'))
  const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
  await projects.initialize()
  await projects.create('Model plan', directory)
  await projects.importHar('samples/demo.har')
  await projects.saveConfig({
    target: { baseUrl: 'http://127.0.0.1:18089', allowedOrigins: ['http://127.0.0.1:18089'], allowedPaths: [] },
    environment: { headers: {} },
    api: { timeoutMs: 1000, concurrency: 1, assertions: [] },
    performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
    correlations: [],
    authorization: { confirmed: true, scope: 'local fixture only' },
  })
  return { projects, gate: new ProjectRunGate() }
}

function basePlan() {
  return draftStructuredPlan({
    goal: 'deterministic goal',
    taskId: 'agent_model_valid',
    harPath: 'samples/demo.har',
    baseUrl: 'http://127.0.0.1:18089',
    authorizationScope: 'local fixture only',
    engine: 'none',
    allowedOrigins: ['http://127.0.0.1:18089'],
  })
}

describe('desktop Agent model failure analysis', () => {
  it('enriches deterministic report analysis after real tool execution', async () => {
    const { projects, gate } = await setup()
    const calls: string[] = []
    const model: ModelTextClient = {
      complete: async ({ prompt }) => {
        calls.push(prompt)
        if (calls.length === 1) return JSON.stringify({ ...basePlan(), goal: 'Model-generated goal' })
        return JSON.stringify({
          inferences: [{ statement: 'Model inference tied to report facts', evidence: 'tool call succeeded' }],
          hypotheses: [],
          recommendations: ['Verify the failing request with an authorized target log'],
        })
      },
    }
    const agents = new AgentService({ projects, gate, model })
    const preview = await agents.previewPlan('验证本地 API', 'none')
    await expect(agents.start({ plan: preview.plan, planHash: preview.planHash, confirmed: false })).rejects.toThrow('explicit confirmation')

    const orchestrator = new AgentOrchestrator({
      workingDirectory: projects.root!,
      stateRoot: join(projects.root!, '.test-agent'),
      outputDir: join(projects.root!, 'output'),
    })
    const codePlan = draftCodeAnalysisPlan({
      goal: '分析 Java 分支证据',
      taskId: 'agent_model_analysis',
      javaPath: join(process.cwd(), 'fixtures', 'java-project'),
      baseUrl: 'http://127.0.0.1:18089',
      authorizationScope: 'local fixture only',
      allowedOrigins: ['http://127.0.0.1:18089'],
    })
    const task = await orchestrator.createTask(codePlan)
    await orchestrator.confirmTask(task.task_id, task.confirmation.token)
    await orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token })
    const analyzed = await agents.analyze(task.task_id)
    expect(analyzed.analysis?.model_status).toBe('available')
    expect(analyzed.analysis?.inferences).toContainEqual(expect.objectContaining({ statement: 'Model inference tied to report facts' }))
    expect(calls).toHaveLength(2)
  })
})
