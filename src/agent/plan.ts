import { createHash } from 'node:crypto'
import {
  AGENT_PLAN_SCHEMA_VERSION,
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type PlanAssertion,
  type PlanValidationIssue,
  type PlanValidationResult,
  type TestPlan,
  type TestPlanStep,
} from './types.ts'

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/
const STEP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const ALLOWED_TOOLS = new Set<string>(AGENT_TOOL_NAMES)
const SIDE_EFFECT_TOOLS = new Set<AgentToolName>(['api.replay', 'engine.run.k6', 'engine.run.jmeter'])

export function validateTestPlan(input: unknown): PlanValidationResult {
  const issues: PlanValidationIssue[] = []
  if (!isRecord(input)) {
    return { valid: false, issues: [issue('invalid_root', '$', 'plan must be a JSON object')] }
  }

  if (input['schema_version'] !== AGENT_PLAN_SCHEMA_VERSION) {
    issues.push(issue('invalid_schema_version', '$.schema_version', `expected ${AGENT_PLAN_SCHEMA_VERSION}`))
  }
  validateTaskId(input['task_id'], issues)
  validateNonEmptyString(input['goal'], '$.goal', 'goal', issues)
  validateTarget(input['target'], issues)
  validateAuthorization(input['authorization'], issues)

  const testDataNames = validateTestData(input['test_data'], issues)
  const steps = validateSteps(input['steps'], testDataNames, issues)
  validateRequestDependencies(input['request_dependencies'], issues)

  for (const [index, step] of steps.entries()) {
    if (SIDE_EFFECT_TOOLS.has(step.tool) && !step.risk.side_effects) {
      issues.push(issue('side_effect_understated', `$.steps[${index}].risk.side_effects`, `${step.tool} can produce side effects`))
    }
    if (SIDE_EFFECT_TOOLS.has(step.tool) && !step.risk.requires_confirmation) {
      issues.push(issue('side_effect_confirmation_missing', `$.steps[${index}].risk.requires_confirmation`, `${step.tool} requires confirmation`))
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    ...issues.length === 0 ? { plan: input as unknown as TestPlan } : {},
  }
}

export function parseAndValidateTestPlan(raw: string): TestPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`invalid test plan JSON: ${(error as Error).message}`)
  }
  const result = validateTestPlan(parsed)
  if (!result.valid || result.plan === undefined) {
    throw new Error(`test plan validation failed: ${result.issues.map(item => `${item.path}: ${item.message}`).join('; ')}`)
  }
  return result.plan
}

export function planHash(plan: TestPlan): string {
  return createHash('sha256').update(stableJson(plan)).digest('hex')
}

export function planHasSideEffects(plan: TestPlan): boolean {
  return plan.steps.some(step => step.risk.side_effects)
}

export function summarizePlanRisk(plan: TestPlan): string {
  const lines = plan.steps.map(step => {
    const sideEffects = step.risk.side_effects ? 'side effects' : 'read-only/local artifact'
    return `- ${step.id}: ${step.tool} (${step.risk.level}, ${sideEffects})`
  })
  return [`Goal: ${plan.goal}`, `Target: ${plan.target.base_url}`, ...lines].join('\n')
}

function validateTaskId(value: unknown, issues: PlanValidationIssue[]): void {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    issues.push(issue('invalid_task_id', '$.task_id', 'task_id must match [a-zA-Z0-9][a-zA-Z0-9._-]{2,79}'))
  }
}

function validateTarget(value: unknown, issues: PlanValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue('invalid_target', '$.target', 'target must be an object'))
    return
  }
  const raw = value['base_url']
  if (typeof raw !== 'string' || raw.length === 0) {
    issues.push(issue('missing_base_url', '$.target.base_url', 'base_url is required'))
  } else {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push(issue('invalid_base_url_protocol', '$.target.base_url', 'base_url must use http or https'))
      }
      if (parsed.username !== '' || parsed.password !== '') {
        issues.push(issue('base_url_credentials', '$.target.base_url', 'base_url must not contain credentials'))
      }
      if (parsed.search !== '') {
        issues.push(issue('base_url_query', '$.target.base_url', 'base_url must not contain a query string'))
      }
      if (parsed.hash !== '') {
        issues.push(issue('base_url_fragment', '$.target.base_url', 'base_url must not contain a fragment'))
      }
    } catch {
      issues.push(issue('invalid_base_url', '$.target.base_url', 'base_url must be a valid absolute URL'))
    }
  }
  validateStringArray(value['allowed_origins'], '$.target.allowed_origins', issues)
  validateStringArray(value['allowed_paths'], '$.target.allowed_paths', issues)
}

