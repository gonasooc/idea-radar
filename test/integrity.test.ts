import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Item, Manifest } from '../src/types.ts'

const ROOT = await mkdtemp(path.join(tmpdir(), 'idea-radar-integrity-test-'))
process.env.IDEA_RADAR_ROOT = ROOT
const store = await import('../src/store.ts')
const { verifyArchiveIntegrity } = await import('../src/integrity.ts')

await mkdir(store.DATA_DIR, { recursive: true })
await mkdir(store.SEEN_DIR, { recursive: true })

const archived: Item = {
  id: 'disquiet:123',
  source: 'disquiet',
  title: '제품',
  description: '설명',
  url: 'https://disquiet.io/products/example',
  collectedAt: '2026-07-31T06:00:00.000Z',
  collectedDate: '2026-07-31',
}

const manifest: Manifest = {
  schemaVersion: 1,
  updatedAt: '2026-07-31T06:00:00.000Z',
  lastCollectedDate: '2026-07-31',
  months: [{ key: '2026-07', hasShowhn: false, counts: { disquiet: 1 } }],
  sources: {
    disquiet: { lastSuccessAt: '2026-07-31T06:00:00.000Z', lastRawCount: 1, consecutiveFailures: 0, lastError: null },
  },
}

test('verifyArchiveIntegrity: 파생 파일과 seen이 아카이브와 정확히 일치해야 한다', async () => {
  await store.writeShard('2026-07', false, [archived])
  await store.writeSeen('disquiet', new Set(['123']))
  await store.writeManifest(manifest)
  await store.rebuildLatest(Date.parse(manifest.updatedAt))
  await assert.doesNotReject(() => verifyArchiveIntegrity())

  await store.writeSeen('disquiet', new Set(['123', 'seen-only']))
  await assert.rejects(() => verifyArchiveIntegrity(), /does not exactly match archived ids/)

  await store.writeSeen('disquiet', new Set(['123']))
  await store.writeJsonAtomic(path.join(store.DATA_DIR, 'latest.json'), '[]\n')
  await assert.rejects(() => verifyArchiveIntegrity(), /not the exact 30-day projection/)
})
