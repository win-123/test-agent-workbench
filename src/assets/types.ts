import type { EngineKind } from '../engines/types.ts'

export const ASSET_SCHEMA_VERSION = 'test-agent.asset/v1' as const
export const ASSET_RUNS_SCHEMA_VERSION = 'test-agent.asset-runs/v1' as const

export type AssetKind = 'api' | 'ui' | 'performance'
export type AssetSourceFormat = 'har' | 'ui-case-json' | 'k6-js' | 'jmeter-jmx'
export type AssetExecution =
  | {
      mode: 'api-selection'
      har_path: string
      request_orders: number[]
    }
  | {
      mode: 'ui-case'
      case_id: string
      case_version: number
    }
  | {
      mode: 'performance-script'
      engine: EngineKind
      script_path: string
    }

export interface AssetEnvironment {
  name: string
  variable_refs: string[]
}

export interface TestAsset {
  schema_version: typeof ASSET_SCHEMA_VERSION
  asset_id: string
  name: string
  description?: string
  kind: AssetKind
  version: number
  source_format: AssetSourceFormat
  source_path: string
  execution: AssetExecution
  environment: AssetEnvironment
  credential_refs: string[]
  test_data_refs: string[]
  tags: string[]
  created_at: string
  updated_at: string
}

export interface AssetSummary {
  asset_id: string
  name: string
  kind: AssetKind
  version: number
  source_format: AssetSourceFormat
  source_path: string
  environment: string
  updated_at: string
  run_count: number
}

export interface AssetRunRecord {
  run_id: string
  task_id: string
  asset_id: string
  asset_version: number
  status: string
  started_at?: string
  finished_at?: string
  report_path?: string
  log_paths: string[]
  metrics: Record<string, number | null>
  recorded_at: string
}

export interface AssetRunHistory {
  schema_version: typeof ASSET_RUNS_SCHEMA_VERSION
  asset_id: string
  runs: AssetRunRecord[]
}

export interface AssetComparison {
  asset_id: string
  left: AssetRunRecord
  right: AssetRunRecord
  metrics: Array<{ name: string; left: number | null; right: number | null; delta: number | null; delta_percent: number | null }>
  facts: string[]
  caveats: string[]
}
