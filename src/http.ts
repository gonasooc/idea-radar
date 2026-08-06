import { SourceError } from './types.ts'

const UA_CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const UA_CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export type GetOptions = {
  headers?: Record<string, string>
  timeoutMs?: number
  retryDelaysMs?: number[]
  retryHeaders?: Record<string, string>
}

export type HttpResponse = {
  status: number
  contentType: string
  body: string
}

let lastRequestAt = 0

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function throttle(): Promise<void> {
  const wait = lastRequestAt + 300 - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504])

async function attempt(url: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpResponse> {
  await throttle()
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA_CHROME_MAC, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new SourceError('timeout', `${url} timed out after ${timeoutMs}ms`)
    }
    throw new SourceError('http', `${url} network error: ${e instanceof Error ? e.message : String(e)}`)
  }
  const body = await res.text()
  if (res.status !== 200) {
    throw new SourceError('http', `${url} returned HTTP ${res.status}`, res.status)
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body }
}

export async function getText(url: string, opts: GetOptions = {}): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const delays = opts.retryDelaysMs ?? [2000]
  let lastError: unknown
  for (let i = 0; i <= delays.length; i++) {
    const headers = i > 0 && opts.retryHeaders ? { ...opts.headers, ...opts.retryHeaders } : (opts.headers ?? {})
    try {
      return await attempt(url, headers, timeoutMs)
    } catch (e) {
      lastError = e
      const retryable =
        e instanceof SourceError && (e.kind === 'timeout' || e.status === undefined || RETRYABLE_STATUS.has(e.status))
      if (!retryable || i === delays.length) break
      await sleep(delays[i])
    }
  }
  throw lastError
}
