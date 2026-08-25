import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bodyDir = resolve(root, 'dist/client-body')
const body = await readFile(resolve(bodyDir, 'client.js'), 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  '  id: "@dshserver/dsh-deliverables",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/client.js'), wrapped)
await rm(bodyDir, { recursive: true, force: true })
