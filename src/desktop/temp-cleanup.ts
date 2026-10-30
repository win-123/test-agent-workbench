import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveInside } from './security.ts'

export interface TemporaryCleanupResult {
  removed: string[]
  retained: string[]
}

export async function cleanupStaleTemporaryFiles(
  projectRoot: string,
  olderThanMs = 5 * 60 * 1000,
  now = Date.now(),
): Promise<TemporaryCleanupResult> {
  const root = resolveInside(projectRoot, '.test-agent')
  const removed: string[] = []
  const retained: string[] = []
  await visit(root)
  return { removed, retained }

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || !isAtomicTemporaryName(entry.name)) continue
      const info = await stat(path)
      if (now - info.mtimeMs < olderThanMs) {
        retained.push(path)
        continue
      }
      await unlink(path)
      removed.push(path)
    }
  }
}

function isAtomicTemporaryName(name: string): boolean {
  return name.endsWith('.tmp') && /(?:\.state|\.json)(?:\.\d+){2}$/.test(name.slice(0, -4))
}
