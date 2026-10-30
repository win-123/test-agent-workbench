import {
  UI_CASE_SCHEMA_VERSION,
  type RecordedUiAction,
  type UiCase,
  type UiLocator,
  type UiRecording,
  type UiStep,
  type UiValidationIssue,
  type UiValidationResult,
} from './types.ts'

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/
const STEP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const ROLE_VALUES = new Set(['button', 'link', 'textbox', 'checkbox', 'combobox', 'heading', 'option', 'dialog', 'alert'])
const WAIT_STATES = new Set(['attached', 'detached', 'visible', 'hidden'])
const ASSERTIONS = new Set(['visible', 'hidden', 'text', 'containsText', 'value', 'count'])
const MAX_STEPS = 200
const MAX_VALUE = 4000
const MAX_TIMEOUT = 120_000

export function validateUiTestCase(input: unknown): UiValidationResult {
  const issues: UiValidationIssue[] = []
  if (!record(input)) return invalid('invalid_root', '$', 'UI test case must be an object')
  if (input['schema_version'] !== UI_CASE_SCHEMA_VERSION) issue(issues, 'invalid_schema', '$.schema_version', `expected ${UI_CASE_SCHEMA_VERSION}`)
  if (typeof input['case_id'] !== 'string' || !ID_PATTERN.test(input['case_id'])) {
    issue(issues, 'invalid_case_id', '$.case_id', 'case_id must match [a-zA-Z0-9][a-zA-Z0-9._-]{1,79}')
  }
  nonEmpty(input['name'], '$.name', 'name', issues)
  if (!Number.isSafeInteger(input['version']) || Number(input['version']) < 1) issue(issues, 'invalid_version', '$.version', 'version must be a positive integer')
  validateUrl(input['target_url'], '$.target_url', issues)
  const origins = validateOrigins(input['allowed_origins'], '$.allowed_origins', issues)
  if (typeof input['target_url'] === 'string') {
    const origin = safeOrigin(input['target_url'])
    if (origin !== undefined && !origins.includes(origin)) issue(issues, 'target_origin_not_allowed', '$.target_url', 'allowed_origins must include the target origin')
  }
  positiveTimeout(input['timeout_ms'], '$.timeout_ms', issues)
  if (typeof input['headless'] !== 'boolean') issue(issues, 'invalid_headless', '$.headless', 'headless must be a boolean')
  if (typeof input['created_at'] !== 'string' || Number.isNaN(Date.parse(input['created_at']))) issue(issues, 'invalid_created_at', '$.created_at', 'created_at must be ISO time')
  if (typeof input['updated_at'] !== 'string' || Number.isNaN(Date.parse(input['updated_at']))) issue(issues, 'invalid_updated_at', '$.updated_at', 'updated_at must be ISO time')
  const steps = Array.isArray(input['steps']) ? input['steps'] : []
  if (!Array.isArray(input['steps']) || steps.length === 0) issue(issues, 'missing_steps', '$.steps', 'steps must be a non-empty array')
  if (steps.length > MAX_STEPS) issue(issues, 'too_many_steps', '$.steps', `steps must contain at most ${MAX_STEPS} items`)
  const stepIds = new Set<string>()
  for (const [index, step] of steps.entries()) validateStep(step, `$.steps[${index}]`, stepIds, issues, origins)
  return issues.length === 0
    ? { valid: true, issues, testCase: input as unknown as UiCase }
    : { valid: false, issues }
}

