import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getEngineVersion } from '../engines/executor.ts'
import type { EngineKind } from '../engines/types.ts'
import type { EngineStatus } from './types.ts'
import { redactSensitiveText } from './security.ts'

export async function inspectEngine(engine: EngineKind, configured?: string): Promise<EngineStatus> {
  const envPath = engine === 'k6' ? process.env.TEST_AGENT_K6_PATH : process.env.TEST_AGENT_JMETER_PATH
  const executable = configured ?? optional(envPath) ?? await findOnPath(engine)
  if (executable === undefined) return { engine, installed: false, error: `${engine} was not found in PATH or settings` }
  try {
    const version = await getEngineVersion(engine, executable)
    return { engine, installed: true, executable, ...version === null ? {} : { version } }
  } catch (error) {
    return { engine, installed: false, executable, error: redactSensitiveText((error as Error).message) }
  }
}

async function findOnPath(executable: string): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const entry of pathEntries) {
    const candidate = join(entry, executable)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // Continue searching the configured PATH.
    }
  }
  return undefined
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value
}
