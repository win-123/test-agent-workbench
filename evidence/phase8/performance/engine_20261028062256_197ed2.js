import http from 'k6/http'
import { check } from 'k6'

export const options = {
  "scenarios": {
    "default": {
      "executor": "per-vu-iterations",
      "vus": 1,
      "iterations": 1
    }
  }
}

const requests = [
  {
    "method": "GET",
    "url": "http://127.0.0.1:8089/api/health?verbose=true",
    "headers": {
      "Accept": "application/json"
    }
  },
  {
    "method": "POST",
    "url": "http://127.0.0.1:8089/api/echo",
    "headers": {
      "Content-Type": "application/json"
    },
    "body": "{\"password\":\"[REDACTED]\",\"message\":\"hello\"}"
  },
  {
    "method": "GET",
    "url": "http://127.0.0.1:8089/api/fail",
    "headers": {}
  }
]
const correlations = []
const assertions = []
const variables = {}
const configuredHeaders = (() => {
  try {
    return JSON.parse(__ENV.TEST_AGENT_HEADERS || '{}')
  } catch (error) {
    throw new Error(`invalid TEST_AGENT_HEADERS JSON: ${error.message}`)
  }
})()

export default function () {
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]
    const applyVariables = (value) => {
      if (typeof value !== 'string') return value
      return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
        if (!(name in variables)) throw new Error(`missing correlation variable: ${name}`)
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
      if (value === undefined) throw new Error(`correlation extraction failed: ${correlation.jsonPath}`)
      variables[correlation.variableName] = String(value)
    }
  }
}

function getJsonPath(value, path) {
  if (!path.startsWith('$')) throw new Error(`invalid JSON path: ${path}`)
  let current = value
  for (const token of path.slice(1).split('.')) {
    if (token.length === 0) continue
    if (current === null || typeof current !== 'object') return undefined
    current = current[token]
  }
  return current
}
