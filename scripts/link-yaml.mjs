// Provision a workspace-local node_modules/yaml junction so esbuild's default
// resolver can inline the `yaml` package bundled from the harness pnpm store.
// Junction type requires no admin. Not committed (.gitignore excludes node_modules).
import { symlinkSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(ROOT, 'node_modules')
const target = 'D:/Apps/deepseek-harness/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml'
const link = join(nm, 'yaml')

if (!existsSync(target)) {
  console.error(`yaml store entry missing: ${target}`)
  process.exit(1)
}
mkdirSync(nm, { recursive: true })
try {
  if (existsSync(link)) { console.log('yaml junction exists'); process.exit(0) }
  symlinkSync(target, link, 'junction')
  console.log(`created junction ${link}`)
} catch (error) {
  console.error(`failed: ${error.message}`)
  process.exit(1)
}
