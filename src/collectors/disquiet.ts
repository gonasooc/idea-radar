import { UA_CHROME_WIN, getText } from '../http.ts'
import { collapse, truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectContext, CollectResult, Collector, RawItem } from '../types.ts'

const HEADERS = { Accept: 'application/json' }
const BASE = 'https://disquiet.io/products.json'

// 읽는 범위 (spec 2 "요청", 2026-10-12 실측). Disquiet는 주 1회(월요일 07:15 KST쯤) 100건 넘게
// 한꺼번에 승인하고, 목록은 승인 순이 아니라 id 내림차순이다. 늦게 승인된 옛 id는 지난 배치들
// 사이로 섞여 들어가 최상단에서 1,269 id 아래(48페이지)까지 퍼졌다(95%는 730 id 이내).
// 1~2페이지(40건)만 읽던 동안 매주 앞 40건만 남고 7~10월에 607건이 아무 경보 없이 빠졌다.
export const FLOOR_ID = 7484 // 첫 수집분(2026-07-27 seed)의 최소 id. 이보다 오래된 제품은 수집 대상이 아니다
export const ID_WINDOW = 1500 // 승인일에는 최상단 id에서 이만큼 아래까지 훑는다 — 늦은 승인의 최대 퍼짐 1,269보다 넓게
export const QUIET_PAGES = 2 // 여기까지 새 항목이 없으면 승인일이 아니다. 거기서 멈춘다(평소 요청 2회)
export const MAX_PAGES = 80 // 바닥에 닿기 전에 이 페이지에서 멈추면 창 넘침이다

type Product = {
  id: number
  slug: string
  name: string
  tagline?: string
  url?: string
  approved_at?: string
}

export type ScanOptions = {
  backfill: boolean
  floorId?: number
  idWindow?: number
  quietPages?: number
  maxPages?: number
}

export type ScanResult = {
  products: Product[]
  parsedCount: number
  invalid: number
  pagesRead: number
  bottom: number
  overflow?: string
}

// 1페이지 뒤에서 난 실패. 1페이지만 읽는 폴백으로 넘기면 일부만 저장되고, 저장된 1~2페이지가
// 다음 실행의 멈춤 규칙(QUIET_PAGES)을 통과시켜 나머지를 영영 다시 읽지 않는다. 이번 실행을
// 통째로 실패시켜 아무것도 저장하지 않으면 다음 실행이 처음부터 같은 범위를 다시 읽는다.
export class DeepPageError extends SourceError {}

function isValidProduct(p: unknown): p is Product {
  const o = p as Product
  return (
    typeof o === 'object' &&
    o !== null &&
    Number.isInteger(o.id) &&
    typeof o.slug === 'string' &&
    o.slug.length > 0 &&
    typeof o.name === 'string' &&
    o.name.trim().length > 0
  )
}

async function fetchPage(url: string, retryUa: boolean): Promise<unknown[]> {
  const res = await getText(url, {
    headers: HEADERS,
    timeoutMs: 15000,
    retryDelaysMs: [1000, 4000],
    retryHeaders: retryUa ? { 'User-Agent': UA_CHROME_WIN } : undefined,
  })
  if (!res.contentType.includes('application/json')) {
    throw new SourceError('parse', `content-type ${res.contentType} is not JSON — likely a challenge page`)
  }
  const arr = JSON.parse(res.body)
  if (!Array.isArray(arr)) throw new SourceError('parse', 'response root is not an array')
  return arr
}

function toItems(products: Product[]): RawItem[] {
  const items: RawItem[] = []
  for (const p of products) {
    const item: RawItem = {
      id: `disquiet:${p.id}`,
      source: 'disquiet',
      title: truncate300(collapse(p.name)),
      description: truncate300(collapse(p.tagline ?? '')),
      url: `https://disquiet.io/products/${encodeURIComponent(p.slug)}`,
    }
    if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url)) item.externalUrl = p.url
    if (typeof p.approved_at === 'string' && p.approved_at) item.publishedAt = p.approved_at
    items.push(item)
  }
  for (const it of items) {
    if (!/^disquiet:\d+$/.test(it.id)) throw new SourceError('parse', `bad id ${it.id}`)
    if (!/^https:\/\/disquiet\.io\/products\/.+/.test(it.url)) throw new SourceError('parse', `bad url ${it.url}`)
  }
  return items
}

