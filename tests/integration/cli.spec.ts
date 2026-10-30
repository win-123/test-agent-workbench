import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const node = process.execPath
const cli = ['--experimental-strip-types', 'src/cli/bin.ts']

describe('CLI without AI', () => {
  it('inspects a HAR file', async () => {
    const { stdout } = await execFileAsync(node, [...cli, 'har', 'inspect', 'samples/demo.har'])
    const parsed = JSON.parse(stdout) as { total: number }
    expect(parsed.total).toBe(3)
  })

  it('rejects a non-whitelisted base URL', async () => {
    const result = await execFileAsync(node, [...cli, 'api', 'replay', 'samples/demo.har', '--base-url', 'https://external.example.test'])
      .catch(error => error)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('target origin is not whitelisted')
  })
})
