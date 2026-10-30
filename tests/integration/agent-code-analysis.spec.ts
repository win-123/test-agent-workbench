import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTask } from '../../src/agent/analyzer.ts'
import { AgentOrchestrator } from '../../src/agent/orchestrator.ts'
import { planHash } from '../../src/agent/plan.ts'
import { draftCodeAnalysisPlan, testTaskId } from '../../src/agent/planner.ts'

describe('Agent Java analysis tool', () => {
  it('records a deterministic tool call and explains evidence without claiming runtime coverage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-agent-code-'))
    const orchestrator = new AgentOrchestrator({
      workingDirectory: directory,
      stateRoot: join(directory, '.test-agent'),
      outputDir: join(directory, 'output'),
      allowedInputRoots: [join(process.cwd(), 'fixtures', 'java-project')],
    })
    const plan = draftCodeAnalysisPlan({
      goal: '分析订单接口的分支与动态调用风险',
      taskId: testTaskId('agent'),
      javaPath: join(process.cwd(), 'fixtures', 'java-project'),
      baseUrl: 'http://127.0.0.1:18090',
      authorizationScope: 'local source analysis only',
      allowedOrigins: ['http://127.0.0.1:18090'],
    })
    const validation = orchestrator.validatePlan(plan)
    expect(validation.valid).toBe(true)
    expect(planHash(plan)).toHaveLength(64)
    const created = await orchestrator.createTask(plan)
    const confirmed = await orchestrator.confirmTask(created.task_id, created.confirmation.token)
    const executed = await orchestrator.executeTask(created.task_id, {
      confirmationToken: confirmed.confirmation.token,
    })
    expect(executed.status).toBe('succeeded')
    expect(executed.tool_calls).toHaveLength(1)
    expect(executed.tool_calls[0]).toMatchObject({
      tool: 'code.analyze.java',
      status: 'succeeded',
      side_effects: false,
    })
    expect(executed.tool_calls[0]?.artifacts?.[0]).toContain('.java-analysis.json')
    const analysis = analyzeTask(executed)
    expect(analysis.facts).toContainEqual(expect.stringContaining('2 endpoint declaration(s)'))
    expect(analysis.facts).toContainEqual(expect.stringContaining('No runtime coverage was attached'))
    expect(analysis.hypotheses).toContainEqual(expect.objectContaining({
      statement: expect.stringContaining('unreachable in production'),
    }))
  })

  it('rejects a code analysis input outside authorized roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-agent-outside-'))
    const orchestrator = new AgentOrchestrator({
      workingDirectory: directory,
      stateRoot: join(directory, '.test-agent'),
      outputDir: join(directory, 'output'),
    })
    const plan = draftCodeAnalysisPlan({
      goal: '读取未授权路径',
      taskId: testTaskId('agent'),
      javaPath: join(process.cwd(), 'fixtures', 'java-project'),
      baseUrl: 'http://127.0.0.1:18090',
      authorizationScope: 'local source analysis only',
      allowedOrigins: ['http://127.0.0.1:18090'],
    })
    const created = await orchestrator.createTask(plan)
    const confirmed = await orchestrator.confirmTask(created.task_id, created.confirmation.token)
    const failed = await orchestrator.executeTask(created.task_id, { confirmationToken: confirmed.confirmation.token })
    expect(failed.status).toBe('failed')
    expect(failed.tool_calls[0]?.error).toContain('outside authorized input roots')
  })
})