function validatePage1(page1: unknown[], seen: ReadonlySet<string>): void {
  if (page1.length < 10) throw new SourceError('parse', `page 1 has ${page1.length} rows < 10`)
  const valid = page1.filter(isValidProduct)
  const descending = valid.every((p, i) => i === 0 || (valid[i - 1] as Product).id > p.id)
  if (!descending) throw new SourceError('parse', 'page 1 ids are not descending — ordering rule changed')
  let seenMax = 0
  for (const nativeId of seen) {
    const n = Number(nativeId)
    if (Number.isInteger(n) && n > seenMax) seenMax = n
  }
  const maxId = valid.reduce((a, p) => Math.max(a, p.id), 0)
  if (seenMax > 0 && maxId < seenMax) {
    throw new SourceError('parse', `page 1 max id ${maxId} < known max ${seenMax} — feed regressed`)
  }
}

// 페이지를 위에서부터 읽어 내려간다. 멈추는 곳은 셋이다.
//   - 바닥: 페이지의 최소 id가 bottom 아래로 내려가면 정상 종료. bottom은 승인일 범위(최상단 − ID_WINDOW)와
//     FLOOR_ID 중 높은 쪽이고, 되찾기(backfill)에서는 FLOOR_ID다.
//   - 조용함: QUIET_PAGES까지 새 항목이 하나도 없으면 승인일이 아니다(되찾기에서는 쓰지 않는다).
//   - 창 넘침: 바닥에 닿기 전에 MAX_PAGES에 닿거나 페이지 순서가 깨지면 그 너머를 모른다 → overflow.
//     범위 밖 페이지는 404가 아니라 HTTP 200에 무작위 순서를 준다(spec 2 함정) — 순서 검사가 그걸 막는다.
// 새 글이 스캔 중에 승인되면 페이지가 한 칸씩 밀려 경계에 중복이 생길 수 있다. 그래서 다음 페이지의 최댓값이
// 아니라 최솟값이 앞 페이지보다 아래로 내려갔는지만 본다. 중복은 id로 걸러진다.
export async function scanPages(
  fetch: (page: number) => Promise<unknown[]>,
  seen: ReadonlySet<string>,
  opts: ScanOptions,
): Promise<ScanResult> {
  const floorId = opts.floorId ?? FLOOR_ID
  const idWindow = opts.idWindow ?? ID_WINDOW
  const quietPages = opts.quietPages ?? QUIET_PAGES
  const maxPages = opts.maxPages ?? MAX_PAGES

  const page1 = await fetch(1)
  validatePage1(page1, seen)
  const top = page1.filter(isValidProduct).reduce((a, p) => Math.max(a, p.id), 0)
  const bottom = opts.backfill ? floorId : Math.max(floorId, top - idWindow)

  const byId = new Map<number, Product>()
  let parsedCount = 0
  let invalid = 0
  let unseen = 0
  let prevMin = Infinity
  let page = 1
  let overflow: string | undefined
  for (; ; page++) {
    let rows: unknown[]
    if (page === 1) {
      rows = page1
    } else {
      try {
        rows = await fetch(page)
      } catch (e) {
        const message = `page ${page}: ${e instanceof Error ? e.message : String(e)}`
        if (e instanceof SourceError) throw new DeepPageError(e.kind, message, e.status)
        throw new DeepPageError('parse', message)
      }
    }
    parsedCount += rows.length
    const valid = rows.filter(isValidProduct)
    invalid += rows.length - valid.length
    const descending = valid.every((p, i) => i === 0 || valid[i - 1].id > p.id)
    const pageMin = valid.length > 0 ? valid[valid.length - 1].id : Number.NaN
    if (page > 1 && (valid.length === 0 || !descending || !(pageMin < prevMin))) {
      overflow = `page ${page} broke id order (descending=${descending}, min ${pageMin} vs previous ${prevMin}) before reaching id ${bottom}`
      break
    }
    prevMin = pageMin
    for (const p of valid) {
      if (p.id < bottom || byId.has(p.id)) continue
      byId.set(p.id, p)
      if (!seen.has(String(p.id))) unseen++
    }
    if (pageMin < bottom) break
    if (!opts.backfill && page >= quietPages && unseen === 0) break
    if (page >= maxPages) {
      overflow = `reached page cap ${maxPages} at id ${pageMin} before reaching id ${bottom}`
      break
    }
  }
  return { products: [...byId.values()], parsedCount, invalid, pagesRead: page, bottom, ...(overflow ? { overflow } : {}) }
}

