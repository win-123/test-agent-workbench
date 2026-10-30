import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentOrchestrator } from '../../src/agent/orchestrator.ts'
import { draftStructuredPlan } from '../../src/agent/planner.ts'
import type { AgentTool, ToolCatalog } from '../../src/agent/tools.ts'
import type { ToolExecutionContext, ToolExecutionResult } from '../../src/agent/types.ts'

describe('agent task orchestration', () => {
  it('requires confirmation, records real tool calls, and blocks duplicate execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-orchestrator-'))
    const calls: string[] = []
    const orchestrator = new AgentOrchestrator({
      workingDirectory: root,
      toolCatalog: fakeCatalog(calls),
    })
    const plan = testPlan('unit-task-confirm')
    const task = await orchestrator.createTask(plan)

    await expect(orchestrator.executeTask(task.task_id)).rejects.toThrow('requires confirmation')
    const executed = await orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token })
    expect(executed.status).toBe('succeeded')
    expect(executed.steps.map(step => step.status)).toEqual(['completed', 'completed'])
    expect(executed.tool_calls.map(call => call.tool)).toEqual(['har.inspect', 'api.replay'])
    expect(calls).toEqual(['inspect', 'replay'])
    await expect(orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token }))
      .rejects.toThrow('already succeeded')
    await expect(orchestrator.createTask(plan)).rejects.toThrow('task already exists')

    const persisted = JSON.parse(await readFile(orchestrator.store.statePath(task.task_id), 'utf8')) as {
      run_ids: string[]
      tool_calls: Array<{ idempotency_key: string }>
    }
    expect(persisted.run_ids).toEqual(['run_fake_replay'])
    expect(persisted.tool_calls[1]?.idempotency_key).toContain(':api-replay')
  })

  it('cancels a running task and requires explicit retry for uncertain side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-orchestrator-'))
    let replayAttempts = 0
    const orchestrator = new AgentOrchestrator({
      workingDirectory: root,
      toolCatalog: fakeCatalog([], async (context) => {
        replayAttempts += 1
        if (replayAttempts === 1) {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
        }
        return replayResult()
      }, 5),
    })
    const task = await orchestrator.createTask(testPlan('unit-task-cancel'))
    const running = orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token })
    await waitFor(async () => (await orchestrator.store.load(task.task_id)).tool_calls.length === 2)
    await orchestrator.cancelTask(task.task_id)
    const cancelled = await running
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.steps[1]?.status).toBe('cancelled')

    const blocked = await orchestrator.resumeTask(task.task_id)
    expect(blocked.status).toBe('failed')
    expect(blocked.steps[1]?.status).toBe('needs_review')
    expect(blocked.error).toContain('--retry-uncertain api-replay')

    const resumed = await orchestrator.resumeTask(task.task_id, { retryUncertain: ['api-replay'] })
    expect(resumed.status).toBe('succeeded')
    expect(resumed.steps[0]?.status).toBe('completed')
    expect(replayAttempts).toBe(2)
  })

  it('preserves failed tool evidence and resumes from the first incomplete step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-orchestrator-'))
    const calls: string[] = []
    let fail = true
    const orchestrator = new AgentOrchestrator({
      workingDirectory: root,
      toolCatalog: fakeCatalog(calls, async () => {
        if (fail) {
          fail = false
          throw new Error('fixture 500 from controlled tool')
        }
        return replayResult()
      }),
    })
    const task = await orchestrator.createTask(testPlan('unit-task-recover'))
    const failed = await orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token })
    expect(failed.status).toBe('failed')
    expect(failed.tool_calls[1]?.status).toBe('failed')
    expect(failed.tool_calls[1]?.error).toContain('controlled tool')
    expect(failed.failure_analysis?.facts.join(' ')).toContain('controlled tool')

    const resumed = await orchestrator.resumeTask(task.task_id, { retryUncertain: ['api-replay'] })
    expect(resumed.status).toBe('succeeded')
    expect(calls).toEqual(['inspect', 'replay', 'replay'])
  })

  it('rejects invalid tool arguments before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-orchestrator-'))
    const orchestrator = new AgentOrchestrator({ workingDirectory: root })
    const plan = testPlan('unit-task-invalid-args')
    plan.steps[0]!.arguments = { path: '' }
    const validation = orchestrator.validatePlan(plan)
    expect(validation.valid).toBe(false)
    expect(validation.issues.map(item => item.code)).toContain('missing_string')
  })

  it('reads a report by run id from the task artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-orchestrator-'))
    const orchestrator = new AgentOrchestrator({ workingDirectory: root })
    const template = testPlan('unit-task-report-read')
    const plan = {
      ...template,
      steps: [{
        id: 'read-report',
        title: 'Read the saved report',
        tool: 'report.read' as const,
        arguments: { run_id: 'artifact_report_1' },
        test_data_refs: ['primary-har'],
        assertions: [],
        depends_on: [],
        risk: {
          level: 'low' as const,
          side_effects: false,
          requires_confirmation: false,
          reasons: ['Reads an existing report from the task artifact directory.'],
        },
        acceptance_criteria: ['The persisted report is returned without modification.'],
      }],
    }
    const task = await orchestrator.createTask(plan)
    const artifactDir = orchestrator.store.artifactDir(task.task_id)
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'artifact_report_1.report.json'), JSON.stringify({
      run_id: 'artifact_report_1',
      total: 1,
      passed: 0,
      failed: 1,
      requests: [{ method: 'GET', path: '/api/fail', status: 500, passed: false }],
    }))
    const executed = await orchestrator.executeTask(task.task_id, { confirmationToken: task.confirmation.token })
    expect(executed.status).toBe('succeeded')
    expect(executed.tool_calls[0]?.result_summary).toMatchObject({
      report_path: join(artifactDir, 'artifact_report_1.report.json'),
    })
    expect(executed.failure_analysis?.facts.join(' ')).toContain('GET /api/fail returned HTTP 500')
  })
})

