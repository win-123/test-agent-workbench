import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const signingIdentity = process.env.TEST_AGENT_MACOS_IDENTITY
const entitlements = join(root, 'desktop', 'entitlements.mac.plist')

export default {
  appId: 'com.testagent.workbench',
  productName: 'Test Agent Workbench',
  electronVersion: '44.7.0',
  electronDist: join(root, '.desktop-runtime', 'electron'),
  directories: {
    output: join(root, 'release'),
  },
  files: [
    'dist/desktop/**/*',
    'node_modules/playwright/**/*',
    'node_modules/playwright-core/**/*',
    'package.json',
  ],
  asar: true,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  extraMetadata: {
    main: 'dist/desktop/main.cjs',
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dir'],
    identity: signingIdentity ?? null,
    hardenedRuntime: signingIdentity !== undefined,
    entitlements,
    entitlementsInherit: entitlements,
    gatekeeperAssess: false,
  },
  publish: null,
}
