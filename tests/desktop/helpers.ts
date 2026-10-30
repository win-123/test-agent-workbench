import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SaveProjectConfigInput } from '../../src/desktop/types.ts'

export function validConfig(baseUrl: string): SaveProjectConfigInput {
  return {
    target: {
      baseUrl,
      allowedOrigins: [baseUrl],
      allowedPaths: [],
    },
    environment: { headers: { Accept: 'application/json' } },
    api: {
      timeoutMs: 2000,
      concurrency: 1,
      assertions: [],
    },
    performance: {
      engine: 'k6',
      vus: 1,
      duration: '',
      iterations: 1,
      timeoutMs: 5000,
      enginePaths: {},
    },
    correlations: [],
    authorization: {
      confirmed: true,
      scope: 'Local fixture only',
    },
  }
}

export async function fakeEngine(directory: string, mode: 'pass' | 'slow'): Promise<string> {
  const path = join(directory, `fake-${mode}-k6`)
  const script = mode === 'pass'
    ? `#!/bin/sh
if [ "$1" = "version" ]; then echo "k6 v0.0.0-fake"; exit 0; fi
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--summary-export" ]; then shift; out="$1"; fi
  shift
done
printf '%s' '{"metrics":{"http_reqs":{"count":2,"rate":2},"http_req_failed":{"value":0.5},"http_req_duration":{"avg":5,"p(90)":8,"p(95)":9,"p(99)":10},"checks":{"passes":1,"fails":1}}}' > "$out"
exit 0
`
    : `#!/bin/sh
if [ "$1" = "version" ]; then echo "k6 v0.0.0-fake"; exit 0; fi
sleep 30
`
  await writeFile(path, script)
  await chmod(path, 0o755)
  return path
}
