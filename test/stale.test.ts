import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatStaleNew, staleNewSources } from '../src/run.ts'
import type { SourceRun } from '../src/run.ts'
import type { SourceKey } from '../src/types.ts'

function staleNewWarnings(runs: SourceRun[], lastNew: Map<SourceKey, string>, today: string): string[] {
  return formatStaleNew(staleNewSources(runs, lastNew, today))
}

function ok(key: SourceKey): SourceRun {
  return { key, ok: true, parsedCount: 40, items: [], warnings: [] }
}

function failed(key: SourceKey): SourceRun {
  return { key, ok: false, parsedCount: 0, items: [], warnings: [], error: { kind: 'http', message: 'boom' } }
}

const TODAY = '2026-08-05'

test('임계값 미만이면 조용하다', () => {
  const last = new Map<SourceKey, string>([['disquiet', '2026-08-01']]) // 4일 < 7일
  assert.deepEqual(staleNewWarnings([ok('disquiet')], last, TODAY), [])
})

// 경계에서 한쪽으로 몰려 있으면 임계값이 사실상 하루 밀린다. 정확히 임계일에 떠야 한다.
test('임계값과 같은 날 경고한다', () => {
  const last = new Map<SourceKey, string>([['disquiet', '2026-07-29']]) // 정확히 7일
  const out = staleNewWarnings([ok('disquiet')], last, TODAY)
  assert.equal(out.length, 1)
  assert.match(out[0], /disquiet: 7 days with no new items \(threshold 7\) — last new 2026-07-29/)
})

// PH는 하루 8~13건이라 이틀이면 이상하고, 일딴은 하루 1~2건이라 이틀은 정상이다.
// 임계값을 소스별로 두는 이유가 이것이라 한 값으로 뭉개지지 않는지 본다.
test('소스마다 다른 임계값을 쓴다', () => {
  const last = new Map<SourceKey, string>([
    ['producthunt', '2026-08-03'], // 2일 → 임계값 2, 경고
    ['ilddan', '2026-08-03'], // 2일 → 임계값 14, 조용
  ])
  const out = staleNewWarnings([ok('producthunt'), ok('ilddan')], last, TODAY)
  assert.equal(out.length, 1)
  assert.match(out[0], /^producthunt:/)
})

// 실패한 소스는 이미 실패 경고와 40시간 alert 규칙이 담당한다. 여기서 또 내면
// 같은 사고가 두 줄로 보고돼 소음이 된다 (SPEC 4.2).
test('실패한 소스는 건너뛴다', () => {
  const last = new Map<SourceKey, string>([['disquiet', '2026-06-01']])
  assert.deepEqual(staleNewWarnings([failed('disquiet')], last, TODAY), [])
})

test('임계값이 없는 소스는 건너뛴다', () => {
  const last = new Map<SourceKey, string>([['showhn', '2026-06-01']])
  assert.deepEqual(staleNewWarnings([ok('showhn'), ok('jocohunt')], last, TODAY), [])
})

// 2개월 창 밖이면 lastNewDates가 아예 값을 안 준다. 이때 조용히 넘어가면
// "가장 오래 멈춘 소스"만 경고를 못 받는 정반대 결과가 된다.
test('최근 2개월 창에 아무것도 없으면 날짜 없이 경고한다', () => {
  const out = staleNewWarnings([ok('syde')], new Map(), TODAY)
  assert.equal(out.length, 1)
  assert.match(out[0], /syde: no items in the last two monthly shards/)
})

// 월·연 경계에서 날짜 뺄셈이 어긋나면 임계값이 통째로 밀린다.
test('월·연 경계를 넘어도 일수가 맞다', () => {
  const last = new Map<SourceKey, string>([['producthunt', '2026-12-30']])
  const out = staleNewWarnings([ok('producthunt')], last, '2027-01-03')
  assert.match(out[0], /4 days/)
})

// 이 판정은 manifest를 거쳐 사이트 상태 줄까지 간다. 사이트가 임계값을 모른 채 렌더할 수 있도록
// 날짜와 일수를 구조로 넘겨야 한다 — 문자열만 내보내면 사이트가 임계값 표를 복제하게 된다.
test('staleNewSources: 임계값을 넘긴 소스만 구조로 돌려준다', () => {
  const last = new Map<SourceKey, string>([
    ['disquiet', '2026-07-27'], // 9일 ≥ 7 → 판정 대상
    ['ilddan', '2026-08-03'], // 2일 < 14 → 조용
  ])
  const stale = staleNewSources([ok('disquiet'), ok('ilddan')], last, TODAY)
  assert.deepEqual([...stale.keys()], ['disquiet'])
  assert.deepEqual(stale.get('disquiet'), { days: 9, lastNewDate: '2026-07-27' })
})

// days와 lastNewDate는 항상 같이 null이거나 같이 값이다. integrity가 그 짝을 단언하므로
// 한쪽만 채우면 커밋 게이트가 막힌다.
test('staleNewSources: 2개월 창에 기록이 없으면 두 필드가 함께 null이다', () => {
  const stale = staleNewSources([ok('syde')], new Map(), TODAY)
  assert.deepEqual(stale.get('syde'), { days: null, lastNewDate: null })
})
