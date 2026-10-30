import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { AgentService } from '../../src/desktop/agent-service.ts'
import { DESKTOP_TASK_SCHEMA_VERSION } from '../../src/desktop/types.ts'
import { fakeEngine, validConfig } from './helpers.ts'

describe('desktop task service', () => {
  it('executes a real local engine process and stores report evidence', async () => {
    const { projects, tasks } = await setup('pass')
    const record = await tasks.startPerformance('k6')
    expect(record.status).toBe('queued')
    const finished = await waitFor(async () => {
      const snapshot = await tasks.getTask(record.task_id)
      return terminal(snapshot.task.status) ? snapshot : undefined
    })
    expect(finished.task.status).toBe('test_failed')
    expect(finished.task.run_id).toMatch(/^engine_/)
    expect(finished.report).toMatchObject({
      metrics: {
        total: 2,
        passed: 1,
        failed: 1,
        p90_response_ms: 8,
        p95_response_ms: 9,
        p99_response_ms: 10,
      },
    })
    expect((await tasks.taskLogs(record.task_id)).map(log => log.path)).toEqual(expect.arrayContaining([
      expect.stringContaining('task.log'),
      expect.stringContaining('stdout.log'),
      expect.stringContaining('stderr.log'),
    ]))
    expect(await tasks.listTasks()).toHaveLength(1)
    expect(projects.currentConfig().project_id).toBe(record.project_id)
  })

  it('prevents duplicate execution, cancels the child, and records cancellation', async () => {
    const { tasks } = await setup('slow')
    const record = await tasks.startPerformance('k6')
    await expect(tasks.startPerformance('k6')).rejects.toThrow('already has a running task')
    await waitFor(async () => (await tasks.getTask(record.task_id)).task.status === 'running')
    const cancelled = await tasks.cancelTask(record.task_id)
    expect(cancelled.task.status).toBe('cancelled')
    expect(cancelled.task.finished_at).toBeDefined()
  })

  it('marks an orphaned running record as interrupted on recovery', async () => {
    const { projects, tasks } = await setup('pass')
    const taskId = 'task_recovery_case'
    const directory = join(projects.root!, '.test-agent', 'desktop-tasks', taskId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      schema_version: DESKTOP_TASK_SCHEMA_VERSION,
      task_id: taskId,
      project_id: projects.currentConfig().project_id,
      kind: 'performance',
      title: 'orphan',
      status: 'running',
      created_at: new Date().toISOString(),
      log_path: `.test-agent/desktop-tasks/${taskId}/task.log`,
    }))
    const recovered = await tasks.getTask(taskId)
    expect(recovered.task.status).toBe('interrupted')
    expect(recovered.task.error).toContain('disappeared')
  })

  it('replays only selected request orders while preserving original assertion indexes', async () => {
    const { projects, tasks } = await setup('pass')
    await expect(tasks.startReplay({ requestOrders: [] })).rejects.toThrow('select at least one request')
    await expect(tasks.startReplay({ requestOrders: [99] })).rejects.toThrow('request order is invalid')

    const fetchMock = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const base = validConfig('http://127.0.0.1:18089')
      await projects.saveConfig({
        ...base,
        api: { ...base.api, assertions: [{ index: 1, status: 201 }] },
      })
      const record = await tasks.startReplay({ requestOrders: [1] })
      expect(record.title).toContain('1/3 selected requests')
      const finished = await tasks.waitForTask(record.task_id)
      expect(finished.task.status).toBe('test_failed')
      const report = finished.report
      if (report === undefined || !('requests' in report)) throw new Error('API replay report is missing')
      expect(report).toMatchObject({
        total: 1,
        failed: 1,
        requests: [{ method: 'POST', path: '/api/echo', status: 200 }],
      })
      expect(report.requests[0]?.assertions[0]).toMatchObject({
        name: 'status equals',
        passed: false,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('generates the deterministic Agent plan and requires explicit confirmation', async () => {
    const { projects, gate } = await setup('pass')
    const agents = new AgentService({ projects, gate })
    const preview = await agents.previewPlan('验证 API 回放与负载测试', 'k6')
    expect(preview.modelStatus).toBe('unavailable')
    expect(preview.validation.valid).toBe(true)
    expect(preview.plan.steps.map(step => step.tool)).toEqual(['har.inspect', 'api.replay', 'engine.run.k6'])
    await expect(agents.start({ plan: preview.plan, planHash: preview.planHash, confirmed: false }))
      .rejects.toThrow('explicit confirmation')
    await expect(agents.start({ plan: preview.plan, planHash: 'tampered', confirmed: true }))
      .rejects.toThrow('plan content changed')
  })
})

async function setup(engineMode: 'pass' | 'slow') {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-desktop-task-'))
  const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
  await projects.initialize()
  await projects.create('Task fixture', directory)
  await projects.importHar('samples/demo.har')
  const base = validConfig('http://127.0.0.1:18089')
  const executable = await fakeEngine(directory, engineMode)
  await projects.saveConfig({
    ...base,
    performance: {
      ...base.performance,
      enginePaths: { k6: executable },
    },
  })
  const gate = new ProjectRunGate()
  const tasks = new TaskService({ projects, gate })
  return { directory, projects, tasks, gate }
}

async function waitFor<T>(predicate: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('condition was not met before timeout')
}

function terminal(status: string): boolean {
  return ['passed', 'test_failed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(status)
}