async function collectPrimary(ctx: CollectContext, warnings: string[]): Promise<CollectResult> {
  const scan = await scanPages((page) => fetchPage(`${BASE}?page=${page}`, false), ctx.seen, { backfill: ctx.backfill })
  if (scan.invalid > 0) warnings.push(`disquiet: skipped ${scan.invalid} malformed rows`)
  if (scan.products.length < 10) throw new SourceError('parse', `only ${scan.products.length} valid rows`)
  const emptyTagline = scan.products.filter((p) => !(p.tagline ?? '').trim()).length
  if (emptyTagline / scan.products.length > 0.5) warnings.push('disquiet: >50% empty taglines — field meaning may have changed')
  return {
    parsedCount: scan.parsedCount,
    items: toItems(scan.products),
    warnings,
    ...(scan.overflow ? { overflow: `disquiet: ${scan.overflow} — later approvals may be missed` } : {}),
  }
}

// `?page=` 없이 1페이지만 받는 1차 변형(spec 2 폴백 1). 그 너머를 못 읽으므로, 1페이지에 새 항목이
// 하나라도 있으면 뒤에 더 있을 수 있다 — 창 넘침으로 올린다. 새 항목이 없으면 승인일이 아니다.
async function collectPage1Only(ctx: CollectContext, warnings: string[]): Promise<CollectResult> {
  const page1 = await fetchPage(BASE, true)
  validatePage1(page1, ctx.seen)
  // 스캔과 같은 바닥을 쓴다 — 두 경로가 다른 범위를 받으면 어느 쪽이 돌았느냐에 따라 저장되는 게 달라진다.
  const valid = page1.filter(isValidProduct)
  const bottom = Math.max(FLOOR_ID, valid.reduce((a, p) => Math.max(a, p.id), 0) - ID_WINDOW)
  const byId = new Map<number, Product>()
  for (const p of valid) if (p.id >= bottom && !byId.has(p.id)) byId.set(p.id, p)
  if (byId.size < 10) throw new SourceError('parse', `only ${byId.size} valid rows`)
  warnings.push('disquiet: paged scan failed — read page 1 only')
  const unseen = [...byId.keys()].filter((id) => !ctx.seen.has(String(id))).length
  return {
    parsedCount: page1.length,
    items: toItems([...byId.values()]),
    warnings,
    ...(unseen > 0 ? { overflow: `disquiet: paged scan failed and page 1 alone has ${unseen} new items — later pages unread` } : {}),
  }
}

async function collectHtmlFallback(warnings: string[]): Promise<CollectResult> {
  const res = await getText('https://disquiet.io/products', {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 15000,
    retryDelaysMs: [2000],
  })
  const anchors = [...res.body.matchAll(/<a[^>]+href="\/products\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const bySlug = new Map<string, string>()
  for (const m of anchors) {
    const slug = decodeURIComponent(m[1])
    const title = truncate300(collapse(m[2].replace(/<[^>]+>/g, ' ')))
    if (title && !bySlug.has(slug)) bySlug.set(slug, title)
  }
  if (bySlug.size === 0) throw new SourceError('parse', 'HTML fallback found no product links')
  warnings.push('disquiet: FALLBACK HTML scrape in use — slug-based ids, restore products.json parser soon')
  const items: RawItem[] = [...bySlug.entries()].map(([slug, title]) => ({
    id: `disquiet:slug:${slug}`,
    source: 'disquiet',
    title,
    description: '',
    url: `https://disquiet.io/products/${encodeURIComponent(slug)}`,
  }))
  return { parsedCount: anchors.length, items, warnings }
}

export const disquiet: Collector = {
  key: 'disquiet',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const warnings: string[] = []
    try {
      return await collectPrimary(ctx, warnings)
    } catch (primaryError) {
      // 1페이지 뒤의 실패와 되찾기 실행은 폴백하지 않는다 — 일부만 저장되면 나머지를 다시 읽을 길이
      // 사라진다(DeepPageError 주석). 이번 실행을 실패로 남기고 다음 실행(또는 되찾기 재실행)이 처음부터 읽는다.
      if (primaryError instanceof DeepPageError || ctx.backfill) throw primaryError
      try {
        return await collectPage1Only(ctx, warnings)
      } catch {
        try {
          return await collectHtmlFallback(warnings)
        } catch {
          throw primaryError
        }
      }
    }
  },
}
