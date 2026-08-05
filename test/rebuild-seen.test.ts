import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Item, Manifest } from '../src/types.ts'

const ROOT = await mkdtemp(path.join(tmpdir(), 'idea-radar-rebuild-seen-test-'))
process.env.IDEA_RADAR_ROOT = ROOT
const store = await import('../src/store.ts')
const { rebuildSeen } = await import('../src/run.ts')
const { verifyArchiveIntegrity } = await import('../src/integrity.ts')

await mkdir(store.DATA_DIR, { recursive: true })
await mkdir(store.SEEN_DIR, { recursive: true })

function item(source: Item['source'], native: string, collectedAt: string, url: string): Item {
  return {
    id: `${source}:${native}`,
    source,
    title: `${source} ${native}`,
    description: '',
    url,
    collectedAt,
    collectedDate: collectedAt.slice(0, 10),
  }
}

const july = [
  item('disquiet', '111', '2026-07-20T06:00:00.000Z', 'https://disquiet.io/products/a'),
  item('syde', 'aaa', '2026-07-21T06:00:00.000Z', 'https://syde.kr/showcase/aaa'),
]
const august = [item('disquiet', '222', '2026-08-01T06:00:00.000Z', 'https://disquiet.io/products/b')]
// Show HN은 별도 샤드다. 여기를 안 읽으면 재구축이 showhn 항목을 통째로 빠뜨려 전량 재수집된다.
const augustShowhn = [item('showhn', '900', '2026-08-01T06:00:00.000Z', 'https://news.ycombinator.com/item?id=900')]

const manifest: Manifest = {
  schemaVersion: 1,
  updatedAt: '2026-08-01T06:00:00.000Z',
  lastCollectedDate: '2026-08-01',
  months: [
    { key: '2026-08', hasShowhn: true, counts: { disquiet: 1, showhn: 1 } },
    { key: '2026-07', hasShowhn: false, counts: { disquiet: 1, syde: 1 } },
  ],
  sources: {},
}

test('rebuildSeen: 아카이브 전량에서 seen 인덱스를 되만든다', async () => {
  await store.writeShard('2026-07', false, july)
  await store.writeShard('2026-08', false, august)
  await store.writeShard('2026-08', true, augustShowhn)
  await store.writeManifest(manifest)
  await store.rebuildLatest(Date.parse(manifest.updatedAt))

  // 인덱스를 통째로 잃은 상태(disquiet), 깨진 상태(syde), 없는 상태(showhn)를 한꺼번에 만든다.
  await writeFile(path.join(store.SEEN_DIR, 'syde.json'), '{ not an array }', 'utf8')
  await assert.rejects(() => verifyArchiveIntegrity())

  assert.equal(await rebuildSeen(), true)

  // 최근 2개월로 자르지 않는다 — 7월 항목이 빠지면 다음 실행이 그걸 신규로 다시 넣는다.
  assert.deepEqual([...(await store.loadSeen('disquiet')).ids].sort(), ['111', '222'])
  assert.deepEqual([...(await store.loadSeen('syde')).ids], ['aaa'])
  assert.deepEqual([...(await store.loadSeen('showhn')).ids], ['900'])
  await assert.doesNotReject(() => verifyArchiveIntegrity())
})

// 빈 `[]`를 써 두면 loadSeen이 'ok'를 돌려주고 최초 실행이 --seed 없이 지나간다 (SPEC 7).
test('rebuildSeen: 항목도 인덱스도 없는 소스는 파일을 만들지 않는다', async () => {
  const names = await readdir(store.SEEN_DIR)
  assert.deepEqual(names.sort(), ['disquiet.json', 'showhn.json', 'syde.json'])
  assert.equal((await store.loadSeen('ilddan')).state, 'missing')
})
