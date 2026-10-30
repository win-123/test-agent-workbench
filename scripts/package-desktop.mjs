import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
run(process.execPath, [join(root, 'scripts', 'prepare-electron.mjs')])
run(process.execPath, [join(root, 'scripts', 'build-desktop.mjs')])

const staging = await mkdtemp(join(tmpdir(), 'test-agent-desktop-package-'))
await mkdir(join(staging, 'dist'), { recursive: true })
await cp(join(root, 'dist', 'desktop'), join(staging, 'dist', 'desktop'), { recursive: true })
await copyRuntimePackage(staging, 'playwright')
await copyRuntimePackage(staging, 'playwright-core')
await writeFile(join(staging, 'package.json'), `${JSON.stringify({
  name: 'test-agent-workbench',
  version: '0.1.0',
  private: true,
  description: 'Local desktop workbench for DeepSeek Harness API, load and Agent test orchestration.',
  author: 'Test Agent',
  main: 'dist/desktop/main.cjs',
  dependencies: {
    playwright: '1.61.1',
  },
}, null, 2)}\n`)

run(process.execPath, [
  join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--projectDir', staging,
  '--arm64',
  '--publish', 'never',
  '--config', join(root, 'desktop', 'electron-builder.mjs'),
], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
})
const app = join(root, 'release', 'mac-arm64', 'Test Agent Workbench.app')
const archive = join(root, 'release', 'Test Agent Workbench-0.1.0-arm64-mac.zip')
await rm(archive, { force: true })
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])

// Build a deterministic DMG with the system hdiutil: the image contains the app
// plus an /Applications symlink for drag-to-install. This avoids electron-builder's
// dmgbuild bundle, which can hang silently in some local macOS environments.
const dmgStaging = await mkdtemp(join(tmpdir(), 'test-agent-desktop-dmg-'))
run('ditto', [app, join(dmgStaging, 'Test Agent Workbench.app')])
run('ln', ['-s', '/Applications', join(dmgStaging, 'Applications')])
const dmg = join(root, 'release', 'Test Agent Workbench-0.1.0-arm64.dmg')
await rm(dmg, { force: true })
run('hdiutil', ['create', '-volname', 'Test Agent Workbench', '-format', 'UDZO', '-srcfolder', dmgStaging, '-ov', dmg])
await rm(dmgStaging, { recursive: true, force: true })
await rm(staging, { recursive: true, force: true })

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function copyRuntimePackage(staging, packageName) {
  const rootRequire = createRequire(import.meta.url)
  const playwrightRequire = createRequire(rootRequire.resolve('playwright/package.json'))
  const resolver = packageName === 'playwright' ? rootRequire : playwrightRequire
  const packageJson = resolver.resolve(`${packageName}/package.json`)
  const source = dirname(packageJson)
  const destination = join(staging, 'node_modules', packageName)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
}
