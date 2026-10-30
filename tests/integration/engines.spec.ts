import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runEngine } from '../../src/engines/executor.ts'

describe('engine executor', () => {
  it('reports a missing executable', async () => {
    await expect(runEngine({
      kind: 'k6',
      scriptPath: 'unused.js',
      timeoutMs: 100,
      outputDirectory: await mkdtemp(join(tmpdir(), 'test-agent-')),
      runId: 'missing',
      executable: join(tmpdir(), 'definitely-not-test-agent-k6'),
    })).rejects.toThrow('engine is not installed')
  })

  it('reports timeout with exit signal while preserving output paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-agent-'))
    const executable = join(dir, 'slow-k6')
    await writeFile(executable, '#!/bin/sh\nsleep 30\n')
    await chmod(executable, 0o755)
    const execution = await runEngine({
      kind: 'k6', scriptPath: 'script.js', timeoutMs: 50,
      outputDirectory: dir, runId: 'timeout', executable,
    })
    expect(execution.timedOut).toBe(true)
    expect(execution.signal).toBe('SIGKILL')
    expect(execution.status).toBe('timeout')
    expect(execution.version).toBeNull()
  })

  it('distinguishes an invalid k6 script from an engine error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-agent-'))
    const invalid = await fakeK6(dir, 'invalid', 'k6 found an unexpected token')
    const engineError = await fakeK6(dir, 'engine-error', 'engine boot failed\n')
    await mkdir(join(dir, 'invalid-result'), { recursive: true })
    const result = join(dir, 'invalid-result', 'result.json')
    await writeFile(result, '{}\n')
    const request = {
      kind: 'k6' as const,
      scriptPath: 'script.js',
      timeoutMs: 1000,
      outputDirectory: join(dir, 'invalid-result'),
      runId: 'run',
    }
    expect((await runEngine({ ...request, executable: invalid })).status).toBe('invalid_script')
    expect((await runEngine({ ...request, executable: engineError })).status).toBe('engine_error')
  })

  it('captures non-zero exit and output evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-'))
    const outputDirectory = join(root, 'output')
    const scriptPath = join(root, 'script.js')
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(scriptPath, 'export default function () {}\n')
    const execution = await runEngine({
      kind: 'k6', scriptPath, timeoutMs: 1000,
      outputDirectory, runId: 'fail', executable: await fakeK6(root, 'k6', 'boom'),
    })
    expect(execution.exitCode).toBe(2)
    expect(execution.status).toBe('engine_error')
    await expect(readFile(execution.stderrPath, 'utf8')).resolves.toContain('boom')
  })
})

async function fakeK6(dir: string, name: string, stderr = '', exitCode = 2): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "version" ]; then echo "k6 v0.0.0-fake"; exit 0; fi\necho "${stderr}" >&2\nexit ${exitCode}\n`)
  await chmod(path, 0o755)
  return path
}

