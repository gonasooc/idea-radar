import { getText } from '../http.ts'
import { decodeEntities, truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectResult, Collector, RawItem } from '../types.ts'

const WINDOW_HOURS = 96
const API = 'https://hn.algolia.com/api/v1/search_by_date'
const HEADERS = { Accept: 'application/json' }

type Hit = {
  objectID: string
  title: string
  url?: string
  story_text?: string
  created_at: string
  created_at_i: number
  points?: number
  _tags?: string[]
}

type AlgoliaBody = { hits: Hit[]; nbHits: number; nbPages: number }

async function fetchJson(url: string): Promise<AlgoliaBody> {
  const res = await getText(url, { headers: HEADERS, timeoutMs: 20000, retryDelaysMs: [2000, 6000] })
  if (!res.contentType.includes('application/json')) throw new SourceError('parse', `content-type ${res.contentType}`)
  const body = JSON.parse(res.body) as AlgoliaBody
  if (!Array.isArray(body.hits)) throw new SourceError('parse', 'hits is not an array')
  if (typeof body.nbHits !== 'number') throw new SourceError('parse', 'nbHits is not a number')
  return body
}

async function fetchAllPages(baseUrl: string): Promise<Hit[]> {
  const first = await fetchJson(baseUrl)
  let hits = first.hits
  for (let p = 1; p < first.nbPages && hits.length < first.nbHits; p++) {
    const page = await fetchJson(`${baseUrl}&page=${p}`)
    hits = hits.concat(page.hits)
  }
  return hits
}

function assertHits(hits: Hit[], expectWindow: boolean): void {
  if (hits.length < 200) throw new SourceError('parse', `only ${hits.length} hits < 200 — source anomaly`)
  if (hits.length > 5000) throw new SourceError('parse', `${hits.length} hits > 5000 — tags filter broken`)
  const times = hits.map((h) => h.created_at_i)
  const newest = Math.max(...times)
  const oldest = Math.min(...times)
  if (Date.now() / 1000 - newest >= 12 * 3600) throw new SourceError('parse', 'newest hit older than 12h — index stalled')
  if (expectWindow && newest - oldest < 60 * 3600) throw new SourceError('parse', `window coverage ${(newest - oldest) / 3600}h < 60h`)
  if (!hits.every((h) => /^[0-9]+$/.test(h.objectID))) throw new SourceError('parse', 'non-numeric objectID')
  if (!hits.every((h) => typeof h.title === 'string' && h.title.trim().length > 0)) throw new SourceError('parse', 'empty title in hits')
  if (!hits.every((h) => !Number.isNaN(Date.parse(h.created_at)))) throw new SourceError('parse', 'unparseable created_at')
  if (new Set(hits.map((h) => h.objectID)).size !== hits.length) throw new SourceError('parse', 'duplicate objectIDs in response')
  if (!hits.every((h) => Array.isArray(h._tags) && h._tags.includes('show_hn') && h._tags.includes('story'))) {
    throw new SourceError('parse', 'tags filter integrity broken (non show_hn/story hits)')
  }
  const titled = hits.filter((h) => /^show\s*[hn]{2}\b/i.test(h.title)).length
  if (titled / hits.length < 0.95) throw new SourceError('parse', `Show HN title ratio ${titled}/${hits.length} < 0.95`)
}

function toDescription(storyText: string | undefined): string {
  if (!storyText) return ''
  const paras = storyText
    .split(/<p>/)
    .map((p) =>
      decodeEntities(p.replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((p) => p && !/^https?:\/\/\S+$/.test(p))
  let out = ''
  for (const p of paras) {
    out = out ? out + ' ' + p : p
    if (out.length >= 60) break
  }
  if (out.length > 400) out = out.slice(0, 399).replace(/\s+\S*$/, '') + '…'
  return truncate300(out)
}

export const showhn: Collector = {
  key: 'showhn',
  async collect(): Promise<CollectResult> {
    const warnings: string[] = []
    const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600
    const primaryUrl = `${API}?tags=show_hn&hitsPerPage=1000&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`

    let hits: Hit[]
    try {
      hits = await fetchAllPages(primaryUrl)
      assertHits(hits, true)
    } catch (primaryError) {
      try {
        hits = await fetchAllPages(`${API}?tags=show_hn&hitsPerPage=500`)
        assertHits(hits, false)
        warnings.push('showhn: FALLBACK latest-500 without numericFilters in use')
      } catch {
        throw primaryError
      }
    }

    const items: RawItem[] = []
    for (const hit of hits) {
      const item: RawItem = {
        id: `showhn:${hit.objectID}`,
        source: 'showhn',
        title: truncate300(decodeEntities(hit.title).replace(/\s+/g, ' ').trim()),
        description: toDescription(hit.story_text),
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        publishedAt: new Date(hit.created_at).toISOString(),
      }
      const href = hit.story_text?.match(/<a href="([^"]+)"/)?.[1]
      const externalUrl = hit.url || (href ? decodeEntities(href) : undefined)
      if (externalUrl && /^https?:\/\//.test(externalUrl)) item.externalUrl = externalUrl
      if (typeof hit.points === 'number') item.score = hit.points
      items.push(item)
    }

    for (const it of items) {
      if (!/^showhn:[0-9]+$/.test(it.id)) throw new SourceError('parse', `bad id ${it.id}`)
      if (!/^https:\/\/news\.ycombinator\.com\/item\?id=[0-9]+$/.test(it.url)) throw new SourceError('parse', `bad url ${it.url}`)
      if (typeof it.description !== 'string' || [...it.description].length > 401) throw new SourceError('parse', `bad description for ${it.id}`)
      if (it.externalUrl && !/^https?:\/\//.test(it.externalUrl)) throw new SourceError('parse', `bad externalUrl ${it.externalUrl}`)
    }
    const withExternal = items.filter((i) => i.externalUrl).length
    if (withExternal / items.length < 0.9) {
      throw new SourceError('parse', `externalUrl ratio ${withExternal}/${items.length} < 0.90 — href regex or entity decoder broken`)
    }
    const emptyDesc = items.filter((i) => !i.description).length / items.length
    if (emptyDesc < 0.4 || emptyDesc > 0.75) {
      throw new SourceError('parse', `empty description ratio ${emptyDesc.toFixed(2)} outside 0.40–0.75 — story_text parsing broken`)
    }
    return { parsedCount: hits.length, items, warnings }
  },
}
