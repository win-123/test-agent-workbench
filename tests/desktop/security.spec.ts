import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactSensitiveText, resolveInside } from '../../src/desktop/security.ts'

describe('desktop security helpers', () => {
  it('redacts credentials and tokens from logs', () => {
    const input = [
      'Authorization: Bearer abc123',
      'Cookie: session=super-secret',
      'password=hunter2',
      'api_key=my-key',
      'https://user:pass@example.test/path',
    ].join('\n')
    const output = redactSensitiveText(input)
    expect(output).not.toContain('abc123')
    expect(output).not.toContain('super-secret')
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('my-key')
    expect(output).not.toContain('user:pass')
    expect(output).toContain('[REDACTED]')
  })

  it('rejects path traversal and accepts project-relative files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-agent-desktop-security-'))
    expect(resolveInside(root, 'output/report.json')).toBe(join(root, 'output', 'report.json'))
    expect(() => resolveInside(root, '../escape.txt')).toThrow('escapes project directory')
    expect(() => resolveInside(root, join(root, 'still-inside.json'))).not.toThrow()
    const link = join(root, 'link')
    await symlink('/tmp', link)
    expect(() => resolveInside(root, 'link/outside.txt')).toThrow('escapes project directory')
  })
})
