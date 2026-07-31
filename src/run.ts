import { appendFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { kstDate, kstMonthKey } from './kst.ts'
import {
  listMonths,
  loadSeen,
  readManifest,
  readShard,
  rebuildLatest,
  writeManifest,
  writeSeen,
  writeShard,
  writeShowhnScores,
} from './store.ts'
import { verifyArchiveIntegrity } from './integrity.ts'
import { SOURCE_KEYS, SourceError } from './types.ts'
import type { Collector, ErrorKind, Item, Manifest, MonthEntry, RawItem, SourceKey, SourceStatus } from './types.ts'
import { disquiet } from './collectors/disquiet.ts'
import { geeknewsShow } from './collectors/geeknews-show.ts'
import { ilddan } from './collectors/ilddan.ts'
import { jocohunt } from './collectors/jocohunt.ts'
import { producthunt } from './collectors/producthunt.ts'
import { showhn } from './collectors/showhn.ts'
import { syde } from './collectors/syde.ts'

const COLLECTORS: Collector[] = [geeknewsShow, disquiet, syde, jocohunt, ilddan, producthunt, showhn]

const NEW_COUNT_WARN: Partial<Record<SourceKey, number>> = {
  'geeknews-show': 40,
  syde: 15,
  jocohunt: 25,
  producthunt: 30,
  showhn: 400,
}

const ALERT_STALL_MS = 40 * 3600 * 1000

type RunError = { kind: ErrorKind; status?: number; message: string }

export type SourceRun = {
  key: SourceKey
  ok: boolean
  parsedCount: number
  items: RawItem[]
  warnings: string[]
  error?: RunError
  scores?: Record<string, number>
}

type RunFile = {
  runAt: string
  collectedAt: string
  seed: boolean
  runs: SourceRun[]
}

const RUN_FILE = process.env.IDEA_RADAR_RUN_FILE ?? path.join(os.tmpdir(), 'idea-radar-last-run.json')

function ghWarning(msg: string): void {
  console.log(`::warning::${msg}`)
}

function ghOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (file) appendFileSync(file, `${key}=${value}\n`)
  console.log(`[output] ${key}=${value}`)
}

function toRunError(e: unknown): RunError {
  if (e instanceof SourceError) return { kind: e.kind, status: e.status, message: e.message }
  return { kind: 'parse', message: e instanceof Error ? e.message : String(e) }
}

export function nativeId(key: SourceKey, id: string): string {
  const prefix = `${key}:`
  if (!id.startsWith(prefix) || id.length === prefix.length) {
    throw new SourceError('parse', `${key}: item id ${JSON.stringify(id)} does not start with ${prefix} or has no native id`)
  }
  return id.slice(prefix.length)
}

export function dedupeInRun(items: RawItem[]): RawItem[] {
  const byId = new Map<string, RawItem>()
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it)
  return [...byId.values()]
}

export function assertRawItem(key: SourceKey, item: RawItem): void {
  nativeId(key, item.id)
  if (item.source !== key) throw new SourceError('parse', `${key}: item ${item.id} has source ${item.source}`)
  if (typeof item.title !== 'string' || item.title.trim() === '') {
    throw new SourceError('parse', `${key}: item ${item.id} has an empty title`)
  }
  if ([...item.title].length > 300) throw new SourceError('parse', `${key}: item ${item.id} title exceeds 300 characters`)
  if (typeof item.description !== 'string') throw new SourceError('parse', `${key}: item ${item.id} description is not a string`)
  if ([...item.description].length > 300) {
    throw new SourceError('parse', `${key}: item ${item.id} description exceeds 300 characters`)
  }
  if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) {
    throw new SourceError('parse', `${key}: item ${item.id} has an invalid url`)
  }
  if (item.externalUrl !== undefined && (typeof item.externalUrl !== 'string' || !/^https?:\/\//.test(item.externalUrl))) {
    throw new SourceError('parse', `${key}: item ${item.id} has an invalid externalUrl`)
  }
  if (item.publishedAt !== undefined && (typeof item.publishedAt !== 'string' || Number.isNaN(Date.parse(item.publishedAt)))) {
    throw new SourceError('parse', `${key}: item ${item.id} has an invalid publishedAt`)
  }
  if (item.score !== undefined && (typeof item.score !== 'number' || !Number.isFinite(item.score))) {
    throw new SourceError('parse', `${key}: item ${item.id} has a non-finite score`)
  }
}

