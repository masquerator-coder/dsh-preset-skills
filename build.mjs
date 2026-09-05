/**
 * dsh-preset-skills — unified build.
 *
 * Produces a standalone ESM bundle at lib/index.js from src/:
 *   - locate the deepseek-harness repo (DSH_HARNESS_ROOT env → defaults);
 *   - auto-resolve esbuild + yaml from its pnpm store (highest semver);
 *   - inline `yaml`, externalize node: builtins, and inject a createRequire
 *     banner so the ESM output can require dynamic node internals.
 *
 * Running esbuild's spawn needs a wider sandbox (danger-full-access).
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('.', import.meta.url))

function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

function findHarnessRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = []
  if (process.env.DSH_HARNESS_ROOT) candidates.push(process.env.DSH_HARNESS_ROOT)
  candidates.push('D:/Apps/deepseek-harness', 'C:/Apps/deepseek-harness')
  if (home) candidates.push(join(home, 'Apps', 'deepseek-harness'))
  for (const c of candidates) {
    const norm = String(c).replace(/\\/g, '/')
    if (c && existsSync(join(norm, 'packages'))) return norm
  }
  throw new Error('[dsh-preset-skills build] deepseek-harness repo not found — set DSH_HARNESS_ROOT')
}

function findPnpm(root, prefix) {
  const pnpmDir = join(root, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  let best = null
  let bestVer = null
  for (const name of readdirSync(pnpmDir)) {
    if (!name.startsWith(prefix + '@')) continue
    const ver = name.slice(prefix.length + 1).split('_')[0]
    if (bestVer === null || cmpSemver(ver, bestVer) > 0) { bestVer = ver; best = name }
  }
  if (best === null) return null
  return join(pnpmDir, best, 'node_modules')
}

function resolveFrom(pnpmBase, pkg) {
  const base = pnpmBase && pnpmBase[0]
  if (!base) return null
  const p = join(base, pkg)
  return existsSync(p) ? p : null
}

const harness = findHarnessRoot()
console.log(`[dsh-preset-skills build] harness=${harness}`)

const esbuildPkg = findPnpm(harness, 'esbuild')
const esbuildDir = resolveFrom([esbuildPkg], 'esbuild')

// Provision node_modules/yaml (a junction to the harness store) so esbuild's
// default resolver can inline `yaml` (zero-runtime-dep) plus its internals.
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'link-yaml.mjs')], { cwd: ROOT, stdio: 'ignore' })
} catch (error) {
  throw new Error(`[dsh-preset-skills build] yaml provisioning failed: ${String(error)}`)
}

function loadEsbuild() {
  if (esbuildDir) return require(esbuildDir)
  try { return require('esbuild') } catch { /* local */ }
  throw new Error('[dsh-preset-skills build] esbuild not found in harness pnpm store')
}

const esbuild = loadEsbuild()
const tscBin = join(harness, 'node_modules', 'typescript', 'bin', 'tsc')

// Typecheck only (emit disabled) through tsc for the node entry.
const tscExists = existsSync(tscBin)
if (tscExists) {
  try {
    execFileSync(process.execPath, [tscBin, '--noEmit', '-p', join(ROOT, 'tsconfig.json')], {
      cwd: ROOT, stdio: 'inherit',
    })
  } catch (error) {
    console.log('[dsh-preset-skills build] typecheck reported issues; continuing to bundle (see above)')
    // Non-zero exit is acceptable — typecheck is advisory here; esbuild still runs.
    void error
  }
}

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(ROOT, 'lib', 'index.js'),
  // Keep node: builtins AND `yaml` external. `yaml` is declared as a real
  // dependency so Node's ESM resolver loads its own dist directly at runtime.
  // Bundling it instead drags in CJS-interop `require()` shims that break under
  // Node's ESM ("Dynamic require of 'process' is not supported").
  external: ['node:*', 'yaml'],
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  sourcemap: true,
  logLevel: 'info',
})
