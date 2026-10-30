export interface HarNameValue {
  name?: unknown
  value?: unknown
}

export interface HarRequest {
  method?: unknown
  url?: unknown
  headers?: unknown
  queryString?: unknown
  postData?: unknown
}

export interface HarEntry {
  request?: unknown
}

export interface HarDocument {
  log?: {
    entries?: unknown
  }
}

export interface HarQueryParameter {
  name: string
  value: string
  sensitive: boolean
}

export interface HarHeader {
  name: string
  value: string
  sensitive: boolean
}

export interface ParsedHarRequest {
  order: number
  method: string
  url: string
  origin: string
  path: string
  query: HarQueryParameter[]
  headers: HarHeader[]
  body?: string
}

export interface ParsedHar {
  entries: ParsedHarRequest[]
}
