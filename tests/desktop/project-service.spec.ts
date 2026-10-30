import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { validConfig } from './helpers.ts'

describe('desktop project service', () => {
  it('creates, reopens, imports and sanitizes a HAR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-desktop-project-'))
    const service = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await service.initialize()
    const project = await service.create('Local Fixture', root)
    expect(project.config.name).toBe('Local Fixture')
    expect(project.requests).toEqual([])

    const imported = await service.importHar('samples/demo.har')
    expect(imported.harFileName).toMatch(/\.har$/)
    expect(imported.requests).toHaveLength(3)
    expect(imported.requests[0]?.headers.find(header => header.name === 'Authorization')?.value).toBe('[REDACTED]')
    expect(imported.requests[0]?.url).not.toContain('production-secret')

    const stored = await readFile(join(imported.path, imported.config.har_file!), 'utf8')
    expect(stored).not.toContain('production-secret')
    expect(stored).not.toContain('"password":"secret"')
    expect(stored).toContain('[REDACTED]')

    const reopened = await new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await reopened.initialize()
    const reopenedProject = await reopened.open(imported.path)
    expect(reopenedProject.config.project_id).toBe(project.config.project_id)
    expect(reopenedProject.requests).toHaveLength(3)
    expect((await reopened.recentProjects())[0]?.path).toBe(imported.path)
  })

  it('validates unsafe paths, credentials and sensitive headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-desktop-project-'))
    const service = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await service.initialize()
    const project = await service.create('Validation', root)
    const base = validConfig('http://127.0.0.1:8089')
    await expect(service.saveConfig({
      ...base,
      target: { ...base.target, baseUrl: 'http://user:password@127.0.0.1:8089', allowedOrigins: ['http://127.0.0.1:8089'] },
    })).rejects.toThrow('must not contain credentials')
    await expect(service.saveConfig({
      ...base,
      environment: { headers: { Authorization: 'Bearer should-not-persist' } },
    })).rejects.toThrow('cannot be persisted')
    await expect(service.saveConfig({
      ...base,
      target: { ...base.target, allowedOrigins: [] },
    })).rejects.toThrow('must include the target origin')
    expect(project.path).toContain('validation')
  })

  it('refuses invalid HAR content without overwriting the active import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-desktop-project-'))
    const service = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await service.initialize()
    await service.create('HAR validation', root)
    const invalid = join(root, 'invalid.har')
    await writeFile(invalid, '{"log":{"entries":[]}}')
    await expect(service.importHar(invalid)).rejects.toThrow('empty')
    expect((await service.snapshotCurrent()).config.har_file).toBeUndefined()
  })

  it('explains when an opened directory is not a Test Agent project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-invalid-project-'))
    const service = new ProjectService({ appDataDirectory: join(root, 'app-data') })
    await service.initialize()
    await expect(service.open(root)).rejects.toThrow('does not contain project.json')
  })
})
