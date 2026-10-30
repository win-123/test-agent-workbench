import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ParsedHar } from '../../src/har/types.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const available = await canBindLocalFixture()
let server: Server | undefined
let origin = ''

beforeAll(async () => {
  if (!available) return
  server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200).end('{}')
    }, 2000)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describe.skipIf(!available)('desktop API task lifecycle', () => {
  it('records cancellation and timeout as distinct terminal states', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-task-lifecycle-'))
    const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
    await projects.initialize()
    await projects.create('Lifecycle', directory)
    await projects.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 100, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 1000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'local lifecycle fixture only' },
    })
    const tasks = new TaskService({ projects, gate: new ProjectRunGate() })

    const cancelled = await tasks.startApiSelection(har(), 'cancel case')
    await waitForStatus(tasks, cancelled.task_id, 'running')
    const cancelledSnapshot = await tasks.cancelTask(cancelled.task_id)
    expect(cancelledSnapshot.task.status).toBe('cancelled')
    expect(cancelledSnapshot.task.finished_at).toBeDefined()

    const timedOut = await tasks.startApiSelection(har(), 'timeout case')
    const timeoutSnapshot = await tasks.waitForTask(timedOut.task_id)
    expect(timeoutSnapshot.task.status).toBe('timeout')
    expect(JSON.stringify(timeoutSnapshot.report)).toContain('"timeout"')
  })
})

function har(): ParsedHar {
  return {
    entries: [{
      order: 0,
      method: 'GET',
      url: `${origin}/slow`,
      origin,
      path: '/slow',
      query: [],
      headers: [],
    }],
  }
}

async function waitForStatus(tasks: TaskService, taskId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await tasks.getTask(taskId)).task.status === status) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`task did not reach ${status}`)
}
