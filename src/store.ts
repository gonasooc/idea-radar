import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Item, Manifest, SourceKey } from './types.ts'
import { SourceError } from './types.ts'

const ROOT = process.env.IDEA_RADAR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DATA_DIR = path.join(ROOT, 'site', 'data')
export const SEEN_DIR = path.join(ROOT, 'state', 'seen')

export function serializeRows(rows: unknown[]): string {
  if (rows.length === 0) return '[]\n'
  return '[\n' + rows.map((r, i) => (i === 0 ? '' : ',') + JSON.stringify(r)).join('\n') + '\n]\n'
}

export async function writeJsonAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, content, 'utf8')
  JSON.parse(await readFile(tmp, 'utf8'))
  await rename(tmp, file)
}

async function readJson(file: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return JSON.parse(text)
}

export function shardPath(monthKey: string, showhn: boolean): string {
  return path.join(DATA_DIR, monthKey + (showhn ? '.showhn' : '') + '.json')
}

export async function readShard(monthKey: string, showhn: boolean): Promise<Item[]> {
  const data = await readJson(shardPath(monthKey, showhn))
  if (data === undefined) return []
  if (!Array.isArray(data)) throw new Error(`shard ${monthKey} is not an array`)
  return data as Item[]
}

export async function writeShard(monthKey: string, showhn: boolean, items: Item[]): Promise<void> {
  await writeJsonAtomic(shardPath(monthKey, showhn), serializeRows(items))
}

export type SeenLoad = { state: 'ok' | 'missing' | 'corrupt'; ids: Set<string> }

export async function loadSeen(source: SourceKey): Promise<SeenLoad> {
  const file = path.join(SEEN_DIR, source + '.json')
  let data: unknown
  try {
    data = await readJson(file)
  } catch {
    return { state: 'corrupt', ids: new Set() }
  }
  if (data === undefined) return { state: 'missing', ids: new Set() }
  if (!Array.isArray(data) || data.some((v) => typeof v !== 'string')) {
    return { state: 'corrupt', ids: new Set() }
  }
  return { state: 'ok', ids: new Set(data as string[]) }
}

export async function writeSeen(source: SourceKey, ids: Set<string>): Promise<void> {
  const sorted = [...ids].sort()
  await writeJsonAtomic(path.join(SEEN_DIR, source + '.json'), serializeRows(sorted))
}

export type DiskMonth = { key: string; hasShowhn: boolean }

export async function listMonths(): Promise<DiskMonth[]> {
  let names: string[]
  try {
    names = await readdir(DATA_DIR)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const months = new Map<string, DiskMonth>()
  for (const n of names) {
    const m = /^(\d{4}-\d{2})(\.showhn)?\.json$/.exec(n)
    if (!m) continue
    const entry = months.get(m[1]) ?? { key: m[1], hasShowhn: false }
    if (m[2]) entry.hasShowhn = true
    months.set(m[1], entry)
  }
  return [...months.values()].sort((a, b) => (a.key < b.key ? 1 : -1))
}

export async function readManifest(): Promise<Manifest | undefined> {
  const data = await readJson(path.join(DATA_DIR, 'manifest.json'))
  return data as Manifest | undefined
}

export async function writeManifest(m: Manifest): Promise<void> {
  await writeJsonAtomic(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
}

export async function rebuildLatest(nowMs: number): Promise<void> {
  const cutoff = new Date(nowMs - 30 * 24 * 3600 * 1000).toISOString()
  const months = (await listMonths()).slice(0, 2)
  const out: Item[] = []
  for (const m of [...months].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const items = await readShard(m.key, false)
    for (const it of items) if (it.collectedAt >= cutoff) out.push(it)
  }
  await writeJsonAtomic(path.join(DATA_DIR, 'latest.json'), serializeRows(out))
}

export async function verifyDataDir(): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(DATA_DIR)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      JSON.parse(await readFile(path.join(DATA_DIR, n), 'utf8'))
    } catch (e) {
      throw new SourceError('parse', `site/data/${n} is not valid JSON: ${(e as Error).message}`)
    }
  }
}