export function parseUiTestCase(raw: string): UiCase {
  let input: unknown
  try {
    input = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`invalid UI test case JSON: ${(error as Error).message}`)
  }
  const result = validateUiTestCase(input)
  if (!result.valid || result.testCase === undefined) {
    throw new Error(`UI test case validation failed: ${result.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  }
  return result.testCase
}

export function importUiRecording(input: unknown, options: {
  caseId: string
  version: number
  createdAt?: string
}): UiCase {
  if (!record(input)) throw new Error('recording must be a JSON object')
  const recording = input as unknown as UiRecording
  const urlIssues: UiValidationIssue[] = []
  validateUrl(recording.target_url, '$.target_url', urlIssues)
  if (urlIssues.length > 0) throw new Error(`recording validation failed: ${urlIssues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  if (!Array.isArray(recording.actions) || recording.actions.length === 0) throw new Error('recording.actions must be a non-empty array')
  if (recording.actions.length > MAX_STEPS) throw new Error(`recording contains more than ${MAX_STEPS} actions`)
  const now = options.createdAt ?? new Date().toISOString()
  const steps = recording.actions.map((action, index) => recordingActionToStep(action, index))
  const targetOrigin = safeOrigin(recording.target_url)
  const allowedOrigins = recording.allowed_origins ?? (targetOrigin === undefined ? [] : [targetOrigin])
  const candidate: UiCase = {
    schema_version: UI_CASE_SCHEMA_VERSION,
    case_id: options.caseId,
    name: recording.name?.trim() || 'Imported UI recording',
    version: options.version,
    target_url: recording.target_url,
    allowed_origins: allowedOrigins,
    timeout_ms: recording.timeout_ms ?? 30_000,
    headless: true,
    steps,
    created_at: now,
    updated_at: now,
  }
  const validation = validateUiTestCase(candidate)
  if (!validation.valid || validation.testCase === undefined) {
    throw new Error(`recording validation failed: ${validation.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  }
  return validation.testCase
}

export function isOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  try {
    return allowedOrigins.includes(new URL(url).origin)
  } catch {
    return false
  }
}

function validateStep(value: unknown, path: string, seen: Set<string>, issues: UiValidationIssue[], allowedOrigins: string[]): void {
  if (!record(value)) {
    issue(issues, 'invalid_step', path, 'step must be an object')
    return
  }
  const id = value['id']
  if (typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) issue(issues, 'invalid_step_id', `${path}.id`, 'invalid step id')
  else if (seen.has(id)) issue(issues, 'duplicate_step_id', `${path}.id`, `duplicate step id: ${id}`)
  else seen.add(id)
  if (typeof value['description'] === 'string' && value['description'].length > MAX_VALUE) issue(issues, 'description_too_long', `${path}.description`, 'description is too long')
  const action = value['action']
  if (action === 'navigate') {
    validateUrl(value['url'], `${path}.url`, issues)
    if (typeof value['url'] === 'string') {
      const origin = safeOrigin(value['url'])
      if (origin !== undefined && !allowedOrigins.includes(origin)) {
        issue(issues, 'navigation_origin_not_allowed', `${path}.url`, 'navigation URL origin must be listed in allowed_origins')
      }
    }
  } else if (action === 'click' || action === 'fill' || action === 'select') {
    validateLocator(value['locator'], `${path}.locator`, issues)
    if (action !== 'click') {
      if (typeof value['value'] !== 'string' || value['value'].length > MAX_VALUE) issue(issues, 'invalid_step_value', `${path}.value`, 'value must be a bounded string')
    }
  } else if (action === 'wait') {
    if (value['locator'] !== undefined) validateLocator(value['locator'], `${path}.locator`, issues)
    if (value['locator'] === undefined && value['timeoutMs'] === undefined) issue(issues, 'invalid_wait', path, 'wait requires a locator or timeoutMs')
    if (value['state'] !== undefined && !WAIT_STATES.has(String(value['state']))) issue(issues, 'invalid_wait_state', `${path}.state`, 'invalid wait state')
    if (value['timeoutMs'] !== undefined) positiveTimeout(value['timeoutMs'], `${path}.timeoutMs`, issues)
  } else if (action === 'assert') {
    if (!ASSERTIONS.has(String(value['assertion']))) issue(issues, 'invalid_assertion', `${path}.assertion`, 'invalid UI assertion')
    if (value['locator'] !== undefined) validateLocator(value['locator'], `${path}.locator`, issues)
    if (value['locator'] === undefined) issue(issues, 'missing_assertion_locator', `${path}.locator`, 'assertion requires a locator')
    if (value['assertion'] !== 'visible' && value['assertion'] !== 'hidden' && value['expected'] === undefined) {
      issue(issues, 'missing_assertion_expected', `${path}.expected`, 'assertion expected value is required')
    }
    if (value['expected'] !== undefined && typeof value['expected'] !== 'string' && typeof value['expected'] !== 'number') {
      issue(issues, 'invalid_assertion_expected', `${path}.expected`, 'expected must be a string or number')
    }
    if (value['assertion'] === 'count' && (!Number.isSafeInteger(value['expected']) || Number(value['expected']) < 0)) {
      issue(issues, 'invalid_assertion_count', `${path}.expected`, 'count assertion requires a non-negative integer')
    }
    if (value['assertion'] === 'text' || value['assertion'] === 'containsText' || value['assertion'] === 'value') {
      if (typeof value['expected'] !== 'string') issue(issues, 'invalid_assertion_text', `${path}.expected`, `${String(value['assertion'])} assertion requires a string`)
    }
    if (value['timeoutMs'] !== undefined) positiveTimeout(value['timeoutMs'], `${path}.timeoutMs`, issues)
  } else {
    issue(issues, 'unknown_action', `${path}.action`, 'action must be navigate, click, fill, select, wait, or assert')
  }
}

function validateLocator(value: unknown, path: string, issues: UiValidationIssue[]): void {
  if (!record(value)) {
    issue(issues, 'invalid_locator', path, 'locator must be an object')
    return
  }
  const kind = value['kind']
  if (!['role', 'label', 'testId', 'text', 'css'].includes(String(kind))) issue(issues, 'invalid_locator_kind', `${path}.kind`, 'invalid locator kind')
  if (typeof value['value'] !== 'string' || value['value'].trim().length === 0 || value['value'].length > 500) {
    issue(issues, 'invalid_locator_value', `${path}.value`, 'locator value must be a bounded non-empty string')
  }
  if (/javascript:|data:text\/html|file:/i.test(String(value['value']))) issue(issues, 'unsafe_locator', `${path}.value`, 'unsafe locator value')
  if (kind === 'role') {
    if (!ROLE_VALUES.has(String(value['role']))) issue(issues, 'invalid_role', `${path}.role`, 'invalid ARIA role')
    if (typeof value['name'] !== 'string' || value['name'].length === 0) issue(issues, 'missing_role_name', `${path}.name`, 'role locator requires an accessible name')
  }
  if (value['exact'] !== undefined && typeof value['exact'] !== 'boolean') issue(issues, 'invalid_exact', `${path}.exact`, 'exact must be a boolean')
}

function recordingActionToStep(action: RecordedUiAction, index: number): UiStep {
  if (!record(action)) throw new Error(`recording.actions[${index}] must be an object`)
  const id = `recorded-${index + 1}`
  if (action.type === 'navigate') return { id, action: 'navigate', url: requiredString(action.url, `actions[${index}].url`) }
  if (action.type === 'click') return { id, action: 'click', locator: action.locator as UiLocator, description: action.description }
  if (action.type === 'fill') return { id, action: 'fill', locator: action.locator as UiLocator, value: String(action.value ?? ''), description: action.description }
  if (action.type === 'select') return { id, action: 'select', locator: action.locator as UiLocator, value: requiredString(action.value, `actions[${index}].value`), description: action.description }
  if (action.type === 'wait') return { id, action: 'wait', locator: action.locator, state: action.state, description: action.description }
  throw new Error(`unsupported recorded action: ${String((action as { type?: unknown }).type)}`)
}

function validateUrl(value: unknown, path: string, issues: UiValidationIssue[]): void {
  if (typeof value !== 'string') {
    issue(issues, 'invalid_url', path, 'URL must be a string')
    return
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') issue(issues, 'invalid_url_protocol', path, 'URL must use http or https')
    if (url.username !== '' || url.password !== '') issue(issues, 'url_credentials', path, 'URL must not contain credentials')
  } catch {
    issue(issues, 'invalid_url', path, 'URL must be absolute')
  }
}

function validateOrigins(value: unknown, path: string, issues: UiValidationIssue[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20 || !value.every(item => typeof item === 'string')) {
    issue(issues, 'invalid_origins', path, 'allowed_origins must contain 1-20 strings')
    return []
  }
  const origins: string[] = []
  for (const item of value) {
    let url: URL
    try {
      url = new URL(item)
    } catch {
      issue(issues, 'invalid_origin', path, `invalid origin: ${item}`)
      continue
    }
    if (url.origin !== item || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      issue(issues, 'invalid_origin', path, `origin must contain only http(s) scheme, host, and port: ${item}`)
    } else {
      origins.push(item)
    }
  }
  return [...new Set(origins)]
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function positiveTimeout(value: unknown, path: string, issues: UiValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 100 || Number(value) > MAX_TIMEOUT) {
    issue(issues, 'invalid_timeout', path, `timeout must be between 100 and ${MAX_TIMEOUT} ms`)
  }
}

function nonEmpty(value: unknown, path: string, name: string, issues: UiValidationIssue[]): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) issue(issues, 'invalid_string', path, `${name} must be a bounded non-empty string`)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
  return value
}

function issue(issues: UiValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message })
}

function invalid(code: string, path: string, message: string): UiValidationResult {
  return { valid: false, issues: [{ code, path, message }] }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
