import { concatFlight, sliceBalanced } from '../flight.ts'
import { getText } from '../http.ts'
import { truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectContext, CollectResult, Collector, RawItem } from '../types.ts'

const HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ShowcaseRow = {
  id: string
  name: string
  slug: string
  short_description?: string
  created_at: string
}

function scanFallbackRows(flight: string): ShowcaseRow[] {
  const START = /\{"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}","name":"/g
  const rows: ShowcaseRow[] = []
  let m: RegExpExecArray | null
  while ((m = START.exec(flight)) !== null) {
    const s = sliceBalanced(flight, m.index)
    if (s) {
      try {
        const o = JSON.parse(s) as ShowcaseRow
        if (o.slug && o.name && o.created_at) rows.push(o)
      } catch {}
    }
    START.lastIndex = m.index + 1
  }
  const byId = new Map<string, ShowcaseRow>()
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r)
  return [...byId.values()]
}

function normalizeExternal(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

async function fetchExternalUrl(slug: string): Promise<string | undefined> {
  const res = await getText(`https://syde.kr/showcase/${encodeURIComponent(slug)}`, {
    headers: HEADERS,
    timeoutMs: 15000,
    retryDelaysMs: [2000],
  })
  const flight = concatFlight(res.body).text
  const i = flight.indexOf('"showcase":')
  if (i === -1) return undefined
  const raw = sliceBalanced(flight, i + '"showcase":'.length)
  if (!raw) return undefined
  const detail = JSON.parse(raw) as { web_url?: unknown; appstore_url?: unknown; playstore_url?: unknown }
  return normalizeExternal(detail.web_url) ?? normalizeExternal(detail.appstore_url) ?? normalizeExternal(detail.playstore_url)
}

export const syde: Collector = {
  key: 'syde',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const warnings: string[] = []
    const res = await getText('https://syde.kr/showcase', { headers: HEADERS, timeoutMs: 15000, retryDelaysMs: [2000] })
    if (res.body.length <= 50000) throw new SourceError('parse', `body ${res.body.length} bytes — challenge or error page`)
    const { text: flight, chunkCount } = concatFlight(res.body)
    if (chunkCount < 1) throw new SourceError('parse', 'no __next_f flight chunks found')

    let rows: ShowcaseRow[]
    const KEY = '"initialShowcases":'
    const i = flight.indexOf(KEY)
    if (i !== -1) {
      const raw = sliceBalanced(flight, i + KEY.length)
      if (!raw) throw new SourceError('parse', 'initialShowcases brace matching failed')
      const container = JSON.parse(raw) as { showcases?: unknown; count?: unknown }
      if (!Array.isArray(container.showcases) || container.showcases.length < 10) {
        throw new SourceError('parse', `showcases length ${Array.isArray(container.showcases) ? container.showcases.length : 'n/a'} < 10`)
      }
      if (typeof container.count !== 'number' || container.count <= 0) {
        throw new SourceError('parse', 'container.count missing or non-positive')
      }
      rows = container.showcases as ShowcaseRow[]
      if (rows.length !== 20) warnings.push(`syde: list size ${rows.length} !== 20 — page size changed?`)
    } else {
      rows = scanFallbackRows(flight)
      if (rows.length < 5) throw new SourceError('parse', `initialShowcases key missing and fallback scan found only ${rows.length} rows`)
      warnings.push('syde: initialShowcases key missing — used fallback object scan')
    }

    for (const r of rows) {
      const ok =
        UUID_RE.test(r.id) &&
        typeof r.name === 'string' &&
        r.name.trim().length > 0 &&
        typeof r.slug === 'string' &&
        r.slug.length > 0 &&
        !Number.isNaN(new Date(r.created_at).getTime())
      if (!ok) throw new SourceError('parse', `row failed validation: ${JSON.stringify(r).slice(0, 200)}`)
    }
    if (!rows.some((r) => Date.parse(r.created_at) > Date.now() - 30 * 24 * 3600 * 1000)) {
      throw new SourceError('parse', 'no row created within 30 days — stale data or dead site')
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new SourceError('parse', 'duplicate ids in list')

    const items: RawItem[] = []
    for (const row of rows) {
      const item: RawItem = {
        id: `syde:${row.id}`,
        source: 'syde',
        title: truncate300(row.name.trim()),
        description: truncate300((row.short_description ?? '').trim()),
        url: `https://syde.kr/showcase/${encodeURIComponent(row.slug)}`,
        publishedAt: new Date(row.created_at).toISOString(),
      }
      if (!ctx.seen.has(row.id)) {
        try {
          const externalUrl = await fetchExternalUrl(row.slug)
          if (externalUrl) item.externalUrl = externalUrl
        } catch {
          warnings.push(`syde: detail fetch failed for ${row.slug}, saved without externalUrl`)
        }
      }
      items.push(item)
    }
    return { parsedCount: rows.length, items, warnings }
  },
}
