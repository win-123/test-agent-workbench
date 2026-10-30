import { open, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { planHash } from './plan.ts'
import {
  AGENT_TASK_SCHEMA_VERSION,
  type AgentTaskState,
  type TestPlan,
} from './types.ts'

interface LockRecord {
  pid: number
  hostname: string
  created_at: string
}

export class TaskStore {
  readonly rootDir: string
  readonly tasksDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.tasksDir = join(rootDir, 'tasks')
  }

  taskDir(taskId: string): string {
    assertTaskId(taskId)
    return join(this.tasksDir, taskId)
  }

  artifactDir(taskId: string): string {
    return join(this.taskDir(taskId), 'artifacts')
  }

  statePath(taskId: string): string {
    return join(this.taskDir(taskId), 'state.json')
  }

  async createTask(plan: TestPlan, now = new Date()): Promise<AgentTaskState> {
    const timestamp = now.toISOString()
    const state: AgentTaskState = {
      schema_version: AGENT_TASK_SCHEMA_VERSION,
      task_id: plan.task_id,
      plan_hash: planHash(plan),
      plan,
      status: 'awaiting_confirmation',
      created_at: timestamp,
      updated_at: timestamp,
      confirmation: {
        required: true,
        token: randomUUID(),
      },
      steps: plan.steps.map(step => ({
        step_id: step.id,
        title: step.title,
        status: 'pending',
      })),
      tool_calls: [],
      run_ids: [],
    }
    await mkdir(this.tasksDir, { recursive: true })
    try {
      await mkdir(this.taskDir(plan.task_id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`task already exists: ${plan.task_id}; use a new task id for a separate run`)
      }
      throw error
    }
    await mkdir(this.artifactDir(plan.task_id), { recursive: true })
    await this.save(state)
    return state
  }

  async save(state: AgentTaskState): Promise<void> {
    assertTaskId(state.task_id)
    const path = this.statePath(state.task_id)
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
    await rename(temporary, path)
  }

  async load(taskId: string): Promise<AgentTaskState> {
    const path = this.statePath(taskId)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`task not found: ${taskId}`)
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`task state is not valid JSON: ${(error as Error).message}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('task state must be a JSON object')
    }
    const state = parsed as Partial<AgentTaskState>
    if (state.schema_version !== AGENT_TASK_SCHEMA_VERSION) {
      throw new Error(`unsupported task schema version: ${String(state.schema_version)}`)
    }
    if (state.task_id !== taskId) throw new Error(`task state id mismatch: expected ${taskId}, got ${String(state.task_id)}`)
    return state as AgentTaskState
  }

  async exists(taskId: string): Promise<boolean> {
    try {
      await stat(this.statePath(taskId))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async list(): Promise<AgentTaskState[]> {
    let entries: string[]
    try {
      entries = await readdir(this.tasksDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const states: AgentTaskState[] = []
    for (const taskId of entries) {
      try {
        states.push(await this.load(taskId))
      } catch {
        // Ignore incomplete directories and corrupted task files in list output.
      }
    }
    return states.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async acquireLock(taskId: string): Promise<() => Promise<void>> {
    const path = join(this.taskDir(taskId), 'execution.lock')
    await mkdir(dirname(path), { recursive: true })
    try {
      const handle = await open(path, 'wx')
      const record: LockRecord = {
        pid: process.pid,
        hostname: hostname(),
        created_at: new Date().toISOString(),
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`)
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStaleLock(path)) {
        await unlink(path).catch(() => undefined)
        return await this.acquireLock(taskId)
      }
      throw new Error(`task is already executing: ${taskId}`)
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      await unlink(path).catch(() => undefined)
    }
  }

  async requestCancellation(taskId: string): Promise<void> {
    await mkdir(this.taskDir(taskId), { recursive: true })
    await writeFile(join(this.taskDir(taskId), 'cancel.request'), new Date().toISOString())
  }

  async clearCancellation(taskId: string): Promise<void> {
    await rm(join(this.taskDir(taskId), 'cancel.request'), { force: true })
  }

  async cancellationRequested(taskId: string): Promise<boolean> {
    try {
      await stat(join(this.taskDir(taskId), 'cancel.request'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  let record: LockRecord
  try {
    record = JSON.parse(await readFile(path, 'utf8')) as LockRecord
  } catch {
    return true
  }
  if (record.hostname !== hostname()) {
    const info = await stat(path).catch(() => undefined)
    return info === undefined || Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return true
  try {
    process.kill(record.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function assertTaskId(taskId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(taskId)) {
    throw new Error(`invalid task id: ${taskId}`)
  }
}
