import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Item } from '../src/types.ts'

// store.ts는 로드 시점에 ROOT를 확정하므로 env를 먼저 세우고 동적 import 해야 한다.
const ROOT = await mkdtemp(path.join(tmpdir(), 'idea-radar-test-'))
process.env.IDEA_RADAR_ROOT = ROOT
const store = await import('../src/store.ts')

await mkdir(store.DATA_DIR, { recursive: true })
await mkdir(store.SEEN_DIR, { recursive: true })

function item(over: Partial<Item> & Pick<Item, 'id' | 'collectedAt'>): Item {
  return {
    source: 'disquiet',
    title: 't',
    description: '',
    url: 'https://example.com/x',
    collectedDate: over.collectedAt.slice(0, 10),
    ...over,
  } as Item
}

// 항목 1개 = 1줄이라야 git 일일 델타가 추가된 줄만큼으로 줄고 diff로 그날 유입이 보인다 (SPEC 4.4).
test('serializeRows: 항목 1개 = 1줄, JSON 왕복', () => {
  assert.equal(store.serializeRows([]), '[]\n')

  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const text = store.serializeRows(rows)
  assert.deepEqual(JSON.parse(text), rows)
  assert.equal(text.trim().split('\n').length, rows.length + 2) // [ + 3행 + ]
  assert.ok(text.endsWith('\n'))
})

test('serializeScores: 키 1개 = 1줄, 키 정렬, JSON 왕복', () => {
  assert.equal(store.serializeScores({}), '{}\n')

  const text = store.serializeScores({ b: 2, a: 1, c: 30 })
  assert.deepEqual(JSON.parse(text), { a: 1, b: 2, c: 30 })
  assert.deepEqual(Object.keys(JSON.parse(text)), ['a', 'b', 'c'])
  assert.equal(text.trim().split('\n').length, 5) // { + 3행 + }
})

// 인덱스를 못 읽었는데 빈 Set으로 진행하면 아카이브 전체가 중복된다 (SPEC 3).
// 그래서 missing과 corrupt를 ok와 반드시 구분해야 한다.
test('loadSeen: 파일이 없으면 missing (ok 아님)', async () => {
  const load = await store.loadSeen('syde')
  assert.equal(load.state, 'missing')
  assert.equal(load.ids.size, 0)
})

test('loadSeen: 배열이 아니면 corrupt', async () => {
  await writeFile(path.join(store.SEEN_DIR, 'ilddan.json'), '{"a":1}', 'utf8')
  assert.equal((await store.loadSeen('ilddan')).state, 'corrupt')
})

test('loadSeen: 깨진 JSON이면 corrupt', async () => {
  await writeFile(path.join(store.SEEN_DIR, 'jocohunt.json'), '[1,2,', 'utf8')
  assert.equal((await store.loadSeen('jocohunt')).state, 'corrupt')
})

test('loadSeen: 문자열 아닌 원소가 섞이면 corrupt', async () => {
  await writeFile(path.join(store.SEEN_DIR, 'producthunt.json'), '["1",2]', 'utf8')
  assert.equal((await store.loadSeen('producthunt')).state, 'corrupt')
})

test('writeSeen → loadSeen 왕복: 정렬·중복 제거되고 ok', async () => {
  await store.writeSeen('disquiet', new Set(['7536', '100', '7536', '20']))
  const load = await store.loadSeen('disquiet')
  assert.equal(load.state, 'ok')
  assert.deepEqual([...load.ids].sort(), ['100', '20', '7536'])

  const raw = JSON.parse(await readFile(path.join(store.SEEN_DIR, 'disquiet.json'), 'utf8'))
  assert.deepEqual(raw, ['100', '20', '7536']) // 파일에도 정렬되어 저장된다
})

test('writeShard → readShard 왕복', async () => {
  const items = [item({ id: 'disquiet:1', collectedAt: '2026-07-29T10:00:00.000Z' })]
  await store.writeShard('2026-07', false, items)
  assert.deepEqual(await store.readShard('2026-07', false), items)
})

test('readShard: 없는 샤드는 빈 배열', async () => {
  assert.deepEqual(await store.readShard('1999-01', false), [])
})

test('listMonths: 최신순 정렬, showhn 샤드 유무를 표시', async () => {
  await store.writeShard('2026-06', false, [])
  await store.writeShard('2026-07', true, [])
  const months = await store.listMonths()
  assert.deepEqual(months.map((m) => m.key), ['2026-07', '2026-06'])
  assert.equal(months.find((m) => m.key === '2026-07')!.hasShowhn, true)
  assert.equal(months.find((m) => m.key === '2026-06')!.hasShowhn, false)
})

// listMonths가 sidecar를 월 샤드로 오인하면 manifest.months에 쓰레기 항목이 생긴다.
test('listMonths: showhn-scores.json을 월 샤드로 오인하지 않는다', async () => {
  await store.writeShowhnScores({ '123': 4 })
  const months = await store.listMonths()
  assert.ok(months.every((m) => /^\d{4}-\d{2}$/.test(m.key)))
})