async function collectAll(keys: SourceKey[], seed: boolean, dryRun: boolean): Promise<SourceRun[]> {
  const runs: SourceRun[] = []
  for (const collector of COLLECTORS) {
    if (!keys.includes(collector.key)) continue
    const key = collector.key
    const seen = await loadSeen(key)
    if (seen.state === 'corrupt') {
      runs.push({ key, ok: false, parsedCount: 0, items: [], warnings: [], error: { kind: 'parse', message: 'seen index corrupt — refusing to run with empty set' } })
      continue
    }
    if (seen.state === 'missing' && !seed && !dryRun) {
      runs.push({ key, ok: false, parsedCount: 0, items: [], warnings: [], error: { kind: 'parse', message: 'seen index missing — run `node src/run.ts --seed` once first' } })
      continue
    }
    try {
      const result = await collector.collect({ seen: seen.ids, seed })
      if (result.parsedCount === 0) throw new SourceError('parse', 'parsedCount is 0')
      for (const item of result.items) assertRawItem(key, item)
      runs.push({
        key,
        ok: true,
        parsedCount: result.parsedCount,
        items: dedupeInRun(result.items),
        warnings: result.warnings,
        ...(result.scores ? { scores: result.scores } : {}),
      })
    } catch (e) {
      runs.push({ key, ok: false, parsedCount: 0, items: [], warnings: [], error: toRunError(e) })
    }
  }
  return runs
}

type MergeOutcome = { newCounts: Map<SourceKey, number>; touchedMonths: Map<string, { showhn: boolean }> }

export async function merge(runs: SourceRun[], collectedAt: string, seed: boolean): Promise<MergeOutcome> {
  const collectedDate = kstDate(new Date(collectedAt))
  const month = kstMonthKey(new Date(collectedAt))
  const newCounts = new Map<SourceKey, number>()
  const touchedMonths = new Map<string, { showhn: boolean }>()
  const shardCache = new Map<string, { items: Item[]; ids: Set<string>; dirty: boolean }>()
  const seenWrites = new Map<SourceKey, Set<string>>()

  async function shardFor(showhnShard: boolean) {
    const cacheKey = showhnShard ? `${month}.showhn` : month
    let entry = shardCache.get(cacheKey)
    if (!entry) {
      const items = await readShard(month, showhnShard)
      entry = { items, ids: new Set(items.map((i) => i.id)), dirty: false }
      shardCache.set(cacheKey, entry)
    }
    return entry
  }

  for (const run of runs) {
    if (!run.ok) continue
    const seen = await loadSeen(run.key)
    if (seen.state === 'corrupt') {
      run.ok = false
      run.error = { kind: 'parse', message: 'seen index corrupt at merge time' }
      continue
    }
    if (seen.state === 'missing' && !seed) {
      run.ok = false
      run.error = { kind: 'parse', message: 'seen index missing at merge time — run --seed once first' }
      continue
    }
    const fresh = run.items.filter((it) => !seen.ids.has(nativeId(run.key, it.id)))
    const shard = await shardFor(run.key === 'showhn')
    let added = 0
    let seenDirty = seen.state === 'missing'
    for (const raw of fresh) {
      const id = nativeId(run.key, raw.id)
      if (shard.ids.has(raw.id)) {
        // 샤드는 썼지만 seen 쓰기 전에 프로세스가 죽은 경우다. 샤드를 진실로 삼아
        // 인덱스를 복구해야 다음 달에 같은 항목이 다시 나타나도 중복 저장되지 않는다.
        seen.ids.add(id)
        seenDirty = true
        continue
      }
      shard.items.push({ ...raw, collectedAt, collectedDate })
      shard.ids.add(raw.id)
      shard.dirty = true
      added++
      seen.ids.add(id)
      seenDirty = true
    }
    newCounts.set(run.key, added)
    if (seenDirty) seenWrites.set(run.key, seen.ids)
    if (added > 0) touchedMonths.set(month, { showhn: run.key === 'showhn' || (touchedMonths.get(month)?.showhn ?? false) })
  }

  // 쓰기 순서가 데이터 보존 규약이다. seen을 먼저 쓰면 그 다음 샤드 쓰기가 실패했을 때
  // 다음 실행이 항목을 이미 봤다고 오판해 영구 누락한다. 샤드를 먼저 쓰면 반대 방향의
  // 부분 실패는 위의 shard.ids 분기에서 안전하게 자가복구된다.
  for (const [cacheKey, entry] of shardCache) {
    if (!entry.dirty) continue
    const showhnShard = cacheKey.endsWith('.showhn')
    await writeShard(month, showhnShard, entry.items)
  }
  for (const [key, ids] of seenWrites) await writeSeen(key, ids)
  return { newCounts, touchedMonths }
}

