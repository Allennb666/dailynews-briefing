import { DOMAIN_CONFIGS } from './sources.js'
import { cleanEventMaterial, cleanUrl, compareCandidates, isImplausiblyFuture, stripHtml, type Candidate, type NewsEvent } from './pipeline.js'

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, parsed)) : fallback
}

type PageMaterial = {
  text: string | null
  publishedAt: string | null
}

export type DateRecoveryRecord = {
  url: string
  domain: Candidate['domain']
  candidateId: string
  status: 'recovered' | 'missing' | 'expired' | 'future-dated'
  publishedAt: string | null
}

function validIsoDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function findJsonLdPublishedAt(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonLdPublishedAt(item)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const direct = validIsoDate(record.datePublished)
  if (direct) return direct
  for (const nested of Object.values(record)) {
    const found = findJsonLdPublishedAt(nested)
    if (found) return found
  }
  return null
}

function attributes(tag: string) {
  const values = new Map<string, string>()
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    values.set(match[1].toLocaleLowerCase(), match[3].trim())
  }
  return values
}

export function extractPublishedAtFromHtml(html: string) {
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findJsonLdPublishedAt(JSON.parse(match[2]))
      if (found) return found
    } catch {
      // Ignore malformed JSON-LD and continue to explicit metadata.
    }
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLocaleLowerCase()
    if (key === 'article:published_time' || key === 'datepublished') {
      const found = validIsoDate(attrs.get('content'))
      if (found) return found
    }
  }
  for (const match of html.matchAll(/<time\b[^>]*>/gi)) {
    const found = validIsoDate(attributes(match[0]).get('datetime'))
    if (found) return found
  }
  return null
}

export class ArticleReader {
  readonly limit: number
  attempted = 0
  succeeded = 0
  metadataAttempted = 0
  metadataRecovered = 0
  readonly dateRecoveryRecords: DateRecoveryRecord[] = []
  private readonly cache = new Map<string, Promise<PageMaterial>>()

  constructor(
    limit = boundedInteger(process.env.ARTICLE_FETCH_LIMIT, 30, 30),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.limit = Math.min(30, Math.max(0, limit))
  }

  private load(url: string) {
    const key = cleanUrl(url)
    const cached = this.cache.get(key)
    if (cached) return cached
    if (this.attempted >= this.limit) return Promise.resolve({ text: null, publishedAt: null })
    this.attempted += 1
    const pending = this.fetchPage(key)
    this.cache.set(key, pending)
    return pending
  }

  private async fetchPage(url: string): Promise<PageMaterial> {
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          'User-Agent': 'DailyNews/0.4 (+personal news research; respects access controls)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1_000, this.timeoutMs))),
      })
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return { text: null, publishedAt: null }
      const html = (await response.text()).slice(0, 1_500_000)
      const publishedAt = extractPublishedAtFromHtml(html)
      if (/subscribe to continue|sign in to continue|enable javascript to continue|metered paywall/i.test(html)) {
        return { text: null, publishedAt }
      }
      const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html
      const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((match) => stripHtml(match[1]))
        .filter((text) => text.length >= 40)
      const text = paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 12_000)
      if (text.length < 280) return { text: null, publishedAt }
      this.succeeded += 1
      return { text, publishedAt }
    } catch {
      return { text: null, publishedAt: null }
    }
  }

  async read(url: string) {
    return (await this.load(url)).text
  }

  async readPublishedAt(url: string) {
    return (await this.load(url)).publishedAt
  }
}

export async function recoverMissingCandidateDates(
  candidates: Candidate[],
  reader: ArticleReader,
  now = new Date(),
  limit = 8,
) {
  const reliability = { primary: 4, 'tier-1': 3, 'tier-2': 2, other: 1 }
  const remaining = Math.max(0, 8 - reader.metadataAttempted)
  const unknownByUrl = new Map<string, Candidate[]>()
  for (const candidate of candidates.filter((item) => item.dateConfidence === 'unknown')) {
    const url = cleanUrl(candidate.url)
    const group = unknownByUrl.get(url) ?? []
    group.push(candidate)
    unknownByUrl.set(url, group)
  }
  const unknown = [...unknownByUrl.entries()]
    .map(([url, copies]) => ({ url, copies: copies.sort(compareCandidates) }))
    .sort((a, b) => reliability[b.copies[0].source.reliability] - reliability[a.copies[0].source.reliability]
      || compareCandidates(a.copies[0], b.copies[0]) || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, Math.min(remaining, limit)))
  const rejected = new Set<string>()
  for (const group of unknown) {
    reader.metadataAttempted += 1
    const recovered = await reader.readPublishedAt(group.url)
    if (!recovered) {
      for (const candidate of group.copies) reader.dateRecoveryRecords.push({
        url: group.url,
        domain: candidate.domain,
        candidateId: candidate.id,
        status: 'missing',
        publishedAt: null,
      })
      continue
    }
    const recoveredTime = new Date(recovered).getTime()
    let recoveredAny = false
    for (const candidate of group.copies) {
      const ageDays = (now.getTime() - recoveredTime) / 86_400_000
      if (!Number.isFinite(recoveredTime) || ageDays > DOMAIN_CONFIGS[candidate.domain].sourceWindowDays || isImplausiblyFuture(recoveredTime, now)) {
        const status = isImplausiblyFuture(recoveredTime, now) ? 'future-dated' : 'expired'
        rejected.add(`${candidate.domain}:${candidate.id}`)
        reader.dateRecoveryRecords.push({
          url: group.url,
          domain: candidate.domain,
          candidateId: candidate.id,
          status,
          publishedAt: Number.isFinite(recoveredTime) ? new Date(recoveredTime).toISOString() : null,
        })
        continue
      }
      const ageHours = Math.max(0, (now.getTime() - recoveredTime) / 3_600_000)
      candidate.publishedAt = new Date(recoveredTime).toISOString()
      candidate.dateConfidence = 'reliable'
      candidate.score += 20 + Math.max(0, 36 - ageHours / 4)
      recoveredAny = true
      reader.dateRecoveryRecords.push({
        url: group.url,
        domain: candidate.domain,
        candidateId: candidate.id,
        status: 'recovered',
        publishedAt: candidate.publishedAt,
      })
    }
    if (recoveredAny) reader.metadataRecovered += 1
  }
  return candidates.filter((candidate) => !rejected.has(`${candidate.domain}:${candidate.id}`))
}

export async function materializeEvents(events: NewsEvent[], reader: ArticleReader) {
  for (const event of events) {
    const articles = [...event.articles].sort((a, b) => {
      const reliability = { primary: 4, 'tier-1': 3, 'tier-2': 2, other: 1 }
      return reliability[b.source.reliability] - reliability[a.source.reliability] || b.score - a.score
    })
    for (const article of articles.slice(0, 3)) {
      const fullText = await reader.read(article.url)
      if (fullText) {
        article.fullText = cleanEventMaterial(article.title, fullText, article.domain)
        article.materialLevel = 'full-text'
      }
      if (reader.attempted >= reader.limit) return
    }
  }
}
