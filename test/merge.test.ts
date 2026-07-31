import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RawItem } from '../src/types.ts'

const ROOT = await mkdtemp(path.join(tmpdir(), 'idea-radar-merge-test-'))
process.env.IDEA_RADAR_ROOT = ROOT
const store = await import('../src/store.ts')
const { merge } = await import('../src/run.ts')

await mkdir(store.DATA_DIR, { recursive: true })
await mkdir(store.SEEN_DIR, { recursive: true })

const raw: RawItem = {
  id: 'disquiet:123',
  source: 'disquiet',
  title: '이미 샤드에 기록된 항목',
  description: '',
  url: 'https://disquiet.io/products/example',
}

test('merge: 샤드만 먼저 기록된 부분 실패에서 seen 인덱스를 자가복구한다', async () => {
  await store.writeShard('2026-07', false, [
    { ...raw, collectedAt: '2026-07-31T00:00:00.000Z', collectedDate: '2026-07-31' },
  ])
  await store.writeSeen('disquiet', new Set())

  const outcome = await merge(
    [{ key: 'disquiet', ok: true, parsedCount: 1, items: [raw], warnings: [] }],
    '2026-07-31T06:00:00.000Z',
    false,
  )

  assert.equal(outcome.newCounts.get('disquiet'), 0)
  assert.equal((await store.readShard('2026-07', false)).length, 1)
  assert.deepEqual([...(await store.loadSeen('disquiet')).ids], ['123'])
})
