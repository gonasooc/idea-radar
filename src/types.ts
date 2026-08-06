export const SOURCE_KEYS = [
  'geeknews-show',
  'disquiet',
  'syde',
  'jocohunt',
  'ilddan',
  'producthunt',
  'showhn',
] as const

export type SourceKey = (typeof SOURCE_KEYS)[number]

export type Item = {
  id: string
  source: SourceKey
  title: string
  description: string
  url: string
  externalUrl?: string
  publishedAt?: string
  collectedAt: string
  collectedDate: string
  score?: number
}

export type RawItem = Omit<Item, 'collectedAt' | 'collectedDate'>

export type CollectResult = {
  parsedCount: number
  items: RawItem[]
  warnings: string[]
  // 아카이브 항목 밖에서 갱신되는 현재 점수. showhn만 채운다 (SPEC 2.2 예외).
  scores?: Record<string, number>
}

export type ErrorKind = 'http' | 'parse' | 'timeout'

export class SourceError extends Error {
  kind: ErrorKind
  status?: number

  constructor(kind: ErrorKind, message: string, status?: number) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

export type CollectContext = {
  seen: ReadonlySet<string>
  seed: boolean
}

export type Collector = {
  key: SourceKey
  collect(ctx: CollectContext): Promise<CollectResult>
}

// "소스는 계속 성공하는데 신규가 안 들어오는" 상태 (SPEC 4.5 여섯 번째). 임계값을 넘은
// 소스에만 붙는다 — 정상일 때 키를 빼 두어야 건강한 날의 manifest diff가 0줄로 남는다.
// days가 null이면 최근 2개 월 샤드 어디에도 기록이 없다는 뜻이다(임계값보다 오래됨이 확정).
export type StaleNew = { days: number | null; lastNewDate: string | null }

export type SourceStatus = {
  lastSuccessAt: string | null
  lastRawCount: number | null
  consecutiveFailures: number
  lastError: { at: string; kind: ErrorKind; status?: number; message: string } | null
  staleNew?: StaleNew
}

export type MonthEntry = {
  key: string
  hasShowhn: boolean
  counts: Record<string, number>
}

export type Manifest = {
  schemaVersion: 1
  updatedAt: string
  lastCollectedDate: string
  months: MonthEntry[]
  sources: Partial<Record<SourceKey, SourceStatus>>
}
