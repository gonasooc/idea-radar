import { concatFlight, sliceBalanced } from '../flight.ts'
import { getText, sleep } from '../http.ts'
import { clean } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectResult, Collector, RawItem } from '../types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_KEY = '{"mutations":[],"queries":['

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
  return rows as MarketRow[]
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
    const newest = items.map((i) => (i.publishedAt ? Date.parse(i.publishedAt) : 0)).reduce((a, b) => Math.max(a, b), 0)
    if (newest > 0 && newest < Date.now() - 30 * 24 * 3600 * 1000) {
      warnings.push('ilddan: newest publishedAt older than 30 days — stale cache or dead site?')
    }
    return { parsedCount, items, warnings }
  },
}
