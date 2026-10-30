export type EngineKind = 'k6' | 'jmeter'

export type EngineExecutionStatus =
  | 'not_installed'
  | 'cancelled'
  | 'timeout'
  | 'invalid_script'
  | 'engine_error'
  | 'result_parse_error'
  | 'test_failed'
  | 'passed'

export interface EngineExecutionRequest {
  kind: EngineKind
  scriptPath: string
  timeoutMs: number
  outputDirectory: string
  runId: string
  /** Overrides the engine path; tests use fake executables. */
  executable?: string
  /** Cancels the running engine process and records a cancelled outcome. */
  signal?: AbortSignal
}

export interface EngineDiagnostic {
  category: 'engine_run' | 'result_parse' | 'test_result'
  message: string
}

export interface EngineExecutionResult {
  kind: EngineKind
  runId: string
  executable: string
  version: string | null
  arguments: string[]
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  status: Exclude<EngineExecutionStatus, 'result_parse_error' | 'test_failed'>
  stdoutPath: string
  stderrPath: string
  engineLogPath?: string
  rawResultPath?: string
  startedAt: Date
  finishedAt: Date
}

export class EngineNotInstalledError extends Error {
  constructor(kind: EngineKind) {
    super(`engine is not installed or executable is unavailable: ${kind}`)
    this.name = 'EngineNotInstalledError'
  }
}