function testPlan(taskId: string) {
  return draftStructuredPlan({
    goal: 'Exercise the controlled orchestration path',
    taskId,
    harPath: resolve('samples/demo.har'),
    baseUrl: 'http://127.0.0.1:8089',
    authorizationScope: 'Local fixture only',
    engine: 'none',
  })
}

function fakeCatalog(
  calls: string[],
  replay: (context: ToolExecutionContext) => Promise<ToolExecutionResult> = async () => replayResult(),
  delayMs = 0,
): ToolCatalog {
  const tools: AgentTool[] = [
    {
      name: 'har.inspect',
      description: 'fake inspect',
      sideEffects: false,
      validate: () => [],
      async execute() {
        calls.push('inspect')
        if (delayMs > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs))
        return {
          summary: { total: 3 },
          result: { total: 3 },
          artifacts: [],
          runIds: [],
          testFailure: false,
        }
      },
    },
    {
      name: 'api.replay',
      description: 'fake replay',
      sideEffects: true,
      validate: () => [],
      async execute(context) {
        calls.push('replay')
        return await replay(context)
      },
    },
  ]
  return {
    list: () => tools,
    get: name => tools.find(tool => tool.name === name),
    async execute(context) {
      const tool = tools.find(item => item.name === context.step.tool)
      if (tool === undefined) throw new Error(`tool is not allowlisted: ${context.step.tool}`)
      return await tool.execute(context)
    },
  }
}

function replayResult(): ToolExecutionResult {
  return {
    summary: { run_id: 'run_fake_replay', total: 3, passed: 2, failed: 1 },
    result: {
      run_id: 'run_fake_replay',
      total: 3,
      passed: 2,
      failed: 1,
      requests: [],
    },
    artifacts: [],
    runIds: ['run_fake_replay'],
    testFailure: true,
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error('condition was not met before timeout')
}
