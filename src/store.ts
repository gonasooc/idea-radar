import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Item, Manifest, SourceKey } from './types.ts'
import { SOURCE_KEYS, SourceError } from './types.ts'

const ROOT = process.env.IDEA_RADAR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DATA_DIR = path.join(ROOT, 'site', 'data')
export const SEEN_DIR = path.join(ROOT, 'state', 'seen')

export function serializeRows(rows: unknown[]): string {
  if (rows.length === 0) return '[]\n'
  return '[\n' + rows.map((r, i) => (i === 0 ? '' : ',') + JSON.stringify(r)).join('\n') + '\n]\n'
}

// 키 1개 = 1줄, 키 정렬. serializeRows와 같은 이유다 — 이 파일은 매 실행 전체가 다시 쓰이므로
// 줄 단위로 나눠야 git 델타가 '점수가 바뀐 줄'만큼으로 줄어든다.
export function serializeScores(scores: Record<string, number>): string {
  const keys = Object.keys(scores).sort()
  if (keys.length === 0) return '{}\n'
  return '{\n' + keys.map((k, i) => (i === 0 ? '' : ',') + JSON.stringify(k) + ':' + scores[k]).join('\n') + '\n}\n'
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

export const SHOWHN_SCORES_FILE = 'showhn-scores.json'

export async function writeShowhnScores(scores: Record<string, number>): Promise<void> {
  await writeJsonAtomic(path.join(DATA_DIR, SHOWHN_SCORES_FILE), serializeScores(scores))
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

// 소스별로 아카이브에 마지막으로 들어온 항목의 collectedDate. "며칠째 신규 0건인가"의 근거다.
//
// 최근 2개 월 샤드만 읽는다. 경고 임계값이 최대 14일인데 2개월 창은 항상 28일 이상을 덮으므로
// 답이 창 안에서 나오고, 창 안에 없으면 "임계값보다 오래됨"이 이미 확정이라 더 읽을 이유가 없다.
// 이 상한이 없으면 아카이브가 커질수록 매 실행 읽는 양이 무한정 늘어난다.
//
// Show HN은 제외한다: 96시간 창이라 신규 0건이면 며칠을 기다릴 것 없이 즉시 이상이고
// (run.ts가 따로 경고한다), 샤드가 나머지의 5배라 매 실행 읽을 이유가 없다.
export async function lastNewDates(): Promise<Map<SourceKey, string>> {
  const out = new Map<SourceKey, string>()
  for (const month of (await listMonths()).slice(0, 2)) {
    for (const it of await readShard(month.key, false)) {
      const prev = out.get(it.source)
      if (prev === undefined || it.collectedDate > prev) out.set(it.source, it.collectedDate)
    }
  }
  return out
}

// 아카이브 전량을 훑어 소스별 네이티브 id 집합을 만든다. `integrity.ts`가 seen 인덱스와
// 정확히 같은지 단언하는 그 집합이고, `--rebuild-seen`이 seen을 다시 쓸 때 쓰는 근거다.
//
// 여기는 `lastNewDates`와 달리 최근 2개월로 자르지 않는다. 목적이 "최근 언제"가 아니라
// "전량 일치"라서, 한 달이라도 빠뜨리면 그 달 항목이 seen에서 사라져 전부 재수집된다.
// 매 실행 도는 경로가 아니라 사람이 부르는 복구 명령이므로 전량 읽기 비용은 문제가 아니다.
export async function archiveNativeIds(): Promise<Map<SourceKey, Set<string>>> {
  const out = new Map<SourceKey, Set<string>>(SOURCE_KEYS.map((key) => [key, new Set<string>()]))
  for (const month of await listMonths()) {
    for (const showhnShard of month.hasShowhn ? [false, true] : [false]) {
      for (const item of await readShard(month.key, showhnShard)) {
        out.get(item.source)?.add(item.id.slice(item.source.length + 1))
      }
    }
  }
  return out
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
