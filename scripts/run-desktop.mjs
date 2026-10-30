import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const binary = join(root, '.desktop-runtime', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const prepare = spawn(process.execPath, [join(root, 'scripts', 'prepare-electron.mjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
})
let output = ''
prepare.stdout.setEncoding('utf8')
prepare.stdout.on('data', chunk => { output += chunk })
const prepareCode = await new Promise(resolve => prepare.once('exit', resolve))
if (prepareCode !== 0) process.exit(prepareCode ?? 1)
const resolvedBinary = output.trim().split('\n').at(-1) || binary

const build = spawn(process.execPath, [join(root, 'scripts', 'build-desktop.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
const buildCode = await new Promise(resolve => build.once('exit', resolve))
if (buildCode !== 0) process.exit(buildCode ?? 1)

const child = spawn(resolvedBinary, [join(root, 'dist', 'desktop', 'main.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_AGENT_K6_PATH: process.env.TEST_AGENT_K6_PATH ?? '/Users/ztl/Downloads/k6-v1.8.2-macos-arm64/k6',
    TEST_AGENT_JMETER_PATH: process.env.TEST_AGENT_JMETER_PATH ?? '/Users/ztl/Downloads/apache-jmeter-5.6.3/bin/jmeter',
  },
})
const code = await new Promise(resolve => child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))))
process.exit(code)
