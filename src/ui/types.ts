export const UI_CASE_SCHEMA_VERSION = 'test-agent.ui-case/v1' as const

export type UiLocatorKind = 'role' | 'label' | 'testId' | 'text' | 'css'

export interface UiLocator {
  kind: UiLocatorKind
  value: string
  role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | 'heading' | 'option' | 'dialog' | 'alert'
  name?: string
  exact?: boolean
}

export type UiWaitState = 'attached' | 'detached' | 'visible' | 'hidden'
export type UiAssertionKind = 'visible' | 'hidden' | 'text' | 'containsText' | 'value' | 'count'

export type UiStep =
  | { id: string; action: 'navigate'; url: string; description?: string }
  | { id: string; action: 'click'; locator: UiLocator; description?: string }
  | { id: string; action: 'fill'; locator: UiLocator; value: string; description?: string }
  | { id: string; action: 'select'; locator: UiLocator; value: string; description?: string }
  | { id: string; action: 'wait'; locator?: UiLocator; state?: UiWaitState; timeoutMs?: number; description?: string }
  | {
      id: string
      action: 'assert'
      assertion: UiAssertionKind
      locator?: UiLocator
      expected?: string | number
      timeoutMs?: number
      description?: string
    }

export interface UiEnvironment {
  name: string
  baseUrl: string
  allowedOrigins: string[]
  credential_refs: string[]
}

export interface UiTestCase {
  schema_version: typeof UI_CASE_SCHEMA_VERSION
  case_id: string
  name: string
  version: number
  target_url: string
  allowed_origins: string[]
  timeout_ms: number
  headless: boolean
  steps: UiStep[]
  created_at: string
  updated_at: string
}

export type UiCase = UiTestCase

export interface UiCaseSummary {
  case_id: string
  name: string
  version: number
  target_url: string
  step_count: number
  updated_at: string
  path: string
}

export interface UiValidationIssue {
  code: string
  path: string
  message: string
}

export interface UiValidationResult {
  valid: boolean
  issues: UiValidationIssue[]
  testCase?: UiTestCase
}

export interface UiStepResult {
  id: string
  action: UiStep['action']
  status: 'passed' | 'failed' | 'skipped'
  started_at: string
  finished_at: string
  duration_ms: number
  description?: string
  expected?: string
  actual?: string
  error?: string
  screenshot_path?: string
}

export interface UiConsoleEntry {
  type: string
  text: string
  at: string
}

export type UiRunStatus = 'passed' | 'failed' | 'cancelled' | 'engine_error'

export interface UiTestReport {
  run_id: string
  case_id: string
  case_version: number
  name: string
  status: UiRunStatus
  target_url: string
  browser: string
  started_at: string
  finished_at: string
  duration_ms: number
  steps_total: number
  steps_passed: number
  steps_failed: number
  steps: UiStepResult[]
  console: UiConsoleEntry[]
  page_errors: string[]
  screenshots: string[]
  error?: string
  sensitive_redacted: true
}

export interface RecordedUiAction {
  type: 'navigate' | 'click' | 'fill' | 'select' | 'wait'
  url?: string
  locator?: UiLocator
  value?: string
  state?: UiWaitState
  description?: string
}

export interface UiRecording {
  name?: string
  target_url: string
  allowed_origins?: string[]
  timeout_ms?: number
  actions: RecordedUiAction[]
}

export interface UiRunnerOptions {
  outputDirectory: string
  runId?: string
  chromeExecutable?: string
  signal?: AbortSignal
}
