import { describe, expect, it } from 'vitest'
import { assertTargetNetworkAllowed, createTargetPolicy } from '../../src/api/policy.ts'

describe('target network policy', () => {
  it('allows explicitly addressed loopback targets', async () => {
    const policy = createTargetPolicy('http://127.0.0.1:8089', ['http://127.0.0.1:8089'])
    await expect(assertTargetNetworkAllowed(policy.baseUrl)).resolves.toBeUndefined()
  })

  it('blocks public names that resolve to private or link-local addresses', async () => {
    const lookup = async (hostname: string) => {
      expect(hostname).toBe('public.example.test')
      return [{ address: '192.168.1.10' }]
    }
    await expect(assertTargetNetworkAllowed('https://public.example.test', lookup)).rejects.toThrow('local or private')
    await expect(assertTargetNetworkAllowed('https://public.example.test', async () => [{ address: 'fe80::1' }]))
      .rejects.toThrow('local or private')
  })

  it('allows explicit local names but rejects unsafe origins and redirects by policy', async () => {
    await expect(assertTargetNetworkAllowed('http://my-server.local:8080')).resolves.toBeUndefined()
    const policy = createTargetPolicy('https://api.example.test', ['https://api.example.test'])
    expect(policy.allowedOrigins).toEqual(['https://api.example.test'])
    expect(policy.allowedOrigins.includes('https://evil.example.test')).toBe(false)
  })
})
