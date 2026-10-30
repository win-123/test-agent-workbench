import type { ParsedHar, ParsedHarRequest } from '../har/types.ts'
import { createTargetPolicy } from '../api/policy.ts'
import type { AssertionConfig } from '../api/assertions.ts'

export interface K6Options {
  baseUrl: string
  allowedOrigins?: string[]
  vus?: number
  iterations?: number
  duration?: string
  assertions?: AssertionConfig[]
  correlations?: CorrelationConfig[]
}

export interface CorrelationConfig {
  sourceIndex: number
  jsonPath: string
  variableName: string
  targetIndexes: number[]
  targetHeaders?: Array<{ index: number; name: string; value?: string }>
}

export function generateK6Script(har: ParsedHar, options: K6Options): string {
  const policy = createTargetPolicy(options.baseUrl, options.allowedOrigins)
  const baseUrl = new URL(policy.baseUrl)
  const requestCount = har.entries.length
  const scenarioIterations = options.duration !== undefined
    ? undefined
    : Math.max(1, Math.ceil((options.iterations ?? 1) / Math.max(1, requestCount)))
  const scenarios = options.duration !== undefined
    ? { default: { executor: 'constant-vus', vus: options.vus ?? 1, duration: options.duration } }
    : { default: { executor: 'per-vu-iterations', vus: options.vus ?? 1, iterations: scenarioIterations } }
  return `import http from 'k6/http'
import { check } from 'k6'

export const options = ${JSON.stringify({ scenarios }, null, 2)}

const requests = ${JSON.stringify(har.entries.map(request => toK6Request(request, baseUrl)), null, 2)}
const correlations = ${JSON.stringify(options.correlations ?? [], null, 2)}
const assertions = ${JSON.stringify(options.assertions ?? [], null, 2)}
const variables = {}
const configuredHeaders = (() => {
  try {
    return JSON.parse(__ENV.TEST_AGENT_HEADERS || '{}')
  } catch (error) {
    throw new Error(\`invalid TEST_AGENT_HEADERS JSON: \${error.message}\`)
  }
})()

export default function () {
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]
    const applyVariables = (value) => {
      if (typeof value !== 'string') return value
      return value.replace(/\\$\\{([^}]+)\\}/g, (match, name) => {
        if (!(name in variables)) throw new Error(\`missing correlation variable: \${name}\`)
        return variables[name]
      })
    }
    const url = applyVariables(request.url)
    const body = request.body === undefined ? undefined : applyVariables(request.body)
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, applyVariables(value)]))
    Object.assign(headers, configuredHeaders)
    const response = http.request(request.method, url, body, { headers })
    const checks = { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 }
    check(response, checks)
    const config = assertions.find(item => item.index === index)
    if (config !== undefined) {
      check(response, {
        'status equals': (r) => config.status === undefined || r.status === config.status,
        'body contains': (r) => config.contains === undefined || r.body.includes(config.contains),
        'json equals': (r) => config.jsonPath === undefined || JSON.stringify(getJsonPath(JSON.parse(r.body), config.jsonPath)) === JSON.stringify(config.equals),
      })
    }
    for (const correlation of correlations.filter(item => item.sourceIndex === index)) {
      const value = getJsonPath(JSON.parse(response.body), correlation.jsonPath)
      if (value === undefined) throw new Error(\`correlation extraction failed: \${correlation.jsonPath}\`)
      variables[correlation.variableName] = String(value)
    }
  }
}

function getJsonPath(value, path) {
  if (!path.startsWith('$')) throw new Error(\`invalid JSON path: \${path}\`)
  let current = value
  for (const token of path.slice(1).split('.')) {
    if (token.length === 0) continue
    if (current === null || typeof current !== 'object') return undefined
    current = current[token]
  }
  return current
}
`
}

function toK6Request(request: ParsedHarRequest, baseUrl: URL) {
  const target = new URL(request.url)
  const [path, search = ''] = request.path.split('?')
  const selected = new URL(baseUrl.toString())
  selected.pathname = joinPath(baseUrl.pathname, path)
  selected.search = search
  return {
    method: request.method,
    url: restoreCorrelationPlaceholder(selected.toString()),
    headers: Object.fromEntries(request.headers.filter(header => !header.sensitive).map(header => [header.name, header.value])),
    body: request.body,
  }
}

function restoreCorrelationPlaceholder(value: string): string {
  return value.replaceAll('$%7B', '${').replaceAll('%7D', '}')
}

function joinPath(basePath: string, requestPath: string): string {
  const left = basePath.replace(/\/$/, '')
  const right = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  return `${left}${right}` || '/'
}
