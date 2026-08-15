import { resolve } from 'node:path'
import type { DiscoveryMethod, DomainId, SourceReliability } from '../shared/briefing.js'
import { FileSearchResultCache } from './search-cache.js'
import type { FeedSource } from './sources.js'

export type SearchHit = {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  score?: number
  publisher?: string
}

export type SearchRequest = {
  query: string
  maxResults: number
}

export interface NewsSearchProvider {
  readonly id: string
  search(request: SearchRequest): Promise<SearchHit[]>
}

export interface SearchResultCache {
  get(query: string): Promise<SearchHit[] | undefined>
  set(query: string, hits: SearchHit[]): Promise<void>
  isComplete(): Promise<boolean>
  markComplete(): Promise<void>
}

type TavilyPayload = {
  results?: Array<{
    title?: string
    url?: string
    content?: string
    published_date?: string
    score?: number
  }>
}

export class TavilySearchProvider implements NewsSearchProvider {
  readonly id = 'tavily'

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search({ query, maxResults }: SearchRequest): Promise<SearchHit[]> {
    const response = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        topic: 'news',
        search_depth: 'basic',
        max_results: Math.max(1, Math.min(10, maxResults)),
        include_answer: false,
        include_images: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Tavily 返回 ${response.status}`)
    const payload = await response.json() as TavilyPayload
    return (payload.results ?? []).flatMap((item) => {
      if (!item.title?.trim() || !item.url?.trim()) return []
      return [{
        title: item.title.trim(),
        url: item.url.trim(),
        snippet: item.content?.trim() ?? '',
        publishedAt: item.published_date,
        score: item.score,
      }]
    })
  }
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(maximum, parsed)) : fallback
}

export type SearchStats = {
  calls: number
  cacheHits: number
  failures: number
  skippedDuplicateQueries: number
  exhausted: boolean
}

export class SearchRuntime {
  readonly dailyLimit: number
  readonly discoveryQueriesPerDomain: number
  readonly secondSourceEventLimit: number
  readonly seenUrls = new Set<string>()
  readonly stats: SearchStats = { calls: 0, cacheHits: 0, failures: 0, skippedDuplicateQueries: 0, exhausted: false }
  private readonly seenQueries = new Set<string>()
  private secondSourceEvents = 0
  private replayOnly = false

  constructor(
    readonly provider: NewsSearchProvider | null,
    limits: { dailyLimit?: number; discoveryQueriesPerDomain?: number; secondSourceEventLimit?: number } = {},
    private readonly cache: SearchResultCache | null = null,
  ) {
    this.dailyLimit = Math.min(32, Math.max(0, limits.dailyLimit ?? 32))
    this.discoveryQueriesPerDomain = Math.min(6, Math.max(0, limits.discoveryQueriesPerDomain ?? 6))
    this.secondSourceEventLimit = Math.min(8, Math.max(0, limits.secondSourceEventLimit ?? 8))
  }

  get enabled() {
    return Boolean(this.provider) || this.replayOnly
  }

  async prepare() {
    this.replayOnly = Boolean(await this.cache?.isComplete())
  }

  get cacheReplay() {
    return this.replayOnly
  }

  async markCacheComplete() {
    if (this.provider || this.replayOnly) await this.cache?.markComplete()
  }

  claimUrl(url: string) {
    if (this.seenUrls.has(url)) return false
    this.seenUrls.add(url)
    return true
  }

  async search(query: string, maxResults = 8): Promise<SearchHit[]> {
    const normalized = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    if ((!this.provider && !this.cache) || !normalized) return []
    if (this.seenQueries.has(normalized)) {
      this.stats.skippedDuplicateQueries += 1
      return []
    }
    this.seenQueries.add(normalized)
    const cached = await this.cache?.get(normalized)
    if (cached) {
      this.stats.cacheHits += 1
      return cached
    }
    if (this.replayOnly) return []
    if (!this.provider) return []
    if (this.stats.calls >= this.dailyLimit) {
      this.stats.exhausted = true
      return []
    }
    this.stats.calls += 1
    try {
      const hits = await this.provider.search({ query, maxResults })
      await this.cache?.set(normalized, hits)
      return hits
    } catch {
      this.stats.failures += 1
      return []
    }
  }

  reserveSecondSourceEvent() {
    if (this.secondSourceEvents >= this.secondSourceEventLimit || this.stats.calls >= this.dailyLimit) return false
    this.secondSourceEvents += 1
    return true
  }
}

export function createSearchRuntimeFromEnvironment(fetchImpl: typeof fetch = fetch, now = new Date()) {
  const providerName = (process.env.NEWS_SEARCH_PROVIDER ?? 'tavily').toLocaleLowerCase()
  const apiKey = process.env.TAVILY_API_KEY?.trim() ?? ''
  const provider = providerName === 'tavily' && apiKey ? new TavilySearchProvider(apiKey, fetchImpl) : null
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
  const cacheDir = process.env.SEARCH_CACHE_DIR?.trim() || resolve('.cache/dailynews')
  const cache = new FileSearchResultCache(resolve(cacheDir, `tavily-${date}.json`), date)
  return new SearchRuntime(provider, {
    dailyLimit: boundedInteger(process.env.DAILY_SEARCH_LIMIT, 32, 32),
    discoveryQueriesPerDomain: boundedInteger(process.env.DISCOVERY_QUERIES_PER_DOMAIN, 6, 6),
    secondSourceEventLimit: boundedInteger(process.env.SECOND_SOURCE_EVENT_LIMIT, 8, 8),
  }, cache)
}

const OFFICIAL_HOSTS = [
  'openai.com', 'anthropic.com', 'nvidia.com', 'amd.com', 'intel.com', 'tsmc.com', 'microsoft.com', 'google.com',
  'federalreserve.gov', 'bls.gov', 'bea.gov', 'sec.gov', 'eia.gov', 'treasury.gov', 'whitehouse.gov',
  'investor.gov', 'un.org', 'nato.int', 'consilium.europa.eu', 'ec.europa.eu',
  'ibo.org', 'oecd.org', 'unesco.org', 'worldbank.org', 'imf.org',
]
const TIER_ONE_HOSTS = [
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com',
  'npr.org', 'theguardian.com', 'dw.com', 'aljazeera.com', 'lemonde.fr',
]
const TIER_TWO_HOSTS = [
  'techcrunch.com', 'semiengineering.com', 'edsurge.com', 'hechingerreport.org', 'insidehighered.com',
  'educationnext.org', 'edscoop.com', 'technologyreview.com',
]

function matchesHost(hostname: string, known: string) {
  return hostname === known || hostname.endsWith(`.${known}`)
}

export function sourceForSearchResult(url: string, publisher?: string): FeedSource {
  let hostname = 'unknown-source'
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLocaleLowerCase()
  } catch {
    // Keep the result usable as an explicitly low-reliability source.
  }
  const official = OFFICIAL_HOSTS.some((host) => matchesHost(hostname, host))
  const reliability: SourceReliability = official
    ? 'primary'
    : TIER_ONE_HOSTS.some((host) => matchesHost(hostname, host))
      ? 'tier-1'
      : TIER_TWO_HOSTS.some((host) => matchesHost(hostname, host))
        ? 'tier-2'
        : 'other'
  return {
    id: hostname,
    name: publisher?.trim() || hostname,
    url: `https://${hostname}`,
    type: official ? 'official' : 'media',
    reliability,
    weight: reliability === 'primary' ? 42 : reliability === 'tier-1' ? 36 : reliability === 'tier-2' ? 31 : 24,
    focused: true,
  }
}

