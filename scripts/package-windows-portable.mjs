import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = '44.7.2'
const zipName = `electron-v${version}-win32-x64.zip`
const cacheDirectory = join(homedir(), 'Library', 'Caches', 'electron')
const cacheZip = join(cacheDirectory, zipName)
const downloadUrls = [
  `https://npmmirror.com/mirrors/electron/${version}/${zipName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${zipName}`,
]
const releaseDirectory = join(root, 'release', 'win-x64-portable')
const archive = join(root, 'release', 'Test Agent Workbench-0.1.0-win-x64-portable.zip')

run(process.execPath, [join(root, 'scripts', 'build-desktop.mjs')])

if (!(await exists(cacheZip))) {
  await mkdir(cacheDirectory, { recursive: true })
  let downloaded = false
  let lastError = undefined
  for (const url of downloadUrls) {
    console.log(`Downloading ${url}`)
    const result = spawnSync('curl', ['-L', '--fail', '--retry', '2', '--connect-timeout', '20', '-sS', '-o', cacheZip, url], { cwd: root, stdio: 'inherit' })
    if (result.status === 0 && await exists(cacheZip)) { downloaded = true; break }
    lastError = result.error ?? new Error(`curl exited with ${result.status}`)
    await rm(cacheZip, { force: true })
  }
  if (!downloaded) throw lastError ?? new Error('failed to download Electron win32-x64 runtime')
}

const staging = await mkdtemp(join(tmpdir(), 'test-agent-windows-portable-'))
const runtime = join(staging, 'runtime')
const appDirectory = join(staging, 'Test Agent Workbench')
await mkdir(runtime, { recursive: true })
run('unzip', ['-q', cacheZip, '-d', runtime])

const electronExe = join(runtime, 'electron.exe')
if (!(await exists(electronExe))) throw new Error(`unexpected Electron win32 archive: ${zipName}`)

await mkdir(appDirectory, { recursive: true })
await copyDirectory(runtime, appDirectory)
await rm(join(appDirectory, 'resources', 'default_app.asar'), { force: true })

await mkdir(join(appDirectory, 'resources', 'app'), { recursive: true })
await cp(join(root, 'dist', 'desktop'), join(appDirectory, 'resources', 'app', 'dist', 'desktop'), { recursive: true })
await copyRuntimePackage(join(appDirectory, 'resources', 'app'))
await writeFile(join(appDirectory, 'resources', 'app', 'package.json'), `${JSON.stringify({
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
run('mv', [join(appDirectory, 'electron.exe'), join(appDirectory, 'Test Agent Workbench.exe')])

await rm(archive, { force: true })
run('zip', ['-r', '-q', '-X', archive, 'Test Agent Workbench'], { cwd: staging })
await rm(releaseDirectory, { recursive: true, force: true })
await cp(appDirectory, releaseDirectory, { recursive: true })
await rm(staging, { recursive: true, force: true })

const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
console.log(`Windows portable archive: ${archive}`)
console.log(`SHA256: ${digest}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function copyDirectory(source, destination) {
  await cp(source, destination, { recursive: true })
}

async function copyRuntimePackage(appRoot) {
  const rootRequire = createRequire(import.meta.url)
  const playwrightRequire = createRequire(rootRequire.resolve('playwright/package.json'))
  for (const packageName of ['playwright', 'playwright-core']) {
    const resolver = packageName === 'playwright' ? rootRequire : playwrightRequire
    const packageJson = resolver.resolve(`${packageName}/package.json`)
    const source = dirname(packageJson)
    const destination = join(appRoot, 'node_modules', packageName)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true, dereference: true })
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
