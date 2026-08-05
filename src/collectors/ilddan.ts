import { concatFlight, derefText, scanRows, sliceBalanced } from '../flight.ts'
import { getText, sleep } from '../http.ts'
import { clean } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectResult, Collector, RawItem } from '../types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_KEY = '{"mutations":[],"queries":['

// derefText를 거치지 않은 경로가 생겼는지 보는 최후 방어선이다. 실제로 박혔던 행 참조(`$1e`)와
// 값 센티널 중 **모양이 겹칠 수 없는 것만** 센다.
//
// `$`로 시작하면 무조건 잡는 식으로 넓히면 안 된다. escape가 풀린 진짜 설명(`$$100 정산`
// → `$100 정산`)까지 잡혀서 그 제품이 목록에 있는 동안 소스가 매 실행 실패한다 — 항목이
// 안 들어오는 게 아니라 소스가 죽는다. 같은 이유로 `$D…`(Date)·`$n…`(BigInt) 같은
// 접두어 계열도 뺐다: `$Dollar 환율 계산기` 같은 설명과 구분이 안 된다. 그것들은 어차피
// derefText가 undefined로 떨어뜨려 여기까지 오지 않는다.
//
// 남는 모호함 하나: 설명이 **정확히** `$100`이면 행 참조 `$100`과 문자열만으로 구분할 수 없어
// 여기서 잡힌다. 한 줄 설명 전체가 `$100`인 경우 대 참조 토큰이 박히는 경우를 견주면
// 잡는 쪽이 맞다 — 전자는 소스가 하루 실패하고 끝이지만 후자는 영구히 남는다.
const FLIGHT_SENTINEL = /^\$(?:[0-9a-f]+|undefined|Infinity|-Infinity|NaN)$/

type MarketRow = {
  id: string
  created_at: string
  title: string
  description?: string
  file_url?: string
}

type CatResult = { rows: MarketRow[]; fallback: boolean }

function parsePrimary(html: string, cat: string, warnings: string[]): MarketRow[] {
  if (html.length <= 20000) throw new SourceError('parse', `${cat}: body ${html.length} <= 20000`)
  const { text: flight, chunkCount } = concatFlight(html)
  if (chunkCount < 1) throw new SourceError('parse', `${cat}: no flight chunks`)
  const start = flight.indexOf(STATE_KEY)
  if (start < 0) throw new SourceError('parse', `${cat}: dehydrated state key not found`)
  const raw = sliceBalanced(flight, start)
  if (!raw) throw new SourceError('parse', `${cat}: brace matching failed`)
  const state = JSON.parse(raw) as { queries?: { queryKey: unknown[]; state?: { data?: { rows?: unknown; total?: unknown } } }[] }
  if (!Array.isArray(state.queries)) throw new SourceError('parse', `${cat}: queries is not an array`)
  const matches = state.queries.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'market')
  if (matches.length !== 1) throw new SourceError('parse', `${cat}: expected 1 market query, got ${matches.length}`)
  const data = matches[0].state?.data
  const rows = data?.rows
  if (!Array.isArray(rows)) throw new SourceError('parse', `${cat}: rows is not an array`)
  if (rows.length < 1) throw new SourceError('parse', `${cat}: rows empty`)
  if (typeof data?.total === 'number' && rows.length !== Math.min(data.total, 12)) {
    warnings.push(`ilddan ${cat}: rows ${rows.length} !== min(total ${data.total}, 12) — paging behavior changed?`)
  }
  const first = rows[0] as MarketRow
  if (!UUID_RE.test(first.id)) throw new SourceError('parse', `${cat}: rows[0].id is not a uuid`)
  if (typeof first.title !== 'string' || first.title.trim().length === 0) throw new SourceError('parse', `${cat}: rows[0].title empty`)
  if (Number.isNaN(Date.parse(first.created_at))) throw new SourceError('parse', `${cat}: rows[0].created_at unparseable`)
  const expectedKeys = ['id', 'title', 'created_at', 'description', 'file_url']
  if (!rows.every((r) => expectedKeys.every((k) => k in (r as Record<string, unknown>)))) {
    warnings.push(`ilddan ${cat}: some rows missing expected keys — schema drift?`)
  }
  const sorted = rows.every((r, i) => i === 0 || Date.parse((rows[i - 1] as MarketRow).created_at) >= Date.parse((r as MarketRow).created_at))
  if (!sorted) warnings.push(`ilddan ${cat}: rows not sorted by created_at desc`)

  // 긴 description은 인라인이 아니라 `$1e` 참조로 온다. 여기서 풀지 않으면 그 토큰이 그대로
  // 아카이브에 박히고, 항목은 불변이라 영영 못 고친다. 2026-08-05 실측에서 web 12건 중
  // 6건이 참조였고 아카이브 27건 중 10건이 이미 그 상태였다. 해석 실패는 ''로 떨어뜨린다 —
  // 참조 토큰을 저장하는 것보다 빈 설명이 낫고, 아래 경고가 사람에게 알린다.
  const flightRows = scanRows(flight)
  let unresolved = 0
  const marketRows = rows as MarketRow[]
  for (const r of marketRows) {
    const raw = r.description
    const text = derefText(raw, flightRows)
    // `$undefined`는 해석 실패가 아니라 "설명이 없다"는 뜻이다. 이걸 unresolved로 세면
    // 설명 없는 제품이 하나 있을 때마다 "행 표가 불완전하다"는 거짓 경고가 뜬다.
    if (text === undefined && typeof raw === 'string' && raw !== '$undefined') unresolved++
    r.description = text ?? ''
  }
  if (unresolved > 0) {
    warnings.push(`ilddan ${cat}: ${unresolved}/${marketRows.length} description refs unresolved — flight row table incomplete`)
  }
  return marketRows
}

function parseCardFallback(html: string, cat: string, warnings: string[]): MarketRow[] {
  const re = /<a class="pcard" href="\/product\/([0-9a-f-]{36})">[\s\S]*?<span class="ptitle">([\s\S]*?)<\/span>/g
  const rows: MarketRow[] = []
  for (const m of html.matchAll(re)) {
    const title = clean(m[2].replace(/<!--.*?-->/g, ''))
    if (!UUID_RE.test(m[1]) || !title) continue
    rows.push({ id: m[1], title, created_at: '', description: '' })
  }
  if (rows.length === 0) throw new SourceError('parse', `${cat}: HTML card fallback found nothing`)
  warnings.push(`ilddan ${cat}: FALLBACK HTML card parse in use — description/publishedAt missing`)
  return rows
}

export const ilddan: Collector = {
  key: 'ilddan',
  async collect(): Promise<CollectResult> {
    const warnings: string[] = []
    const results: CatResult[] = []
    const errors: Error[] = []
    const cats = ['web', 'game'] as const
    for (const cat of cats) {
      if (cat !== 'web') await sleep(1000)
      try {
        const res = await getText(`https://ilddan.com/market?cat=${cat}`, {
          headers: { Accept: 'text/html' },
          timeoutMs: 15000,
          retryDelaysMs: [2000],
        })
        if (!res.contentType.includes('text/html')) throw new SourceError('parse', `${cat}: content-type ${res.contentType}`)
        try {
          results.push({ rows: parsePrimary(res.body, cat, warnings), fallback: false })
        } catch (primaryError) {
          results.push({ rows: parseCardFallback(res.body, cat, warnings), fallback: true })
          warnings.push(`ilddan ${cat}: primary parse failed: ${(primaryError as Error).message}`)
        }
      } catch (e) {
        errors.push(e as Error)
        warnings.push(`ilddan ${cat}: category failed: ${(e as Error).message}`)
      }
    }
    if (results.length === 0) throw errors[0]

    const allRows = results.flatMap((r) => r.rows)
    const parsedCount = allRows.length
    const byId = new Map<string, MarketRow>()
    for (const r of allRows) {
      if (!UUID_RE.test(r.id) || typeof r.title !== 'string' || !r.title.trim()) continue
      if (!byId.has(r.id)) byId.set(r.id, r)
    }
    if (byId.size === 0) throw new SourceError('parse', 'no valid rows across categories')
    if (parsedCount < 15) warnings.push(`ilddan: only ${parsedCount} rows across categories (expected ~23)`)

    const items: RawItem[] = []
    for (const row of byId.values()) {
      const item: RawItem = {
        id: `ilddan:${row.id}`,
        source: 'ilddan',
        title: clean(row.title),
        description: typeof row.description === 'string' ? clean(row.description) : '',
        url: `https://ilddan.com/product/${row.id}`,
      }
      const fileUrl = (row.file_url ?? '').trim()
      if (/^https?:\/\//i.test(fileUrl)) item.externalUrl = fileUrl
      if (row.created_at && !Number.isNaN(Date.parse(row.created_at))) {
        item.publishedAt = new Date(row.created_at).toISOString()
      }
      items.push(item)
    }
    // 참조 해석이 어떤 경로로든 빠져나가면 여기서 잡는다. 항목은 불변이라 한 번 저장되면
    // 되돌릴 수 없으므로, 이 조건만은 경고가 아니라 소스 실패로 처리한다.
    for (const it of items) {
      if (FLIGHT_SENTINEL.test(it.description)) {
        throw new SourceError('parse', `unresolved flight sentinel stored as description for ${it.id}: ${it.description.slice(0, 40)}`)
      }
    }
    const newest = items.map((i) => (i.publishedAt ? Date.parse(i.publishedAt) : 0)).reduce((a, b) => Math.max(a, b), 0)
    if (newest > 0 && newest < Date.now() - 30 * 24 * 3600 * 1000) {
      warnings.push('ilddan: newest publishedAt older than 30 days — stale cache or dead site?')
    }
    return { parsedCount, items, warnings }
  },
}
