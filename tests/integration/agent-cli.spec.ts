import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const node = process.execPath
const cli = ['--experimental-strip-types', 'src/cli/bin.ts']

describe('agent CLI without AI', () => {
  it('creates, validates, and persists a deterministic structured plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-agent-cli-agent-'))
    const planPath = join(dir, 'plan.json')
    const { stdout } = await execFileAsync(node, [
      ...cli,
      'agent',
      'plan',
      'samples/demo.har',
      '--base-url',
      'http://127.0.0.1:8089',
      '--goal',
      'Verify deterministic planning without AI',
      '--task-id',
      'unit-cli-agent-plan',
      '--engine',
      'none',
      '--output',
      planPath,
    ])
    const output = JSON.parse(stdout) as {
      model_status: string
      plan: { schema_version: string; steps: unknown[] }
    }
    expect(output.model_status).toBe('unavailable')
    expect(output.plan.schema_version).toBe('test-agent.plan/v1')
    expect(output.plan.steps).toHaveLength(2)
    const persisted = JSON.parse(await readFile(planPath, 'utf8')) as { task_id: string }
    expect(persisted.task_id).toBe('unit-cli-agent-plan')

    const validated = await execFileAsync(node, [...cli, 'agent', 'validate', '--plan', planPath])
    expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, issues: [] })
  })
})
