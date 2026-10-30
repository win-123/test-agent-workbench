import { UI_CASE_SCHEMA_VERSION, type UiTestCase } from '../../src/ui/types.ts'

export function validCase(overrides: Partial<UiTestCase> = {}): UiTestCase {
  return {
    schema_version: UI_CASE_SCHEMA_VERSION,
    case_id: 'ui-validation',
    name: 'UI validation',
    version: 1,
    target_url: 'http://127.0.0.1:8090/',
    allowed_origins: ['http://127.0.0.1:8090'],
    timeout_ms: 5000,
    headless: true,
    steps: [{
      id: 'open',
      action: 'navigate',
      url: 'http://127.0.0.1:8090/',
    }],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