test('rebuildLatest: 30일 컷오프를 적용하고 Show HN을 제외한다', async () => {
  const now = Date.parse('2026-07-30T00:00:00.000Z')
  const iso = (daysAgo: number) => new Date(now - daysAgo * 24 * 3600 * 1000).toISOString()

  await store.writeShard('2026-07', false, [
    item({ id: 'disquiet:new', collectedAt: iso(1) }),
    item({ id: 'disquiet:edge', collectedAt: iso(29) }),
    item({ id: 'disquiet:old', collectedAt: iso(31) }),
  ])
  await store.writeShard('2026-07', true, [
    item({ id: 'showhn:1', source: 'showhn', collectedAt: iso(1) }),
  ])

  await store.rebuildLatest(now)
  const latest = JSON.parse(await readFile(path.join(store.DATA_DIR, 'latest.json'), 'utf8')) as Item[]
  assert.deepEqual(latest.map((i) => i.id), ['disquiet:new', 'disquiet:edge'])
  assert.ok(latest.every((i) => i.source !== 'showhn'))
})

// "최근 2개월"로 자르면 2월이 28·29일이라 3월 1~2일에 1월 말 항목이 조용히 빠진다.
// rebuildLatest와 integrity가 각자 그 상수를 복제하고 있어서 커밋 게이트도 못 잡던 누락이다.
test('latestWindow: 30일 창이 세 달에 걸치는 날 세 달을 모두 읽는다', () => {
  const months = [
    { key: '2026-03', hasShowhn: false },
    { key: '2026-02', hasShowhn: false },
    { key: '2026-01', hasShowhn: false },
  ]
  // KST 2026-03-01 04:37 (아침 수집) → 컷오프는 KST 2026-01-30
  const window = store.latestWindow(months, Date.parse('2026-02-28T19:37:00.000Z'))
  assert.deepEqual(window.keys, ['2026-01', '2026-02', '2026-03'])
  assert.equal(window.cutoff, '2026-01-29T19:37:00.000Z')
})

// 상한이 없으면 아카이브가 커질수록 매 실행 읽는 양이 늘어난다. 창 밖 달은 빼야 한다.
test('latestWindow: 창 밖 달은 읽지 않는다', () => {
  const months = [
    { key: '2026-08', hasShowhn: false },
    { key: '2026-07', hasShowhn: false },
    { key: '2026-06', hasShowhn: false },
  ]
  assert.deepEqual(store.latestWindow(months, Date.parse('2026-08-05T20:46:05.791Z')).keys, ['2026-07', '2026-08'])
})

test('lastNewDates: 소스별 최신 collectedDate를 고르고, Show HN과 3개월 전은 제외한다', async () => {
  // 2개월 상한이 없으면 아카이브가 커질수록 매 실행 읽는 양이 무한정 늘어난다.
  // syde는 가장 오래된 달에만 두어 창 밖이면 안 잡히는 것을 확인한다.
  await store.writeShard('2026-07', false, [
    item({ id: 'syde:old', source: 'syde', collectedAt: '2026-07-10T00:00:00.000Z' }),
  ])
  await store.writeShard('2026-08', false, [
    item({ id: 'disquiet:a', collectedAt: '2026-08-02T00:00:00.000Z' }),
    item({ id: 'disquiet:b', collectedAt: '2026-08-20T00:00:00.000Z' }),
  ])
  await store.writeShard('2026-09', false, [
    item({ id: 'disquiet:c', collectedAt: '2026-09-03T00:00:00.000Z' }),
    item({ id: 'ilddan:x', source: 'ilddan', collectedAt: '2026-09-01T00:00:00.000Z' }),
  ])
  await store.writeShard('2026-09', true, [
    item({ id: 'showhn:1', source: 'showhn', collectedAt: '2026-09-04T00:00:00.000Z' }),
  ])

  const last = await store.lastNewDates()
  assert.equal(last.get('disquiet'), '2026-09-03') // 두 달에 걸쳐 있어도 최신을 고른다
  assert.equal(last.get('ilddan'), '2026-09-01')
  assert.equal(last.get('showhn'), undefined) // showhn 샤드는 읽지 않는다
  assert.equal(last.get('syde'), undefined) // 최근 2개월 창 밖
})

// 커밋 직전 게이트가 기대는 함수다. 깨진 JSON을 통과시키면 사이트가 흰 화면이 된다.
test('verifyDataDir: 깨진 JSON을 잡는다', async () => {
  await store.verifyDataDir() // 여기까지는 전부 유효
  await writeFile(path.join(store.DATA_DIR, '2026-05.json'), '[{"id":', 'utf8')
  await assert.rejects(() => store.verifyDataDir(), /not valid JSON/)
})
