import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupStaleTemporaryFiles } from '../../src/desktop/temp-cleanup.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'

describe('temporary file cleanup and report-write failure', () => {
  it('removes only stale atomic temporary files inside .test-agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-temp-cleanup-'))
    const tasks = join(root, '.test-agent', 'tasks', 'example')
    await mkdir(tasks, { recursive: true })
    const staleState = join(tasks, '.state.123.456.tmp')
    const staleJson = join(tasks, 'state.json.123.456.tmp')
    const freshJson = join(tasks, 'state.json.999.999.tmp')
    const userFile = join(tasks, 'user-input.tmp')
    const note = join(tasks, 'note.txt')
    for (const path of [staleState, staleJson, freshJson, userFile, note]) await writeFile(path, 'temporary\n')
    const old = new Date(Date.now() - 6 * 60 * 1000)
    for (const path of [staleState, staleJson, userFile]) await utimes(path, old, old)

    const result = await cleanupStaleTemporaryFiles(root)
    expect(result.removed.sort()).toEqual([staleJson, staleState].sort())
    expect(result.retained).toEqual([freshJson])
    await expect(stat(staleState)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(staleJson)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(freshJson)).isFile()).toBe(true)
    expect((await stat(userFile)).isFile()).toBe(true)
    expect((await stat(note)).isFile()).toBe(true)
  })

  it('cleans stale files when reopening a project and preserves real task state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-reopen-cleanup-'))
    const projects = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await projects.initialize()
    const project = await projects.create('Reopen cleanup', root)
    const taskDir = join(project.path, '.test-agent', 'tasks', 'task_example')
    const statePath = join(taskDir, 'state.json')
    const stalePath = join(taskDir, 'state.json.1.2.tmp')
    await mkdir(taskDir, { recursive: true })
    await writeFile(statePath, '{"task_id":"task_example"}\n')
    await writeFile(stalePath, 'stale\n')
    const old = new Date(Date.now() - 6 * 60 * 1000)
    await utimes(stalePath, old, old)

    await projects.open(project.path)
    await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(statePath, 'utf8')).resolves.toContain('task_example')
  })

  it('preserves a failed task record when report writing cannot create output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-report-write-'))
    const projects = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await projects.initialize()
    await projects.create('Report failure', root)
    await projects.importHar('samples/demo.har')
    await projects.saveConfig({
      target: { baseUrl: 'http://127.0.0.1:8089', allowedOrigins: ['http://127.0.0.1:8089'], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 200, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 1000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'local write-failure fixture only' },
    })
    await chmod(join(projects.root!, 'output'), 0o500)
    const tasks = new TaskService({ projects, gate: new ProjectRunGate() })
    const started = await tasks.startReplay()
    const snapshot = await tasks.waitForTask(started.task_id)
    expect(snapshot.task.status).toBe('failed')
    expect(snapshot.task.error).toMatch(/output|EACCES/i)
    expect(snapshot.task.finished_at).toBeDefined()
  })
})
