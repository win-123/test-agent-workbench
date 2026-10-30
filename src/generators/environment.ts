export interface EnvironmentConfig {
  baseUrl: string
  headers?: Record<string, string>
}

export function parseEnvironmentConfig(input: string): EnvironmentConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new Error(`invalid environment config JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { baseUrl?: unknown }).baseUrl !== 'string') {
    throw new Error('environment config must contain a string baseUrl')
  }
  const rawHeaders = (parsed as { headers?: unknown }).headers
  if (rawHeaders !== undefined && (rawHeaders === null || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders))) {
    throw new Error('environment config headers must be an object')
  }
  const headers = rawHeaders === undefined ? undefined : Object.fromEntries(
    Object.entries(rawHeaders as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  )
  return { baseUrl: (parsed as { baseUrl: string }).baseUrl, headers }
}

export function environmentHeaderKeys(config: EnvironmentConfig): string[] {
  return Object.keys(config.headers ?? {})
}

export function toK6Environment(config: EnvironmentConfig): string {
  return JSON.stringify({
    TEST_AGENT_BASE_URL: config.baseUrl,
    TEST_AGENT_HEADERS: JSON.stringify(config.headers ?? {}),
  }, null, 2)
}

export function toJMeterProperties(config: EnvironmentConfig): string {
  const url = new URL(config.baseUrl)
  const lines = [
    `test.agent.protocol=${url.protocol.replace(':', '')}`,
    `test.agent.host=${url.hostname}`,
    `test.agent.port=${url.port || (url.protocol === 'https:' ? '443' : '80')}`,
    `test.agent.path.prefix=${url.pathname.replace(/\/$/, '')}`,
  ]
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    lines.push(`test.agent.header.${key}=${value}`)
  }
  return `${lines.join('\n')}\n`
}

export function toPostmanEnvironment(config: EnvironmentConfig): string {
  return `${JSON.stringify({
    name: 'test-agent environment',
    values: [
      { key: 'baseUrl', value: config.baseUrl, enabled: true },
      ...Object.entries(config.headers ?? {}).map(([key, value]) => ({
        key: headerVariableName(key),
        value,
        enabled: true,
      })),
    ],
  }, null, 2)}\n`
}

export function headerVariableName(headerName: string): string {
  return headerName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}