function validateAuthorization(value: unknown, issues: PlanValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue('missing_authorization', '$.authorization', 'authorization is required'))
    return
  }
  if (value['confirmed'] !== true) {
    issues.push(issue('authorization_not_confirmed', '$.authorization.confirmed', 'the target must be explicitly authorized'))
  }
  validateNonEmptyString(value['scope'], '$.authorization.scope', 'authorization scope', issues)
  if (value['notes'] !== undefined && typeof value['notes'] !== 'string') {
    issues.push(issue('invalid_authorization_notes', '$.authorization.notes', 'notes must be a string'))
  }
}

function validateTestData(value: unknown, issues: PlanValidationIssue[]): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_test_data', '$.test_data', 'test_data must be a non-empty array'))
    return names
  }
  if (value.length === 0) {
    issues.push(issue('missing_test_data', '$.test_data', 'at least one test data source is required'))
  }
  for (const [index, item] of value.entries()) {
    const path = `$.test_data[${index}]`
    if (!isRecord(item)) {
      issues.push(issue('invalid_test_data_item', path, 'test data item must be an object'))
      continue
    }
    const name = item['name']
    if (typeof name !== 'string' || name.length === 0) {
      issues.push(issue('missing_test_data_name', `${path}.name`, 'test data name is required'))
    } else if (names.has(name)) {
      issues.push(issue('duplicate_test_data_name', `${path}.name`, `duplicate test data name: ${name}`))
    } else {
      names.add(name)
    }
    if (!['har', 'fixture', 'inline', 'environment'].includes(String(item['kind']))) {
      issues.push(issue('invalid_test_data_kind', `${path}.kind`, 'kind must be har, fixture, inline, or environment'))
    }
    if (item['location'] !== undefined && typeof item['location'] !== 'string') {
      issues.push(issue('invalid_test_data_location', `${path}.location`, 'location must be a string'))
    }
    if (item['description'] !== undefined && typeof item['description'] !== 'string') {
      issues.push(issue('invalid_test_data_description', `${path}.description`, 'description must be a string'))
    }
  }
  return names
}

function validateSteps(value: unknown, testDataNames: Set<string>, issues: PlanValidationIssue[]): TestPlanStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue('missing_steps', '$.steps', 'steps must be a non-empty array'))
    return []
  }
  const seen = new Set<string>()
  const steps: TestPlanStep[] = []
  for (const [index, item] of value.entries()) {
    const path = `$.steps[${index}]`
    if (!isRecord(item)) {
      issues.push(issue('invalid_step', path, 'step must be an object'))
      continue
    }
    const id = item['id']
    if (typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) {
      issues.push(issue('invalid_step_id', `${path}.id`, 'step id must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}'))
    } else if (seen.has(id)) {
      issues.push(issue('duplicate_step_id', `${path}.id`, `duplicate step id: ${id}`))
    } else {
      seen.add(id)
    }
    validateNonEmptyString(item['title'], `${path}.title`, 'step title', issues)
    const tool = item['tool']
    if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool)) {
      issues.push(issue('unknown_tool', `${path}.tool`, `tool must be one of: ${AGENT_TOOL_NAMES.join(', ')}`))
    }
    const args = item['arguments']
    if (!isRecord(args)) {
      issues.push(issue('invalid_step_arguments', `${path}.arguments`, 'arguments must be an object'))
    }
    const refs = validateStringArray(item['test_data_refs'], `${path}.test_data_refs`, issues)
    for (const ref of refs) {
      if (!testDataNames.has(ref)) {
        issues.push(issue('unknown_test_data_ref', `${path}.test_data_refs`, `unknown test data reference: ${ref}`))
      }
    }
    const assertions = validateAssertions(item['assertions'], `${path}.assertions`, issues)
    const dependsOn = validateStringArray(item['depends_on'], `${path}.depends_on`, issues)
    for (const dependency of dependsOn) {
      if (!seen.has(dependency)) {
        issues.push(issue('invalid_step_dependency', `${path}.depends_on`, `dependency must name an earlier step: ${dependency}`))
      }
      if (dependency === id) {
        issues.push(issue('self_step_dependency', `${path}.depends_on`, 'a step cannot depend on itself'))
      }
    }
    validateRisk(item['risk'], `${path}.risk`, issues)
    const acceptance = validateStringArray(item['acceptance_criteria'], `${path}.acceptance_criteria`, issues)
    if (acceptance.length === 0) {
      issues.push(issue('missing_acceptance_criteria', `${path}.acceptance_criteria`, 'at least one acceptance criterion is required'))
    }
    if (isRecord(args) && typeof tool === 'string' && ALLOWED_TOOLS.has(tool)) {
      validateToolArguments(tool as AgentToolName, args, `${path}.arguments`, issues)
    }
    if (isRecord(item['risk']) && typeof item['risk']['level'] === 'string' && typeof tool === 'string') {
      steps.push(item as unknown as TestPlanStep)
    }
  }
  return steps
}

