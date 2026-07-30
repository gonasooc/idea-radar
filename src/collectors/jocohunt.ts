import { concatFlight, sliceBalanced } from '../flight.ts'
import { getText } from '../http.ts'
import { collapse, decodeEntities, truncate300 } from '../text.ts'
import { SourceError } from '../types.ts'
import type { CollectContext, CollectResult, Collector, RawItem } from '../types.ts'

const BASE = 'https://jocohunt.com'
const SLUG_RE = /^[A-Za-z0-9_-]{4,32}$/
const HTML_HEADERS = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' }
const DETAIL_CAP = 10
const CANDIDATE_WINDOW_DAYS = 30
const NEW_HARD_CAP = 25

type HomeProduct = { slug: string; name: string; tagline?: string; launchedAtMs: number }

function parseSitemap(xml: string): Map<string, string> {
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? []
  const map = new Map<string, string>()
  let dup = 0
  for (const b of blocks) {
    const slug = /<loc>\s*https:\/\/jocohunt\.com\/p\/([A-Za-z0-9_-]+)\s*<\/loc>/.exec(b)?.[1]
    if (!slug) continue
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(b)?.[1]
    if (!lastmod || Number.isNaN(Date.parse(lastmod))) throw new SourceError('parse', `sitemap lastmod unparseable for /p/${slug}`)
    if (map.has(slug)) dup++
    map.set(slug, lastmod)
  }
  if (map.size < 100) throw new SourceError('parse', `sitemap has ${map.size} /p/ urls < 100 — format changed`)
  if (dup > 0) throw new SourceError('parse', `sitemap has ${dup} duplicate slugs`)
  return map
}

function parseHomeProducts(html: string, sitemap: Map<string, string>): Map<string, HomeProduct> {
  const { text: flight, chunkCount } = concatFlight(html)
  if (chunkCount < 10) throw new SourceError('parse', `home flight chunks ${chunkCount} < 10`)
  if (flight.length <= 50000) throw new SourceError('parse', `home flight length ${flight.length} <= 50000`)
  const i = flight.indexOf('"products":[')
  if (i === -1) throw new SourceError('parse', 'home flight has no "products":[')
  const raw = sliceBalanced(flight, i + '"products":'.length)
  if (!raw) throw new SourceError('parse', 'home products bracket matching failed')
  const products = JSON.parse(raw) as HomeProduct[]
  if (!Array.isArray(products)) throw new SourceError('parse', 'home products is not an array')
  // 빈 배열은 파싱 실패가 아니다. 2026-07-30 사이트 개편으로 이 컴포넌트("방금 올라온 프로덕트")가
  // 탭 방식(인기순/최신순/토론 많은)이 되면서 SSR 페이로드가 항상 []로 오고, 실제 제품은
  // 렌더된 RSC 엘리먼트 트리로만 남았다. 발견의 정본은 어차피 sitemap이고(spec 함정 1),
  // "조용히 0건"은 아래 H15 단언이 따로 잡는다. 여기서 throw 하면 매 실행 경고가 뜬다.
  if (products.length === 0) return new Map()
  for (const p of products) {
    const ok =
      typeof p.slug === 'string' &&
      SLUG_RE.test(p.slug) &&
      typeof p.name === 'string' &&
      p.name.trim() !== '' &&
      Number.isInteger(p.launchedAtMs) &&
      p.launchedAtMs > 1_700_000_000_000 &&
      p.launchedAtMs < Date.now() + 86_400_000
    if (!ok) throw new SourceError('parse', `home product failed validation: ${JSON.stringify(p).slice(0, 200)}`)
    if (!sitemap.has(p.slug)) throw new SourceError('parse', `home slug ${p.slug} missing from sitemap — parse contamination`)
  }
  const first = products[0]
  const lastmod = sitemap.get(first.slug)
  if (lastmod !== undefined && Math.abs(Date.parse(lastmod) - first.launchedAtMs) > 1000) {
    throw new SourceError('parse', `launchedAtMs no longer matches sitemap lastmod for ${first.slug}`)
  }
  return new Map(products.map((p) => [p.slug, p]))
}

function attrDecode(s: string): string {
  return truncate300(collapse(decodeEntities(s)))
}

type DetailData = { title?: string; description?: string; externalUrl?: string }

function parseDetail(html: string): DetailData {
  const out: DetailData = {}
  const ogTitle = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1]
  const ogDesc = /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1]
  if (ogTitle) out.title = attrDecode(ogTitle)
  if (ogDesc) out.description = attrDecode(ogDesc)
  if (!out.title) {
    const t = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]
    if (t) out.title = attrDecode(t).replace(/\s*·\s*조코헌트\s*$/, '').trim()
  }
  try {
    const flight = concatFlight(html).text
    const href = /"href":"(https?:\/\/[^"]+)","event":"product_website_click"/.exec(flight)?.[1]
    if (href && !/^https?:\/\/(www\.)?jocohunt\.com/i.test(href)) out.externalUrl = href
  } catch {}
  return out
}

