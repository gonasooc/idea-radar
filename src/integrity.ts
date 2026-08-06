import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { kstDate, kstMonthKey } from './kst.ts'
import { DATA_DIR, SHOWHN_SCORES_FILE, latestWindow, listMonths, loadSeen, readManifest, readShard, verifyDataDir } from './store.ts'
import { SOURCE_KEYS, SourceError } from './types.ts'
import type { Item, Manifest, SourceKey, SourceStatus } from './types.ts'

function fail(message: string): never {
  throw new SourceError('parse', `archive integrity: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function assertStatus(key: string, value: unknown): asserts value is SourceStatus {
  if (!isRecord(value)) fail(`manifest.sources.${key} is not an object`)
  if (value.lastSuccessAt !== null && !isTimestamp(value.lastSuccessAt)) fail(`manifest.sources.${key}.lastSuccessAt is invalid`)
  if (value.lastRawCount !== null && (!Number.isInteger(value.lastRawCount) || (value.lastRawCount as number) < 0)) {
    fail(`manifest.sources.${key}.lastRawCount is invalid`)
  }
  if (!Number.isInteger(value.consecutiveFailures) || (value.consecutiveFailures as number) < 0) {
    fail(`manifest.sources.${key}.consecutiveFailures is invalid`)
  }
  if (value.lastError !== null) {
    if (!isRecord(value.lastError)) fail(`manifest.sources.${key}.lastError is not an object`)
    if (!isTimestamp(value.lastError.at)) fail(`manifest.sources.${key}.lastError.at is invalid`)
    if (!['http', 'parse', 'timeout'].includes(String(value.lastError.kind))) {
      fail(`manifest.sources.${key}.lastError.kind is invalid`)
    }
    if (typeof value.lastError.message !== 'string' || value.lastError.message === '') {
      fail(`manifest.sources.${key}.lastError.message is empty`)
    }
  }
  // 정상인 소스에는 키 자체가 없다. undefined를 통과시켜야 이 필드가 생기기 전에 커밋된
  // manifest도 검증을 통과한다 — check.yml의 verify는 collect가 한 번 돌기 전에 먼저 뜬다.
  if (value.staleNew !== undefined) {
    if (!isRecord(value.staleNew)) fail(`manifest.sources.${key}.staleNew is not an object`)
    const { days, lastNewDate } = value.staleNew
    if (days !== null && (!Number.isInteger(days) || (days as number) < 0)) {
      fail(`manifest.sources.${key}.staleNew.days is invalid`)
    }
    if (lastNewDate !== null && (typeof lastNewDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastNewDate))) {
      fail(`manifest.sources.${key}.staleNew.lastNewDate is invalid`)
    }
    if ((days === null) !== (lastNewDate === null)) {
      fail(`manifest.sources.${key}.staleNew has one of days/lastNewDate null but not the other`)
    }
  }
}

function assertManifest(value: unknown): asserts value is Manifest {
  if (!isRecord(value)) fail('manifest.json is not an object')
  if (value.schemaVersion !== 1) fail(`manifest.schemaVersion is ${String(value.schemaVersion)}, expected 1`)
  if (!isTimestamp(value.updatedAt)) fail('manifest.updatedAt is invalid')
  if (typeof value.lastCollectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.lastCollectedDate)) {
    fail('manifest.lastCollectedDate is invalid')
  }
  if (value.lastCollectedDate !== kstDate(new Date(value.updatedAt))) {
    fail('manifest.lastCollectedDate does not match updatedAt in KST')
  }
  if (!Array.isArray(value.months) || value.months.length === 0) fail('manifest.months is empty or not an array')
  if (!isRecord(value.sources)) fail('manifest.sources is missing')
  for (const [key, status] of Object.entries(value.sources)) {
    if (!(SOURCE_KEYS as readonly string[]).includes(key)) fail(`manifest has unknown source ${key}`)
    assertStatus(key, status)
  }
}

function assertItem(value: unknown, context: string, month: string, showhnShard: boolean): asserts value is Item {
  if (!isRecord(value)) fail(`${context} is not an object`)
  if (typeof value.source !== 'string' || !(SOURCE_KEYS as readonly string[]).includes(value.source)) {
    fail(`${context}.source is invalid`)
  }
  const source = value.source as SourceKey
  if (typeof value.id !== 'string' || !value.id.startsWith(`${source}:`) || value.id.length === source.length + 1) {
    fail(`${context}.id does not match source`)
  }
  if ((source === 'showhn') !== showhnShard) fail(`${context} is in the wrong Show HN shard`)
  if (typeof value.title !== 'string' || value.title.trim() === '' || [...value.title].length > 300) {
    fail(`${context}.title is empty or over 300 characters`)
  }
  if (typeof value.description !== 'string' || [...value.description].length > 300) {
    fail(`${context}.description is not a string or over 300 characters`)
  }
  if (typeof value.url !== 'string' || !/^https?:\/\//.test(value.url)) fail(`${context}.url is invalid`)
  if (value.externalUrl !== undefined && (typeof value.externalUrl !== 'string' || !/^https?:\/\//.test(value.externalUrl))) {
    fail(`${context}.externalUrl is invalid`)
  }
  if (value.publishedAt !== undefined && !isTimestamp(value.publishedAt)) fail(`${context}.publishedAt is invalid`)
  if (!isTimestamp(value.collectedAt)) fail(`${context}.collectedAt is invalid`)
  if (typeof value.collectedDate !== 'string' || value.collectedDate !== kstDate(new Date(value.collectedAt))) {
    fail(`${context}.collectedDate does not match collectedAt in KST`)
  }
  if (kstMonthKey(new Date(value.collectedAt)) !== month) fail(`${context}.collectedAt belongs to another month`)
  if (value.score !== undefined && (typeof value.score !== 'number' || !Number.isFinite(value.score))) {
    fail(`${context}.score is invalid`)
  }
}

function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function verifyArchiveIntegrity(): Promise<void> {
  await verifyDataDir()

  const manifest = await readManifest()
  assertManifest(manifest)
  const diskMonths = await listMonths()
  if (diskMonths.length === 0) fail('no monthly shard exists')

  const archiveIds = new Set<string>()
  const nativeIds = new Map<SourceKey, Set<string>>(SOURCE_KEYS.map((key) => [key, new Set<string>()]))
  const expectedMonths: { key: string; hasShowhn: boolean; counts: Record<string, number> }[] = []

  for (const diskMonth of diskMonths) {
    const counts: Record<string, number> = {}
    for (const showhnShard of diskMonth.hasShowhn ? [false, true] : [false]) {
      const items = await readShard(diskMonth.key, showhnShard)
      let previousCollectedAt = ''
      for (let index = 0; index < items.length; index++) {
        const context = `${diskMonth.key}${showhnShard ? '.showhn' : ''}.json[${index}]`
        const item: unknown = items[index]
        assertItem(item, context, diskMonth.key, showhnShard)
        if (item.collectedAt < previousCollectedAt) fail(`${context} breaks append order by collectedAt`)
        previousCollectedAt = item.collectedAt
        if (archiveIds.has(item.id)) fail(`duplicate archive id ${item.id}`)
        archiveIds.add(item.id)
        const native = item.id.slice(item.source.length + 1)
        nativeIds.get(item.source)!.add(native)
        counts[item.source] = (counts[item.source] ?? 0) + 1
      }
    }
    expectedMonths.push({ key: diskMonth.key, hasShowhn: diskMonth.hasShowhn, counts })
  }

  if (manifest.months.length !== expectedMonths.length) fail('manifest.months length differs from disk shards')
  for (let index = 0; index < expectedMonths.length; index++) {
    const actual = manifest.months[index]
    const expected = expectedMonths[index]
    if (!isRecord(actual) || actual.key !== expected.key || actual.hasShowhn !== expected.hasShowhn || !isRecord(actual.counts)) {
      fail(`manifest.months[${index}] does not match disk shard ${expected.key}`)
    }
    const actualCounts = actual.counts as Record<string, unknown>
    const keys = new Set([...Object.keys(actualCounts), ...Object.keys(expected.counts)])
    for (const key of keys) {
      if (actualCounts[key] !== expected.counts[key]) fail(`manifest count mismatch for ${expected.key}/${key}`)
    }
  }

  for (const key of SOURCE_KEYS) {
    const expected = nativeIds.get(key)!
    const seen = await loadSeen(key)
    if (expected.size === 0 && seen.state === 'missing') continue
    if (seen.state !== 'ok') fail(`seen/${key}.json is ${seen.state}`)
    if (!sameStringSet(expected, seen.ids)) fail(`seen/${key}.json does not exactly match archived ids`)
  }

  const latestValue = await readJsonFile(path.join(DATA_DIR, 'latest.json'))
  if (!Array.isArray(latestValue)) fail('latest.json is not an array')
  const { cutoff, keys } = latestWindow(diskMonths, Date.parse(manifest.updatedAt))
  const expectedLatest: Item[] = []
  for (const key of keys) {
    for (const item of await readShard(key, false)) if (item.collectedAt >= cutoff) expectedLatest.push(item)
  }
  if (JSON.stringify(latestValue) !== JSON.stringify(expectedLatest)) {
    fail('latest.json is not the exact 30-day projection of monthly shards')
  }

  try {
    const scores = await readJsonFile(path.join(DATA_DIR, SHOWHN_SCORES_FILE))
    if (!isRecord(scores)) fail('showhn-scores.json is not an object')
    for (const [id, score] of Object.entries(scores)) {
      if (!/^\d+$/.test(id) || typeof score !== 'number' || !Number.isFinite(score)) {
        fail(`showhn-scores.json has invalid entry ${id}`)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
