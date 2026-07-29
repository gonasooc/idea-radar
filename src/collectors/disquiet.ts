import { UA_CHROME_WIN, getText } from '../http.ts'
import { collapse, truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectContext, CollectResult, Collector, RawItem } from '../types.ts'

const HEADERS = { Accept: 'application/json' }

type Product = {
  id: number
  slug: string
  name: string
  tagline?: string
  url?: string
  approved_at?: string
}

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

async function collectPrimary(ctx: CollectContext, warnings: string[], unpaged: boolean): Promise<CollectResult> {
  const base = 'https://disquiet.io/products.json'
  const page1 = await fetchPage(unpaged ? base : `${base}?page=1`, unpaged)
  validatePage1(page1, ctx.seen)
  const page2 = unpaged ? [] : await fetchPage(`${base}?page=2`, false)
  const parsedCount = page1.length + page2.length

  const valid: Product[] = []
  let invalid = 0
  for (const p of [...page1, ...page2]) {
    if (isValidProduct(p)) valid.push(p)
    else invalid++
  }
  if (invalid > 0) warnings.push(`disquiet: skipped ${invalid} malformed rows`)
  if (valid.length < 10) throw new SourceError('parse', `only ${valid.length} valid rows`)

  const byId = new Map<number, Product>()
  for (const p of valid) if (!byId.has(p.id)) byId.set(p.id, p)
  const emptyTagline = valid.filter((p) => !(p.tagline ?? '').trim()).length
  if (emptyTagline / valid.length > 0.5) warnings.push('disquiet: >50% empty taglines — field meaning may have changed')
  return { parsedCount, items: toItems([...byId.values()]), warnings }
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
      return await collectPrimary(ctx, warnings, false)
    } catch (primaryError) {
      try {
        return await collectPrimary(ctx, warnings, true)
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
