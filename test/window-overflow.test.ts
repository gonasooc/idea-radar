import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeepPageError, scanPages } from '../src/collectors/disquiet.ts'
import { sydeOverflow } from '../src/collectors/syde.ts'
import { SourceError } from '../src/types.ts'

// 고정 창 수집기의 창 넘침 (SPEC 4.5 일곱 번째). Disquiet는 1~2페이지만 읽다가 매주 승인분의
// 앞 40건만 남기고 10주간 607건을 잃었고, 그동안 아무 경보도 없었다.

function product(id: number) {
  return { id, slug: `s${id}`, name: `p${id}`, tagline: 't', approved_at: '2026-10-11T22:15:00.000Z' }
}

const range = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, i) => hi - i)

// id 내림차순 목록을 20건씩 페이지로 나눈다. 범위 밖 페이지는 빈 배열을 준다.
function pager(ids: number[], overrides: Record<number, unknown[]> = {}) {
  const pages: unknown[][] = []
  for (let i = 0; i < ids.length; i += 20) pages.push(ids.slice(i, i + 20).map(product))
  const calls: number[] = []
  const fetch = async (page: number) => {
    calls.push(page)
    return overrides[page] ?? pages[page - 1] ?? []
  }
  return { fetch, calls }
}

const seenOf = (ids: number[]) => new Set(ids.map(String))
const ALL = range(9100, 8001)

test('승인일이 아니면(1~2페이지가 전부 본 것) 2페이지에서 멈춘다', async () => {
  const { fetch, calls } = pager(ALL)
  const r = await scanPages(fetch, seenOf(ALL), { backfill: false, floorId: 7000, idWindow: 300 })
  assert.deepEqual(calls, [1, 2])
  assert.equal(r.products.length, 40)
  assert.equal(r.overflow, undefined)
})

test('승인일이면 최상단에서 idWindow 아래까지 읽고, 창 안의 늦은 승인도 잡는다', async () => {
  // 최상단 30건과 옛 id 8850(늦은 승인)이 새것이다
  const seen = seenOf(ALL.filter((id) => id < 9071 && id !== 8850))
  const { fetch, calls } = pager(ALL)
  const r = await scanPages(fetch, seen, { backfill: false, floorId: 7000, idWindow: 300 })
  assert.equal(r.bottom, 8800)
  assert.equal(calls.at(-1), 16) // 16페이지의 최소 id 8781 < 8800
  assert.equal(r.overflow, undefined)
  const ids = r.products.map((p) => p.id)
  assert.ok(ids.includes(8850))
  assert.ok(ids.every((id) => id >= 8800))
  assert.equal(ids.filter((id) => !seen.has(String(id))).length, 31)
})

// 2026-10-12의 상태가 이것이다: 매주 앞 40건만 저장돼 1~2페이지는 본 것이고 그 아래가 밀려 있다.
// 평소 실행은 조용함 규칙에 걸려 밀린 분량에 닿지 못한다 — 그래서 되찾기가 따로 있다.
test('밀린 분량은 평소 실행으로는 못 읽고, 되찾기는 조용함 규칙 없이 바닥까지 읽는다', async () => {
  const seen = seenOf(ALL.slice(0, 40))
  const normal = pager(ALL)
  const r1 = await scanPages(normal.fetch, seen, { backfill: false, floorId: 8500, idWindow: 1500 })
  assert.deepEqual(normal.calls, [1, 2])

  const deep = pager(ALL)
  const r2 = await scanPages(deep.fetch, seen, { backfill: true, floorId: 8500 })
  assert.equal(r2.bottom, 8500)
  assert.equal(r2.overflow, undefined)
  assert.equal(r2.products.length, 9100 - 8500 + 1)
  assert.ok(r2.products.every((p) => p.id >= 8500))
  assert.equal(r1.products.length, 40)
})

// 알려진 빈틈을 고정한다(spec 2 "스캔 규칙"). 1~2페이지가 본 것이고 새 항목이 3페이지에만 있으면
// 평소 실행은 2페이지에서 멈추고, 그 항목은 다음 승인일의 깊은 스캔이 잡는다. 이걸 "고쳐서" 조용함
// 규칙을 없애거나 늘리면 승인일이 아닌 실행(하루 2회, 매일)마다 요청이 늘어난다 — 고치려면 이 테스트를 먼저 보라.
test('1~2페이지가 본 것이면 3페이지의 새 항목은 이번 실행에서 읽지 않는다 (알려진 빈틈)', async () => {
  const seen = seenOf(ALL.filter((id) => id !== 9050)) // 9050은 3페이지(9060~9041)
  const { fetch, calls } = pager(ALL)
  const r = await scanPages(fetch, seen, { backfill: false, floorId: 7000, idWindow: 300 })
  assert.deepEqual(calls, [1, 2])
  assert.equal(r.overflow, undefined)
  assert.equal(r.products.length, 40)
  assert.ok(!r.products.some((p) => p.id === 9050))
})

