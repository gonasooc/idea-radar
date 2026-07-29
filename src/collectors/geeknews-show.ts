import { getText } from '../http.ts'
import { clean } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectContext, CollectResult, Collector, RawItem } from '../types.ts'

const BASE = 'https://news.hada.io'
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ko-KR,ko;q=0.9',
}

const ROW =
  /<div class='topic_row' data-topic-state-id='(\d+)'([\s\S]*?)(?=<div class='topic_row' data-topic-state-id=|<div class='next commentTD'>)/g
const DETAIL = /<div class='topictitle(?: link)?'>[\s\S]*?<a href='([^']+)' class='bold ud'><h1>([\s\S]*?)<\/h1>/
const DETAIL_TITLE_ONLY = /<div class='topictitle[^']*'>[\s\S]*?<h1>([\s\S]*?)<\/h1>/
const META_DESC = /<meta name="description" content="([^"]*)"/

type ListRow = {
  nativeId: string
  title: string
  description: string
  publishedAt?: string
}

function parseListPage(html: string): { rows: ListRow[]; showGnCount: number; fieldOkCount: number } {
  const rows: ListRow[] = []
  let showGnCount = 0
  let fieldOkCount = 0
  for (const m of html.matchAll(ROW)) {
    const block = m[2]
    const titleRaw = /<h2 class='topic-title-heading'>([\s\S]*?)<\/h2>/.exec(block)?.[1] ?? ''
    const descRaw = /<div class='topicdesc'><a [^>]*>([\s\S]*?)<\/a><\/div>/.exec(block)?.[1] ?? ''
    const datetime = /datetime="([^"]+)"/.exec(block)?.[1]
    const title = clean(titleRaw)
    const publishedAt = datetime && !Number.isNaN(Date.parse(datetime)) ? new Date(datetime).toISOString() : undefined
    if (title && publishedAt) fieldOkCount++
    if (/^Show\s*GN/.test(title)) showGnCount++
    rows.push({ nativeId: m[1], title, description: clean(descRaw), publishedAt })
  }
  return { rows, showGnCount, fieldOkCount }
}

