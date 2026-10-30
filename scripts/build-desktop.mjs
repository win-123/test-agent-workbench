import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = join(root, 'dist', 'desktop')

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(join(outputDirectory, 'renderer'), { recursive: true })

await Promise.all([
  build({
    entryPoints: [join(root, 'desktop', 'main.ts')],
    outfile: join(outputDirectory, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Playwright ships optional native/dynamic dependencies. Keep the package
    // external and package it with the app instead of forcing it into one CJS file.
    external: ['electron', 'playwright'],
    sourcemap: true,
    logLevel: 'info',
  }),
  build({
    entryPoints: [join(root, 'desktop', 'preload.ts')],
    outfile: join(outputDirectory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  }),
  build({
    entryPoints: [join(root, 'desktop', 'renderer', 'app.ts')],
    outfile: join(outputDirectory, 'renderer', 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    sourcemap: true,
    logLevel: 'info',
  }),
])

await Promise.all([
  cp(join(root, 'desktop', 'renderer', 'index.html'), join(outputDirectory, 'renderer', 'index.html')),
  cp(join(root, 'desktop', 'renderer', 'styles.css'), join(outputDirectory, 'renderer', 'styles.css')),
])

console.log(`desktop build complete: ${outputDirectory}`)