async function buildManifest(runs: SourceRun[], runAt: string, touched: Map<string, { showhn: boolean }>): Promise<Manifest> {
  const prev = await readManifest()
  const diskMonths = await listMonths()
  const months: MonthEntry[] = []
  for (const dm of diskMonths) {
    const prevEntry = prev?.months.find((m) => m.key === dm.key)
    if (prevEntry && !touched.has(dm.key)) {
      months.push({ ...prevEntry, hasShowhn: dm.hasShowhn })
      continue
    }
    const counts: Record<string, number> = {}
    for (const showhnShard of dm.hasShowhn ? [false, true] : [false]) {
      for (const it of await readShard(dm.key, showhnShard)) {
        counts[it.source] = (counts[it.source] ?? 0) + 1
      }
    }
    months.push({ key: dm.key, hasShowhn: dm.hasShowhn, counts })
  }

  const sources: Partial<Record<SourceKey, SourceStatus>> = { ...prev?.sources }
  for (const run of runs) {
    const before = sources[run.key]
    if (run.ok) {
      sources[run.key] = { lastSuccessAt: runAt, lastRawCount: run.parsedCount, consecutiveFailures: 0, lastError: null }
    } else {
      sources[run.key] = {
        lastSuccessAt: before?.lastSuccessAt ?? null,
        lastRawCount: before?.lastRawCount ?? null,
        consecutiveFailures: (before?.consecutiveFailures ?? 0) + 1,
        lastError: { at: runAt, kind: run.error!.kind, ...(run.error!.status !== undefined ? { status: run.error!.status } : {}), message: run.error!.message },
      }
    }
  }
  return { schemaVersion: 1, updatedAt: runAt, lastCollectedDate: kstDate(new Date(runAt)), months, sources }
}