test('바닥에 닿기 전에 페이지 상한에 닿으면 창 넘침이다', async () => {
  const { fetch, calls } = pager(ALL)
  const r = await scanPages(fetch, new Set(), { backfill: true, floorId: 1, maxPages: 5 })
  assert.equal(calls.length, 5)
  assert.match(r.overflow ?? '', /page cap 5/)
  assert.equal(r.products.length, 100) // 받은 항목은 버리지 않는다
})

test('페이지 순서가 깨지면 거기서 멈추고 창 넘침으로 올린다 — 깨진 페이지는 쓰지 않는다', async () => {
  const garbage = [4564, 906, 2134, 1736].map(product) // spec 2 함정: 범위 밖 페이지는 무작위 순서
  const { fetch } = pager(ALL, { 3: garbage })
  const seen = seenOf(ALL.filter((id) => id < 9081))
  const r = await scanPages(fetch, seen, { backfill: false, floorId: 7000, idWindow: 300 })
  assert.match(r.overflow ?? '', /page 3 broke id order/)
  assert.ok(r.products.every((p) => p.id > 9060))
  assert.equal(r.products.length, 40)
})

test('빈 페이지도 바닥 전이면 창 넘침이다', async () => {
  const { fetch } = pager(range(9100, 9041)) // 3페이지뿐
  const r = await scanPages(fetch, new Set(['9000']), { backfill: false, floorId: 7000, idWindow: 300 })
  assert.match(r.overflow ?? '', /page 4 broke id order/)
})

// 스캔 중에 새 글이 승인되면 페이지가 한 칸 밀려 경계에 같은 항목이 두 번 나온다(spec 2 파싱 5).
test('페이지 경계의 중복은 창 넘침이 아니고 한 번만 남는다', async () => {
  const page2 = [9081, ...range(9080, 9062)].map(product) // 1페이지 마지막(9081)이 다시 나온다
  const { fetch } = pager(ALL, { 2: page2 })
  const seen = seenOf(ALL.filter((id) => id < 9081))
  const r = await scanPages(fetch, seen, { backfill: false, floorId: 7000, idWindow: 300 })
  assert.equal(r.overflow, undefined)
  assert.equal(r.products.filter((p) => p.id === 9081).length, 1)
})

test('1페이지 뒤의 실패는 DeepPageError로 실행을 통째로 실패시킨다 — 일부만 저장하지 않는다', async () => {
  const base = pager(ALL)
  const fetch = async (page: number) => {
    if (page === 3) throw new SourceError('http', 'HTTP 429', 429)
    return base.fetch(page)
  }
  const seen = seenOf(ALL.filter((id) => id < 9081))
  await assert.rejects(scanPages(fetch, seen, { backfill: false, floorId: 7000, idWindow: 300 }), (e: unknown) => {
    assert.ok(e instanceof DeepPageError)
    assert.equal((e as DeepPageError).kind, 'http')
    assert.equal((e as DeepPageError).status, 429)
    assert.match((e as Error).message, /^page 3: HTTP 429/)
    return true
  })
})

test('1페이지 검증은 그대로다 — 순서가 깨지거나 최댓값이 뒤로 가면 실패한다', async () => {
  const shuffled = pager(ALL, { 1: [9100, 9098, 9099, ...range(9097, 9081)].map(product) })
  await assert.rejects(scanPages(shuffled.fetch, new Set(), { backfill: false }), (e: unknown) => {
    assert.ok(e instanceof SourceError && !(e instanceof DeepPageError))
    return true
  })
  const regressed = pager(ALL)
  await assert.rejects(scanPages(regressed.fetch, new Set(['9500']), { backfill: false }), /feed regressed/)
})

test('SYDE: 목록 20건이 전부 처음 보는 것이면 창 넘침이다', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`)
  assert.match(sydeOverflow(ids, new Set(['old'])) ?? '', /all 20 listed showcases are new/)
  assert.equal(sydeOverflow(ids, new Set(['id-19'])), undefined)
  // 최초 실행은 전부 새것이 당연하다
  assert.equal(sydeOverflow(ids, new Set()), undefined)
})
