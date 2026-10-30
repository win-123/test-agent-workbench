import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../../src/desktop/task-service.ts'
import { UiCaseService } from '../../src/ui/service.ts'
import { validCase } from '../helpers/ui-case.ts'

describe('UI case asset service', () => {
  it('saves immutable versions and rejects stale edits', async () => {
    const { ui } = await setup()
    const first = await ui.save(validCase())
    expect(first.version).toBe(1)
    const edited = validCase({
      version: 2,
      name: 'UI validation edited',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
    const second = await ui.save(edited, 1)
    expect(second.version).toBe(2)
    expect((await ui.get('ui-validation')).name).toBe('UI validation edited')
    expect((await ui.get('ui-validation', 1)).name).toBe('UI validation')
    await expect(ui.save(validCase({ version: 2 }), 1)).rejects.toThrow('changed')
    expect(await ui.list()).toEqual([expect.objectContaining({ case_id: 'ui-validation', version: 2 })])
  })

  it('imports a recording into a versioned case asset', async () => {
    const { ui } = await setup()
    const summary = await ui.importRecording({
      name: 'Imported actions',
      target_url: 'http://127.0.0.1:8090/',
      actions: [
        { type: 'navigate', url: 'http://127.0.0.1:8090/' },
        { type: 'click', locator: { kind: 'role', role: 'button', name: 'Open workspace', value: 'Open workspace' } },
      ],
    }, 'imported-case')
    expect(summary.step_count).toBe(2)
    expect((await ui.get('imported-case')).case_id).toBe('imported-case')
  })

  it('rejects UI execution when the project has not authorized the origin', async () => {
    const { ui } = await setup(false)
    await ui.save(validCase())
    await expect(ui.execute('ui-validation')).rejects.toThrow('confirm the authorized test scope')
  })
})

async function setup(authorized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'test-agent-ui-case-'))
  const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
  await projects.initialize()
  await projects.create('UI fixture', directory)
  await projects.saveConfig({
    target: {
      baseUrl: 'http://127.0.0.1:8090',
      allowedOrigins: ['http://127.0.0.1:8090'],
      allowedPaths: [],
    },
    environment: { headers: {} },
    api: { timeoutMs: 5000, concurrency: 1, assertions: [] },
    performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
    correlations: [],
    authorization: { confirmed: authorized, scope: 'local UI fixture' },
  })
  const gate = new ProjectRunGate()
  const tasks = new TaskService({ projects, gate })
  return { directory, projects, ui: new UiCaseService({ projects, tasks, gate }) }
}
