import * as dns from 'node:dns/promises'
import * as net from 'node:net'

export interface TargetPolicy {
  allowedOrigins: string[]
  baseUrl: string
  allowedPaths?: string[]
}

type Lookup = (hostname: string) => Promise<Array<{ address: string }>>

export const DEFAULT_ALLOWED_ORIGINS = ['http://127.0.0.1:8089']

export function createTargetPolicy(baseUrl: string, allowedOrigins: string[] = DEFAULT_ALLOWED_ORIGINS): TargetPolicy {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('base_url is required')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`invalid base_url: ${baseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`base_url protocol must be http or https, got ${parsed.protocol}`)
  }
  const targetOrigin = parsed.origin
  if (allowedOrigins.length === 0 || !allowedOrigins.includes(targetOrigin)) {
    throw new Error(`target origin is not whitelisted: ${targetOrigin}`)
  }
  return { allowedOrigins: [...allowedOrigins], baseUrl: parsed.toString().replace(/\/$/, '') }
}

export function isOriginAllowed(origin: string, policy: TargetPolicy): boolean {
  return policy.allowedOrigins.includes(origin)
}

export async function assertTargetNetworkAllowed(baseUrl: string, lookup: Lookup = defaultLookup): Promise<void> {
  const url = new URL(baseUrl)
  if (url.username !== '' || url.password !== '') throw new Error('target URL must not contain credentials')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('target URL must use http or https')

  const literalFamily = net.isIP(url.hostname)
  if (literalFamily !== 0) return
  if (isExplicitLocalHostname(url.hostname)) return

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(url.hostname)
  } catch {
    // fetch will provide the diagnostic when resolution itself fails.
    return
  }
  const sensitive = addresses.map(item => item.address).filter(isSensitiveIpAddress)
  if (sensitive.length > 0) {
    throw new Error(`public target resolves to a local or private address: ${url.hostname}`)
  }
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return await dns.lookup(hostname, { all: true, verbatim: true })
}

function isExplicitLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')
}

function isSensitiveIpAddress(value: string): boolean {
  const address = value.toLowerCase()
  if (address === '::1' || address === '::' ) return true
  if (address.startsWith('fe80:')) return true
  if (address.startsWith('fc') || address.startsWith('fd')) return true

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped !== null) return isPrivateIPv4(mapped[1]!)
  if (net.isIPv4(address)) return isPrivateIPv4(address)
  return false
}

function isPrivateIPv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [first, second] = parts as [number, number, number, number]
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224
}
