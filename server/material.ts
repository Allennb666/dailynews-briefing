import type { NewsEvent } from './pipeline.js'
import { stripHtml } from './pipeline.js'

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, parsed)) : fallback
}

export class ArticleReader {
  readonly limit: number
  attempted = 0
  succeeded = 0
  private readonly seen = new Set<string>()

  constructor(
    limit = boundedInteger(process.env.ARTICLE_FETCH_LIMIT, 30, 30),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.limit = Math.min(30, Math.max(0, limit))
  }

  async read(url: string) {
    if (this.seen.has(url) || this.attempted >= this.limit) return null
    this.seen.add(url)
    this.attempted += 1
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          'User-Agent': 'DailyNews/0.3 (+personal news research; respects access controls)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return null
      const html = (await response.text()).slice(0, 1_500_000)
      if (/subscribe to continue|sign in to continue|enable javascript to continue|metered paywall/i.test(html)) return null
      const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html
      const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((match) => stripHtml(match[1]))
        .filter((text) => text.length >= 40)
      const text = paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 12_000)
      if (text.length < 280) return null
      this.succeeded += 1
      return text
    } catch {
      return null
    }
  }
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
        article.fullText = fullText
        article.materialLevel = 'full-text'
      }
      if (reader.attempted >= reader.limit) return
    }
  }
}