function report(runs: SourceRun[], newCounts: Map<SourceKey, number> | undefined, manifest: Manifest | undefined, seed: boolean): void {
  for (const run of runs) {
    for (const w of run.warnings) ghWarning(w)
    if (run.ok) {
      const added = newCounts?.get(run.key)
      console.log(`[ok]   ${run.key.padEnd(14)} parsed=${run.parsedCount}${added !== undefined ? ` new=${added}` : ''}`)
      if (!seed && added !== undefined) {
        const cap = NEW_COUNT_WARN[run.key]
        if (cap !== undefined && added > cap) ghWarning(`${run.key}: ${added} new items in one run (> ${cap}) — check dedupe/seed state`)
        if (run.key === 'showhn' && added === 0) ghWarning('showhn: 0 new items in a 96h window — merge logic may be treating everything as seen')
      }
    } else {
      console.log(`[FAIL] ${run.key.padEnd(14)} (${run.error!.kind}${run.error!.status ? ` ${run.error!.status}` : ''}) ${run.error!.message}`)
      ghWarning(`${run.key} failed (${run.error!.kind}${run.error!.status ? ` ${run.error!.status}` : ''}): ${run.error!.message}`)
    }
  }
  const failed = runs.filter((r) => !r.ok).map((r) => r.key)
  const attempted = runs.map((r) => r.key)
  const alerts = manifest
    ? (Object.entries(manifest.sources) as [SourceKey, SourceStatus][])
        .filter(([, s]) => s.consecutiveFailures >= 2 && (s.lastSuccessAt === null || Date.parse(s.lastSuccessAt) < Date.now() - ALERT_STALL_MS))
        .map(([k]) => k)
    : failed
  ghOutput('failed_sources', failed.join(','))
  ghOutput('alert_sources', alerts.join(','))
  ghOutput('all_failed', String(attempted.length > 0 && failed.length === attempted.length))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const seedFlag = args.includes('--seed')
  const replay = args.includes('--replay')
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length)
  const keys = only ? (only.split(',').filter((k) => (SOURCE_KEYS as readonly string[]).includes(k)) as SourceKey[]) : [...SOURCE_KEYS]
  if (only && keys.length === 0) {
    console.log(`unknown source in --only=${only}; valid: ${SOURCE_KEYS.join(', ')}`)
    return
  }

  let runAt: string
  let collectedAt: string
  let seed: boolean
  let runs: SourceRun[]

  if (replay) {
    const saved = JSON.parse(await readFile(RUN_FILE, 'utf8')) as RunFile
    runAt = saved.runAt
    collectedAt = saved.collectedAt
    seed = saved.seed
    runs = saved.runs
    console.log(`replaying run ${runAt} from ${RUN_FILE}`)
  } else {
    runAt = new Date().toISOString()
    collectedAt = seedFlag ? new Date(Date.parse(runAt) - 48 * 3600 * 1000).toISOString() : runAt
    seed = seedFlag
    console.log(`collect start ${runAt}${seed ? ' (seed: collectedAt backdated 48h)' : ''}${dryRun ? ' (dry-run)' : ''}`)
    runs = await collectAll(keys, seed, dryRun)
    if (!dryRun) {
      const runFile: RunFile = { runAt, collectedAt, seed, runs }
      await writeFile(RUN_FILE, JSON.stringify(runFile), 'utf8')
    }
  }

  if (dryRun) {
    for (const run of runs) {
      if (!run.ok) continue
      const seen = await loadSeen(run.key)
      const wouldAdd = run.items.filter((it) => !seen.ids.has(nativeId(run.key, it.id))).length
      console.log(`[dry]  ${run.key.padEnd(14)} parsed=${run.parsedCount} would-add=${wouldAdd}`)
    }
    report(runs, undefined, undefined, seed)
    return
  }

  const { newCounts, touchedMonths } = await merge(runs, collectedAt, seed)

  // showhn이 성공했을 때만 점수 파일을 갱신한다. 실패했으면 이전 파일을 그대로 둔다 —
  // 지우거나 비우면 실패 1회가 Show HN 목록의 정렬 품질을 조용히 떨어뜨린다.
  const showhnRun = runs.find((r) => r.key === 'showhn')
  if (showhnRun?.ok && showhnRun.scores) await writeShowhnScores(showhnRun.scores)

  const manifest = await buildManifest(runs, runAt, touchedMonths)
  await writeManifest(manifest)
  await rebuildLatest(Date.parse(runAt))
  await verifyArchiveIntegrity()
  ghOutput('data_valid', 'true')
  report(runs, newCounts, manifest, seed)
}

// 테스트가 dedupeInRun/nativeId를 import 할 수 있어야 하므로 실행은 엔트리일 때만 한다.
if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    console.error(e)
    ghWarning(`run.ts crashed before completing: ${e instanceof Error ? e.message : String(e)}`)
    ghOutput('data_valid', 'false')
    ghOutput('failed_sources', SOURCE_KEYS.join(','))
    ghOutput('alert_sources', '')
    ghOutput('all_failed', 'true')
  }
  process.exitCode = 0
}
