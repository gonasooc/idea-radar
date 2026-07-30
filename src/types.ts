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

export type SourceStatus = {
  lastSuccessAt: string | null
  lastRawCount: number | null
  consecutiveFailures: number
  lastError: { at: string; kind: ErrorKind; status?: number; message: string } | null
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
