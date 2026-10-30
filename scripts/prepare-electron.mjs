import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeDirectory = join(root, '.desktop-runtime', 'electron')
const binary = join(runtimeDirectory, 'Electron.app', 'Contents', 'MacOS', 'Electron')

if (await exists(binary)) {
  console.log(binary)
  process.exit(0)
}

await rm(runtimeDirectory, { recursive: true, force: true })
await mkdir(runtimeDirectory, { recursive: true })

const installedPath = join(root, 'node_modules', 'electron', 'path.txt')
if (await exists(installedPath)) {
  const relativeBinary = (await readFile(installedPath, 'utf8')).trim()
  const installedBinary = join(root, 'node_modules', 'electron', relativeBinary)
  if (await exists(installedBinary)) {
    console.log(installedBinary)
    process.exit(0)
  }
}

const cacheRoot = join(homedir(), 'Library', 'Caches', 'electron')
const zip = await findCachedZip(cacheRoot)
if (zip === undefined) {
  throw new Error('Electron runtime is not installed and no cached darwin-arm64 zip was found')
}
const result = spawnSync('ditto', ['-x', '-k', zip, runtimeDirectory], { stdio: 'inherit' })
if (result.status !== 0 || !(await exists(binary))) {
  throw new Error(`failed to extract Electron runtime from ${zip}`)
}
console.log(binary)

async function findCachedZip(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = await findCachedZip(path)
      if (found !== undefined) return found
    } else if (/^electron-v44\.7\.\d+-darwin-arm64\.zip$/.test(entry.name)) {
      return path
    }
  }
  return undefined
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
