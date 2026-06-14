// 把 hook-scripts plugin 复制进 jixu 包的 plugin/，使发布后 `jixu init` 能找到它。
// 在 prepack 时运行（npm pack / npm publish 都会触发）。
import { cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', '..', 'hook-scripts')
const dest = join(here, '..', 'plugin')

mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`bundled hook plugin: ${src} -> ${dest}`)
