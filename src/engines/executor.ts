import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { access, constants } from 'node:fs/promises'
import type { EngineExecutionRequest, EngineExecutionResult, EngineKind } from './types.ts'
import { EngineNotInstalledError } from './types.ts'

export const K6_EXECUTABLE = process.env.TEST_AGENT_K6_PATH ?? 'k6'
export const JMETER_EXECUTABLE = process.env.TEST_AGENT_JMETER_PATH ?? 'jmeter'

export async function runEngine(request: EngineExecutionRequest): Promise<EngineExecutionResult> {
  const executable = request.executable ?? (request.kind === 'k6' ? K6_EXECUTABLE : JMETER_EXECUTABLE)
  await assertExecutable(executable, request.kind)
  const version = await getEngineVersion(request.kind, executable)
  const stdoutPath = join(request.outputDirectory, `${request.runId}.${request.kind}.stdout.log`)
  const stderrPath = join(request.outputDirectory, `${request.runId}.${request.kind}.stderr.log`)
  const rawResultPath = request.kind === 'k6'
    ? join(request.outputDirectory, `${request.runId}.k6.json`)
    : join(request.outputDirectory, `${request.runId}.jmeter.jtl`)
  const engineLogPath = request.kind === 'jmeter'
    ? join(request.outputDirectory, `${request.runId}.jmeter.log`)
    : undefined
  const args = request.kind === 'k6'
    ? ['run', '--quiet', '--no-usage-report', '--summary-export', rawResultPath, request.scriptPath]
    : ['-n', '-t', request.scriptPath, '-l', rawResultPath, ...(engineLogPath === undefined ? [] : ['-j', engineLogPath])]
  const startedAt = new Date()
  await mkdir(request.outputDirectory, { recursive: true })
  const stdoutHandle = await open(stdoutPath, 'w')
  const stderrHandle = await open(stderrPath, 'w')
  if (request.signal?.aborted === true) {
    await stdoutHandle.close()
    await stderrHandle.close()
    return {
      kind: request.kind,
      runId: request.runId,
      executable,
      version,
      arguments: args,
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
      status: 'cancelled',
      stdoutPath,
      stderrPath,
      engineLogPath,
      rawResultPath,
      startedAt,
      finishedAt: new Date(),
    }
  }
  const child = spawn(executable, args, {
    stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
  })
  const outcome = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean }>((resolve, reject) => {
    let timedOut = false
    let cancelled = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, request.timeoutMs)
    const cancel = (): void => {
      cancelled = true
      child.kill('SIGKILL')
    }
    request.signal?.addEventListener('abort', cancel, { once: true })
    const error = (cause: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', cancel)
      reject(cause)
    }
    const exit = (code: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', cancel)
      resolve({ exitCode: code, signal, timedOut, cancelled })
    }
    child.once('error', error)
    child.once('exit', (code, signal) => {
      exit(code, signal)
    })
  })
  await stdoutHandle.close()
  await stderrHandle.close()
  const finishedAt = new Date()
  const stderr = await readFile(stderrPath, 'utf8').catch(() => '')
  return {
    kind: request.kind,
    runId: request.runId,
    executable,
    version,
    arguments: args,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    status: outcome.cancelled ? 'cancelled' : classifyExecution(request.kind, outcome, stderr),
    stdoutPath,
    stderrPath,
    engineLogPath,
    rawResultPath,
    startedAt,
    finishedAt,
  }
}

export async function getEngineVersion(kind: EngineKind, executable: string = kind === 'k6' ? K6_EXECUTABLE : JMETER_EXECUTABLE): Promise<string | null> {
  await assertExecutable(executable, kind)
  const args = kind === 'k6' ? ['version'] : ['--version']
  const output = await capture(executable, args).catch(error => {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') throw new EngineNotInstalledError(kind)
    return null
  })
  if (output === null) return null
  return kind === 'k6'
    ? (output.trim().split('\n')[0] ?? '')
    : (output.match(/Apache JMeter\s+([\d.]+)/i)?.[1] ?? output.match(/(?:^|\s)5\.6\.3(?:\s|$)/)?.[0]?.trim() ?? output.match(/Version\s+([\d.]+)/i)?.[1] ?? null)
}

async function assertExecutable(executable: string, kind: EngineKind): Promise<void> {
  try {
    await access(executable, constants.X_OK)
  } catch {
    throw new EngineNotInstalledError(kind)
  }
}

function classifyExecution(
  kind: EngineKind,
  outcome: { exitCode: number | null; timedOut: boolean },
  stderr: string,
): EngineExecutionResult['status'] {
  if (outcome.timedOut) return 'timeout'
  const code = outcome.exitCode ?? -1
  if (code === 0) return 'passed'
  if (kind === 'k6') {
    if (/invalid|syntax|unexpected token|load/i.test(stderr)) return 'invalid_script'
    if (/not found|enoent|no such file/i.test(stderr)) return 'engine_error'
  } else {
    if (/cannot read|parse|syntax|malformed|invalid.*\.jmx|\.jmx.*not/i.test(stderr)) return 'invalid_script'
    if (/non-nodemanager|fatal|error/i.test(stderr)) return 'engine_error'
  }
  return 'engine_error'
}

function capture(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code !== undefined) reject(error)
      else if (error) reject(new Error(`engine version command failed: ${stderr}`))
      else resolve(`${stdout}${stderr}`)
    })
  })
}
