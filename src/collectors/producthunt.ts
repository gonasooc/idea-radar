import { UA_CHROME_WIN, getText, sleep } from '../http.ts'
import { clean, collapse, decodeEntities, truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectResult, Collector, RawItem } from '../types.ts'

const FEED = 'https://www.producthunt.com/feed'
const BASE_HEADERS = {
  Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

type Attempt = { url: string; headers: Record<string, string>; delayMs: number; label: string }

const ATTEMPTS: Attempt[] = [
  { url: FEED, headers: BASE_HEADERS, delayMs: 0, label: 'main' },
  { url: FEED, headers: { ...BASE_HEADERS, 'User-Agent': UA_CHROME_WIN }, delayMs: 2000, label: 'retry-ua' },
  { url: FEED, headers: { ...BASE_HEADERS, 'User-Agent': UA_CHROME_WIN }, delayMs: 8000, label: 'retry-ua-2' },
  { url: `${FEED}?category=tech`, headers: BASE_HEADERS, delayMs: 2000, label: 'category-tech' },
]

async function fetchFeed(warnings: string[]): Promise<string> {
  let lastError: unknown
  for (const a of ATTEMPTS) {
    if (a.delayMs > 0) await sleep(a.delayMs)
    try {
      const res = await getText(a.url, { headers: a.headers, timeoutMs: 15000, retryDelaysMs: [] })
      if (!res.contentType.includes('atom+xml')) {
        throw new SourceError('parse', `content-type ${res.contentType} — likely Cloudflare challenge`)
      }
      if (res.body.length <= 10000 || !res.body.trimStart().startsWith('<?xml')) {
        throw new SourceError('parse', `body does not look like the Atom feed (${res.body.length} bytes)`)
      }
      if (!res.body.includes('xmlns="http://www.w3.org/2005/Atom"')) {
        throw new SourceError('parse', 'Atom namespace missing — feed format changed')
      }
      if (a.label === 'category-tech') {
        warnings.push('producthunt: FALLBACK feed?category=tech in use — main feed unreachable')
      }
      return res.body
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

export const producthunt: Collector = {
  key: 'producthunt',
  async collect(): Promise<CollectResult> {
    const warnings: string[] = []
    const xml = await fetchFeed(warnings)

    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
    const rawEntryCount = entries.length
    if (rawEntryCount < 20) throw new SourceError('parse', `only ${rawEntryCount} entries < 20`)
    if (rawEntryCount !== 50) warnings.push(`producthunt: entry count ${rawEntryCount} !== 50 — feed size changed`)

    const items: RawItem[] = []
    for (const e of entries) {
      const nativeId = /<id>tag:www\.producthunt\.com,2005:Post\/(\d+)<\/id>/.exec(e)?.[1]
      if (!nativeId) continue
      const titleRaw = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1]
      const title = titleRaw ? truncate300(collapse(decodeEntities(titleRaw))) : ''
      if (!title) continue
      const linkRaw = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(e)?.[1]
      if (!linkRaw) continue
      const contentRaw = /<content type="html">([\s\S]*?)<\/content>/.exec(e)?.[1]
      const html = contentRaw ? decodeEntities(contentRaw) : ''
      const firstP = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1]
      const description = firstP ? clean(firstP) : ''
      const externalRaw = /href="(https:\/\/www\.producthunt\.com\/r\/p\/\d+[^"]*)"/.exec(html)?.[1]
      const publishedRaw = /<published>([^<]+)<\/published>/.exec(e)?.[1]

      const item: RawItem = {
        id: `producthunt:${nativeId}`,
        source: 'producthunt',
        title,
        description,
        url: decodeEntities(linkRaw),
      }
      if (externalRaw) item.externalUrl = decodeEntities(externalRaw)
      if (publishedRaw && !Number.isNaN(Date.parse(publishedRaw))) item.publishedAt = new Date(publishedRaw).toISOString()
      items.push(item)
    }

    const byId = new Map<string, RawItem>()
    for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it)
    const deduped = [...byId.values()]

    if (deduped.length < 20) throw new SourceError('parse', `only ${deduped.length} items < 20`)
    if (deduped.length < rawEntryCount * 0.9) {
      throw new SourceError('parse', `entry→item loss over 10% (${deduped.length}/${rawEntryCount})`)
    }
    for (const it of deduped) {
      if (!/^producthunt:\d{4,9}$/.test(it.id)) throw new SourceError('parse', `bad id ${it.id}`)
      if (!it.url.startsWith('https://www.producthunt.com/')) throw new SourceError('parse', `bad url ${it.url}`)
    }
    const withDesc = deduped.filter((i) => i.description !== '').length
    if (withDesc / deduped.length < 0.8) {
      throw new SourceError('parse', `description fill ratio ${withDesc}/${deduped.length} < 0.8 — content structure changed`)
    }
    const withExternal = deduped.filter((i) => i.externalUrl).length
    if (withExternal / deduped.length < 0.8) {
      warnings.push(`producthunt: externalUrl ratio ${withExternal}/${deduped.length} < 0.8 — /r/p/ link format changed?`)
    }
    return { parsedCount: rawEntryCount, items: deduped, warnings }
  },
}