function assertItem(it: RawItem): void {
  if (!/^jocohunt:[A-Za-z0-9_-]{4,32}$/.test(it.id)) throw new SourceError('parse', `bad id ${it.id}`)
  if (it.url !== `${BASE}/p/${it.id.split(':')[1]}`) throw new SourceError('parse', `url/id mismatch ${it.url}`)
  if (it.title.trim() === '') throw new SourceError('parse', `empty title for ${it.id}`)
  for (const s of [it.title, it.description]) {
    if (/\\u[0-9a-fA-F]{4}|\\"/.test(s)) throw new SourceError('parse', `escaped literals left in text: ${s.slice(0, 80)}`)
    if (/[ìëí]{2}/.test(s)) throw new SourceError('parse', `mojibake detected: ${s.slice(0, 80)}`)
  }
}

export const jocohunt: Collector = {
  key: 'jocohunt',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const warnings: string[] = []
    const home = await getText(`${BASE}/`, { headers: HTML_HEADERS, timeoutMs: 15000, retryDelaysMs: [2000] })
    const sitemapRes = await getText(`${BASE}/sitemap.xml`, {
      headers: { Accept: 'application/xml,text/xml', 'Accept-Language': HTML_HEADERS['Accept-Language'] },
      timeoutMs: 15000,
      retryDelaysMs: [2000],
    })
    if (home.body.length <= 100_000) throw new SourceError('parse', `home body ${home.body.length} <= 100000`)
    if (sitemapRes.body.length <= 30_000) throw new SourceError('parse', `sitemap body ${sitemapRes.body.length} <= 30000`)

    const sitemap = parseSitemap(sitemapRes.body)
    const entries = [...sitemap.entries()].sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    const newestSlug = entries[0][0]
    if (Date.parse(entries[0][1]) < Date.now() - 14 * 24 * 3600 * 1000) {
      warnings.push('jocohunt: newest sitemap entry older than 14 days — site may be stalled')
    }

    let homeMap: Map<string, HomeProduct> | undefined
    try {
      homeMap = parseHomeProducts(home.body, sitemap)
    } catch (e) {
      warnings.push(`jocohunt: home flight parse failed (${(e as Error).message}) — sitemap-only mode`)
    }

    const windowStart = Date.now() - CANDIDATE_WINDOW_DAYS * 24 * 3600 * 1000
    let candidates = entries.filter(([slug, lastmod]) => !ctx.seen.has(slug) && Date.parse(lastmod) >= windowStart)
    if (candidates.length > NEW_HARD_CAP) {
      warnings.push(`jocohunt: ${candidates.length} new candidates capped at ${NEW_HARD_CAP} — check for dedupe breakage`)
      candidates = candidates.slice(0, NEW_HARD_CAP)
    }

    const items: RawItem[] = []
    let detailBudget = DETAIL_CAP
    let deferred = 0
    for (const [slug, lastmod] of candidates) {
      const meta = homeMap?.get(slug)
      let detail: DetailData | undefined
      if (detailBudget > 0) {
        try {
          detailBudget--
          const res = await getText(`${BASE}/p/${slug}`, { headers: HTML_HEADERS, timeoutMs: 15000, retryDelaysMs: [2000] })
          detail = parseDetail(res.body)
        } catch {
          if (!meta) {
            deferred++
            continue
          }
        }
      } else if (!meta) {
        deferred++
        continue
      }
      const title = meta ? truncate300(collapse(meta.name)) : detail?.title
      if (!title) {
        deferred++
        continue
      }
      const item: RawItem = {
        id: `jocohunt:${slug}`,
        source: 'jocohunt',
        title,
        description: meta ? truncate300(collapse(meta.tagline ?? '')) : (detail?.description ?? ''),
        url: `${BASE}/p/${slug}`,
        publishedAt: lastmod,
      }
      if (detail?.externalUrl) item.externalUrl = detail.externalUrl
      assertItem(item)
      items.push(item)
    }
    if (deferred > 0) warnings.push(`jocohunt: ${deferred} candidates deferred to next run (detail budget ${DETAIL_CAP})`)

    if (items.length === 0 && !ctx.seen.has(newestSlug)) {
      throw new SourceError('parse', `0 items produced but newest sitemap slug ${newestSlug} is unseen — parser dead`)
    }
    return { parsedCount: sitemap.size, items, warnings }
  },
}