function validateRisk(value: unknown, path: string, issues: PlanValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue('invalid_risk', path, 'risk must be an object'))
    return
  }
  if (!['low', 'medium', 'high'].includes(String(value['level']))) {
    issues.push(issue('invalid_risk_level', `${path}.level`, 'risk level must be low, medium, or high'))
  }
  if (typeof value['side_effects'] !== 'boolean') {
    issues.push(issue('invalid_side_effects', `${path}.side_effects`, 'side_effects must be a boolean'))
  }
  if (typeof value['requires_confirmation'] !== 'boolean') {
    issues.push(issue('invalid_requires_confirmation', `${path}.requires_confirmation`, 'requires_confirmation must be a boolean'))
  }
  const reasons = validateStringArray(value['reasons'], `${path}.reasons`, issues)
  if (reasons.length === 0) {
    issues.push(issue('missing_risk_reasons', `${path}.reasons`, 'at least one risk reason is required'))
  }
}

function validateAssertions(value: unknown, path: string, issues: PlanValidationIssue[]): PlanAssertion[] {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_assertions', path, 'assertions must be an array'))
    return []
  }
  for (const [index, assertion] of value.entries()) {
    const itemPath = `${path}[${index}]`
    if (!isRecord(assertion)) {
      issues.push(issue('invalid_assertion', itemPath, 'assertion must be an object'))
      continue
    }
    if (assertion['status'] !== undefined && (!Number.isSafeInteger(assertion['status']) || Number(assertion['status']) < 100 || Number(assertion['status']) > 599)) {
      issues.push(issue('invalid_assertion_status', `${itemPath}.status`, 'status must be an HTTP status integer'))
    }
    if (assertion['index'] !== undefined && (!Number.isSafeInteger(assertion['index']) || Number(assertion['index']) < 0)) {
      issues.push(issue('invalid_assertion_index', `${itemPath}.index`, 'index must be a non-negative integer'))
    }
    if (assertion['jsonPath'] !== undefined && (typeof assertion['jsonPath'] !== 'string' || !assertion['jsonPath'].startsWith('$'))) {
      issues.push(issue('invalid_assertion_json_path', `${itemPath}.jsonPath`, 'jsonPath must start with $'))
    }
    if (assertion['contains'] !== undefined && typeof assertion['contains'] !== 'string') {
      issues.push(issue('invalid_assertion_contains', `${itemPath}.contains`, 'contains must be a string'))
    }
    if (assertion['maxDurationMs'] !== undefined && (!Number.isSafeInteger(assertion['maxDurationMs']) || Number(assertion['maxDurationMs']) <= 0)) {
      issues.push(issue('invalid_assertion_duration', `${itemPath}.maxDurationMs`, 'maxDurationMs must be a positive integer'))
    }
    if (assertion['path'] !== undefined && (typeof assertion['path'] !== 'string' || !assertion['path'].startsWith('/'))) {
      issues.push(issue('invalid_assertion_path', `${itemPath}.path`, 'path must start with /'))
    }
    if (!['status', 'jsonPath', 'contains', 'maxDurationMs'].some(key => assertion[key] !== undefined)) {
      issues.push(issue('empty_assertion', itemPath, 'assertion must declare at least one condition'))
    }
  }
  return value as PlanAssertion[]
}