function acceptExternal(raw: string | null): string | undefined {
  if (!raw || !/^https?:\/\//.test(raw)) return undefined
  try {
    if (new URL(raw).hostname === 'news.hada.io') return undefined
  } catch {
    return undefined
  }
  return raw
}

async function collectFromShowPages(ctx: CollectContext, warnings: string[]): Promise<CollectResult> {
  const pageCount = ctx.seed ? 3 : 2
  const pages: string[] = []
  for (let p = 1; p <= pageCount; p++) {
    try {
      const res = await getText(`${BASE}/show?page=${p}`, { headers: HEADERS, timeoutMs: 10000, retryDelaysMs: [2000] })
      if (!res.contentType.includes('text/html')) throw new SourceError('parse', `page ${p}: content-type ${res.contentType}`)
      if (res.body.length <= 15000) throw new SourceError('parse', `page ${p}: body too small (${res.body.length})`)
      pages.push(res.body)
    } catch (e) {
      if (p === 3) {
        warnings.push('geeknews-show: seed page 3 fetch failed, continuing with pages 1-2')
        break
      }
      throw e
    }
  }

  const parsed = pages.map(parseListPage)
  const allRows = parsed.flatMap((p) => p.rows)
  const parsedCount = allRows.length
  if (parsed[0].rows.length < 10) throw new SourceError('parse', `page 1 rows ${parsed[0].rows.length} < 10 — markup changed`)
  const fieldOk = parsed.reduce((n, p) => n + p.fieldOkCount, 0)
  if (fieldOk / parsedCount < 0.9) throw new SourceError('parse', `title+datetime ok ratio ${fieldOk}/${parsedCount} < 0.9`)
  const showGn = parsed.reduce((n, p) => n + p.showGnCount, 0)
  if (showGn / parsedCount < 0.8) throw new SourceError('parse', `Show GN ratio ${showGn}/${parsedCount} < 0.8 — wrong section?`)

  const newestPage1 = parsed[0].rows.map((r) => (r.publishedAt ? Date.parse(r.publishedAt) : 0)).reduce((a, b) => Math.max(a, b), 0)
  if (newestPage1 < Date.now() - 7 * 24 * 3600 * 1000) {
    throw new SourceError('parse', 'newest publishedAt on page 1 is older than 7 days')
  }

  const byId = new Map<string, ListRow>()
  for (const r of allRows) if (!byId.has(r.nativeId)) byId.set(r.nativeId, r)

  const items: RawItem[] = []
  let detailTried = 0
  let detailExternalOk = 0
  let fullTitleSeen = false
  let newCount = 0
  for (const row of byId.values()) {
    let title = row.title
    let description = row.description
    let externalUrl: string | undefined
    if (!ctx.seen.has(row.nativeId)) {
      newCount++
      try {
        detailTried++
        const res = await getText(`${BASE}/topic?id=${row.nativeId}`, { headers: HEADERS, timeoutMs: 10000, retryDelaysMs: [2000] })
        const d = DETAIL.exec(res.body)
        if (d) {
          const fullTitle = clean(d[2])
          if (fullTitle) {
            if (fullTitle !== title) fullTitleSeen = true
            title = fullTitle
          }
          externalUrl = acceptExternal(d[1])
          if (externalUrl) detailExternalOk++
        } else {
          const t = DETAIL_TITLE_ONLY.exec(res.body)
          if (t) {
            const fullTitle = clean(t[1])
            if (fullTitle) title = fullTitle
          }
        }
        if (!description) {
          const md = META_DESC.exec(res.body)
          if (md) description = clean(md[1])
        }
      } catch {
        warnings.push(`geeknews-show: detail fetch failed for id=${row.nativeId}, keeping list data`)
      }
    }
    const item: RawItem = {
      id: `geeknews-show:${row.nativeId}`,
      source: 'geeknews-show',
      title,
      description,
      url: `${BASE}/topic?id=${row.nativeId}`,
    }
    if (externalUrl) item.externalUrl = externalUrl
    if (row.publishedAt) item.publishedAt = row.publishedAt
    items.push(item)
  }

  for (const it of items) {
    if (!/^geeknews-show:\d+$/.test(it.id)) throw new SourceError('parse', `bad id ${it.id}`)
    if (!/^https:\/\/news\.hada\.io\/topic\?id=\d+$/.test(it.url)) throw new SourceError('parse', `bad url ${it.url}`)
  }
  const recent = items.some((i) => i.publishedAt && Date.parse(i.publishedAt) > Date.now() - 72 * 3600 * 1000)
  if (!recent) warnings.push('geeknews-show: no item published within 72h — inflow may have stopped')
  if (detailTried > 0 && detailExternalOk / detailTried < 0.8) {
    warnings.push(`geeknews-show: externalUrl extraction ${detailExternalOk}/${detailTried} < 0.8 — detail markup may have changed`)
  }
  if (newCount >= 10 && !fullTitleSeen) {
    warnings.push('geeknews-show: no full title differed from list titles across 10+ new items — detail parsing may be broken')
  }
  return { parsedCount, items, warnings }
}

async function collectFromAtomFallback(warnings: string[]): Promise<CollectResult> {
  const res = await getText(`${BASE}/rss/news`, {
    headers: { Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
    timeoutMs: 10000,
    retryDelaysMs: [2000],
  })
  const entries = [...res.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  const items: RawItem[] = []
  for (const e of entries) {
    const id = /<id>https:\/\/news\.hada\.io\/topic\?id=(\d+)<\/id>/.exec(e)?.[1]
    const titleRaw = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(e)?.[1]
    if (!id || !titleRaw) continue
    const title = clean(titleRaw)
    if (!title.startsWith('Show GN')) continue
    const published = /<published>([^<]+)<\/published>/.exec(e)?.[1]
    const contentRaw = /<content type='html' xml:lang='ko'><!\[CDATA\[([\s\S]*?)\]\]><\/content>/.exec(e)?.[1]
    const item: RawItem = {
      id: `geeknews-show:${id}`,
      source: 'geeknews-show',
      title,
      description: contentRaw ? clean(contentRaw) : '',
      url: `${BASE}/topic?id=${id}`,
    }
    if (published && !Number.isNaN(Date.parse(published))) item.publishedAt = new Date(published).toISOString()
    items.push(item)
  }
  if (items.length === 0) throw new SourceError('parse', 'Atom fallback yielded 0 Show GN entries')
  warnings.push('geeknews-show: FALLBACK B (Atom feed) in use — misses ~half of Show posts, fix /show parser soon')
  return { parsedCount: entries.length, items, warnings }
}

export const geeknewsShow: Collector = {
  key: 'geeknews-show',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const warnings: string[] = []
    try {
      return await collectFromShowPages(ctx, warnings)
    } catch (primaryError) {
      try {
        return await collectFromAtomFallback(warnings)
      } catch {
        throw primaryError
      }
    }
  },
}