export function discoveryMethodForQuery(query: string, source: FeedSource): DiscoveryMethod {
  return source.type === 'official' || /\bsite:/i.test(query) ? 'official-search' : 'news-search'
}

export const DISCOVERY_QUERY_TEMPLATES: Record<DomainId, string[]> = {
  'ai-tech': [
    'AI infrastructure chips HBM advanced packaging agent AI coding major news today 人工智能 芯片',
    'NVIDIA AMD TSMC semiconductor datacenter earnings supply chain latest',
    'AI agents coding models enterprise adoption regulation latest news',
    'site:nvidia.com OR site:amd.com OR site:tsmc.com AI chip announcement',
    'site:openai.com OR site:anthropic.com OR site:google.com AI model research product',
    '中国 AI 芯片 算力 智能体 AI Coding 产业 最新进展',
  ],
  markets: [
    'global markets index bond yields oil price major earnings today 市场 指数 油价',
    'Federal Reserve interest rates inflation CPI PCE Treasury yields latest',
    'major company earnings guidance investor relations SEC filing today',
    'site:federalreserve.gov OR site:bls.gov OR site:bea.gov rates inflation employment GDP',
    'site:sec.gov earnings filing investor relations material event',
    'site:eia.gov crude oil price inventory energy outlook market',
  ],
  world: [
    'geopolitics conflict ceasefire sanctions diplomacy energy shipping food security latest',
    'China US EU technology security export controls trade latest news',
    'Middle East Europe Asia conflict energy shipping verified latest',
    'site:un.org conflict humanitarian food energy official statement',
    'site:nato.int OR site:consilium.europa.eu security sanctions official statement',
    '国际 地缘冲突 能源 航运 粮食 科技安全 最新进展',
  ],
  learning: [
    'IB education curriculum assessment reform AI literacy learning science latest',
    'AI literacy schools teachers assessment curriculum learning science research',
    'education policy curriculum assessment reform international latest 教育 学习科学',
    'site:ibo.org IB curriculum assessment AI education',
    'site:oecd.org education skills AI literacy assessment',
    'site:unesco.org education AI literacy curriculum teachers',
  ],
}

export function buildDiscoveryQueries(domain: DomainId, previousEntities: string[] = [], limit = 6) {
  const suffix = previousEntities.filter(Boolean).slice(0, 3).join(' ')
  return DISCOVERY_QUERY_TEMPLATES[domain]
    .slice(0, Math.min(6, Math.max(0, limit)))
    .map((query, index) => index < 2 && suffix ? `${query} follow-up ${suffix}` : query)
}