function validateRequestDependencies(value: unknown, issues: PlanValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_request_dependencies', '$.request_dependencies', 'request_dependencies must be an array'))
    return
  }
  for (const [index, item] of value.entries()) {
    const path = `$.request_dependencies[${index}]`
    if (!isRecord(item)) {
      issues.push(issue('invalid_request_dependency', path, 'request dependency must be an object'))
      continue
    }
    for (const field of ['from', 'to'] as const) {
      const number = item[field]
      if (!Number.isSafeInteger(number) || Number(number) < 0) {
        issues.push(issue('invalid_request_dependency_index', `${path}.${field}`, `${field} must be a non-negative HAR request index`))
      }
    }
    if (!['cookie', 'token', 'resource', 'ordering'].includes(String(item['kind']))) {
      issues.push(issue('invalid_request_dependency_kind', `${path}.kind`, 'kind must be cookie, token, resource, or ordering'))
    }
    validateNonEmptyString(item['description'], `${path}.description`, 'dependency description', issues)
  }
}

function validateToolArguments(tool: AgentToolName, args: Record<string, unknown>, path: string, issues: PlanValidationIssue[]): void {
  const allowedArguments: Record<AgentToolName, string[]> = {
    'har.inspect': ['path'],
    'api.replay': ['path', 'timeout_ms', 'concurrency'],
    'script.generate.k6': ['path', 'correlations'],
    'script.generate.jmeter': ['path', 'correlations', 'vus', 'iterations', 'duration'],
    'engine.run.k6': ['path', 'correlations', 'vus', 'iterations', 'duration', 'timeout_ms'],
    'engine.run.jmeter': ['path', 'correlations', 'vus', 'iterations', 'duration', 'timeout_ms'],
    'report.read': ['run_id', 'path'],
    'code.analyze.java': ['path'],
  }
  const allowed = new Set(allowedArguments[tool])
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      issues.push(issue('unknown_tool_argument', `${path}.${key}`, `argument "${key}" is not allowed for ${tool}`))
    }
  }
  const pathLikeTools = new Set<AgentToolName>([
    'har.inspect',
    'api.replay',
    'script.generate.k6',
    'script.generate.jmeter',
    'engine.run.k6',
    'engine.run.jmeter',
    'code.analyze.java',
  ])
  if (pathLikeTools.has(tool)) {
    validateNonEmptyString(args['path'], `${path}.path`, 'HAR path', issues)
  }
  for (const field of ['iterations', 'vus', 'timeout_ms', 'concurrency']) {
    if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || Number(args[field]) <= 0)) {
      issues.push(issue('invalid_positive_integer', `${path}.${field}`, `${field} must be a positive integer`))
    }
  }
  if (args['duration'] !== undefined && (typeof args['duration'] !== 'string' || !/^\d+(s|m)$/.test(args['duration']))) {
    issues.push(issue('invalid_duration', `${path}.duration`, 'duration must be like 30s or 2m'))
  }
  if (args['correlations'] !== undefined && !Array.isArray(args['correlations'])) {
    issues.push(issue('invalid_correlations', `${path}.correlations`, 'correlations must be an array'))
  }
  if (tool === 'report.read') {
    if (args['run_id'] === undefined && args['path'] === undefined) {
      issues.push(issue('missing_report_reference', path, 'report.read requires run_id or path'))
    }
    if (args['run_id'] !== undefined && (typeof args['run_id'] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(args['run_id']))) {
      issues.push(issue('invalid_run_id', `${path}.run_id`, 'run_id must be a non-empty string'))
    }
    if (args['path'] !== undefined && typeof args['path'] !== 'string') {
      issues.push(issue('invalid_report_path', `${path}.path`, 'path must be a string'))
    }
  }
}

function validateNonEmptyString(value: unknown, path: string, name: string, issues: PlanValidationIssue[]): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(issue('missing_string', path, `${name} is required`))
  }
}

function validateStringArray(value: unknown, path: string, issues: PlanValidationIssue[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length > 0)) {
    issues.push(issue('invalid_string_array', path, 'must be an array of non-empty strings'))
    return []
  }
  return value as string[]
}

function issue(code: string, path: string, message: string): PlanValidationIssue {
  return { code, path, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
