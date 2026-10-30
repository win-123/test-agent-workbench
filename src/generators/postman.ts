import type { ParsedHar, ParsedHarRequest } from '../har/types.ts'
import { createTargetPolicy } from '../api/policy.ts'

export interface PostmanOptions {
  baseUrl: string
  allowedOrigins?: string[]
}

interface PostmanCollection {
  info: {
    name: string
    schema: string
  }
  item: Array<{
    name: string
    request: {
      method: string
      header: Array<{ key: string; value: string }>
      url: {
        raw: string
        host: string[]
        path: string[]
        query: Array<{ key: string; value: string }>
      }
      body?: {
        mode: 'raw'
        raw: string
        options: { raw: { language: string } }
      }
    }
  }>
}

export function generatePostmanCollection(har: ParsedHar, options: PostmanOptions): string {
  createTargetPolicy(options.baseUrl, options.allowedOrigins)
  const collection: PostmanCollection = {
    info: {
      name: `HAR Replay ${new URL(options.baseUrl).host}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: har.entries.map((request, index) => toItem(request, options.baseUrl, index)),
  }
  return `${JSON.stringify(collection, null, 2)}\n`
}

function toItem(request: ParsedHarRequest, baseUrl: string, index: number): PostmanCollection['item'][number] {
  const target = mapTarget(new URL(baseUrl), request)
  const headers = request.headers
    .filter(header => !header.sensitive)
    .map(header => ({ key: header.name, value: header.value }))
  const body = request.body === undefined ? undefined : {
    mode: 'raw' as const,
    raw: request.body,
    options: { raw: { language: 'json' } },
  }
  return {
    name: `${request.method} ${target.pathname} ${index + 1}`,
    request: {
      method: request.method,
      header: headers,
      url: {
        raw: target.toString(),
        host: splitHost(target),
        path: target.pathname.split('/').filter(Boolean),
        query: [...target.searchParams].map(([key, value]) => ({ key, value })),
      },
      ...(body === undefined ? {} : { body }),
    },
  }
}

function mapTarget(base: URL, request: ParsedHarRequest): URL {
  const original = new URL(request.url)
  const target = new URL(base.toString())
  target.pathname = joinPath(base.pathname, original.pathname)
  target.search = original.search
  return target
}

function joinPath(basePath: string, requestPath: string): string {
  const left = basePath.replace(/\/$/, '')
  const right = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  return `${left}${right}` || '/'
}

function splitHost(url: URL): string[] {
  const scheme = `${url.protocol}//`
  return [scheme, url.host]
}
