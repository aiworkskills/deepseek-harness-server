/**
 * Pre-publish gate for the three public packages.
 *
 * Checks the boundary that `pnpm check` cannot: that every package is
 * publishable, that its tarball contains what it claims and nothing more, that
 * the workspace agrees on one version, and that no credential-shaped string
 * reached the tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const errors = []
const notes = []

const fail = message => { errors.push(message) }
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))

/* ------------------------------------------------------ repository files -- */

for (const path of [
  'LICENSE', 'README.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md',
  '.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/dependabot.yml',
  'docs/ARCHITECTURE.md', 'docs/compatibility.md', 'docs/configuration.md',
  'docs/integration.md', 'docs/security-model.md', 'docs/tools-and-api.md',
  'examples/local-smoke/smoke.mjs',
]) {
  if (!existsSync(join(root, path))) fail(`缺少发布文件: ${path}`)
}

const rootPackage = readJson('package.json')
if (rootPackage.private !== true) fail('工作区根 package.json 必须保持 private=true')
if (rootPackage.license !== 'MIT') fail('根 package.json 必须声明 MIT License')

/* --------------------------------------------------------- public packages -- */

const publicPackages = [
  'packages/dsh-integration',
  'packages/runtime-gateway',
  'packages/dsh-preferences',
]

const versions = new Set()

for (const packageDir of publicPackages) {
  const manifest = readJson(`${packageDir}/package.json`)
  versions.add(manifest.version)

  if (manifest.private === true) fail(`${manifest.name} 仍被标记为 private`)
  if (manifest.license !== 'MIT') fail(`${manifest.name} 未声明 MIT License`)
  if (manifest.publishConfig?.access !== 'public') fail(`${manifest.name} 未声明 public publishConfig`)
  if (!manifest.repository?.url) fail(`${manifest.name} 缺少 repository 字段`)
  if (!manifest.bugs?.url) fail(`${manifest.name} 缺少 bugs 字段`)

  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      if (/^(?:file:|link:|workspace:)/.test(String(version))) {
        fail(`${manifest.name} 的 ${group}.${name} 使用不可发布依赖 ${version}`)
      }
    }
  }

  const exportTargets = new Set([manifest.main, manifest.types])
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') exportTargets.add(value)
    else if (value && typeof value === 'object') {
      for (const target of Object.values(value)) exportTargets.add(target)
    }
  }
  for (const target of exportTargets) {
    if (typeof target !== 'string' || target === './package.json') continue
    if (!existsSync(join(root, packageDir, target))) fail(`${manifest.name} 缺少 export 目标 ${target}`)
  }

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(root, packageDir), encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'silent' },
  })
  if (packed.status !== 0) {
    fail(`${manifest.name} 无法执行 npm pack --dry-run: ${packed.stderr.trim()}`)
    continue
  }
  try {
    const result = JSON.parse(packed.stdout)[0]
    const packedFiles = new Set(result.files.map(file => file.path))
    for (const file of ['package.json', 'README.md', 'LICENSE']) {
      if (!packedFiles.has(file)) fail(`${manifest.name} 的 npm 包缺少 ${file}`)
    }
    if ([...packedFiles].some(file => /(?:^|\/)src\//.test(file) || /\.spec\.[cm]?[jt]s$/.test(file))) {
      fail(`${manifest.name} 的 npm 包包含 src 或测试产物`)
    }
    notes.push(`${manifest.name}@${manifest.version}: ${result.entryCount} files, ${result.unpackedSize} bytes unpacked`)
  } catch (error) {
    fail(`${manifest.name} 的 npm pack 输出无法解析: ${error.message}`)
  }
}

if (versions.size !== 1) {
  fail(`三个公开包必须锁步发版，当前版本为 ${[...versions].join(', ')}`)
}

/* ------------------------------------------------------------ secret scan -- */

const excludedDirectories = new Set(['.git', 'node_modules', 'dist'])
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml',
])
const secretPatterns = [
  ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI/DeepSeek 风格密钥', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub Token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ['npm Token', /\bnpm_[A-Za-z0-9]{36}\b/],
]

function scanDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      scanDirectory(path)
      continue
    }
    if (entry.name === '.env' || entry.name.endsWith('.log')) continue
    if (!textExtensions.has(extname(entry.name))) continue
    const content = readFileSync(path, 'utf8')
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(content)) fail(`${relative(root, path)} 包含疑似${label}`)
    }
  }
}

scanDirectory(root)

const gitignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)
for (const ignored of ['node_modules/', 'dist/', '.env']) {
  if (!gitignore.includes(ignored)) fail(`.gitignore 缺少 ${ignored}`)
}

/* ------------------------------------------------------------- doc anchors -- */

const compatibility = readFileSync(join(root, 'docs/compatibility.md'), 'utf8')
const integrationManifest = readJson('packages/dsh-integration/package.json')
const pinnedDshVersion = integrationManifest.devDependencies?.['@deepseek-ai/dsh-tools']
if (pinnedDshVersion && !compatibility.includes(pinnedDshVersion)) {
  fail(`docs/compatibility.md 未记录当前验证的 DSH 版本 ${pinnedDshVersion}`)
}

/* ----------------------------------------------------------------- report -- */

if (errors.length > 0) {
  console.error(`Release check failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log('Release check passed')
for (const note of notes) console.log(`- ${note}`)
