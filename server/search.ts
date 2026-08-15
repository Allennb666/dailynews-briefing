import { resolve } from 'node:path'
import type { DiscoveryMethod, DomainId, SourceReliability } from '../shared/briefing.js'
import { FileSearchResultCache } from './search-cache.js'
import { DOMAIN_CONFIGS, type FeedSource } from './sources.js'

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
  startDate?: string
  endDate?: string
  includeDomains?: string[]
}

export type SearchOptions = Omit<SearchRequest, 'query' | 'maxResults'>

export type SearchPhase = 'base' | 'dynamic' | 'verification'

export type SearchAllocation = {
  domain: DomainId
  phase: SearchPhase
}

export type SearchTrace = {
  domain: DomainId | null
  phase: SearchPhase | null
  query: string
  maxResults: number
  startDate: string | null
  endDate: string | null
  includeDomains: string[]
  resultCount: number
  outcome: 'completed' | 'cache-hit' | 'duplicate-query' | 'replay-miss' | 'disabled' | 'quota-exhausted' | 'failed'
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

  async search({ query, maxResults, startDate, endDate, includeDomains }: SearchRequest): Promise<SearchHit[]> {
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
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
        ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
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
  readonly baseDiscoveryQueriesPerDomain = 4
  readonly dynamicQueriesPerDomain = 2
  readonly secondSourceEventLimit: number
  readonly stats: SearchStats = { calls: 0, cacheHits: 0, failures: 0, skippedDuplicateQueries: 0, exhausted: false }
  readonly traces: SearchTrace[] = []
  private readonly seenQueries = new Set<string>()
  private readonly phaseCalls = new Map<string, number>()
  private readonly verificationEvents = new Map<DomainId, number>()
  private replayOnly = false

  constructor(
    readonly provider: NewsSearchProvider | null,
    limits: { dailyLimit?: number; secondSourceEventLimit?: number } = {},
    private readonly cache: SearchResultCache | null = null,
  ) {
    this.dailyLimit = Math.min(32, Math.max(0, limits.dailyLimit ?? 32))
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

  callsFor(domain: DomainId, phase: SearchPhase) {
    return this.phaseCalls.get(`${domain}:${phase}`) ?? 0
  }

  async search(
    query: string,
    maxResults = 8,
    options: SearchOptions = {},
    allocation?: SearchAllocation,
  ): Promise<SearchHit[]> {
    const normalized = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    const includeDomains = [...new Set(options.includeDomains ?? [])].sort()
    const trace = (outcome: SearchTrace['outcome'], resultCount = 0) => {
      this.traces.push({
        domain: allocation?.domain ?? null,
        phase: allocation?.phase ?? null,
        query: normalized,
        maxResults,
        startDate: options.startDate ?? null,
        endDate: options.endDate ?? null,
        includeDomains,
        resultCount,
        outcome,
      })
    }
    if ((!this.provider && !this.cache) || !normalized) {
      trace('disabled')
      return []
    }
    const signature = JSON.stringify({
      query: normalized,
      maxResults,
      startDate: options.startDate ?? '',
      endDate: options.endDate ?? '',
      includeDomains,
    })
    if (this.seenQueries.has(signature)) {
      this.stats.skippedDuplicateQueries += 1
      trace('duplicate-query')
      return []
    }
    this.seenQueries.add(signature)
    const cached = await this.cache?.get(signature) ?? await this.cache?.get(normalized)
    if (cached) {
      this.stats.cacheHits += 1
      trace('cache-hit', cached.length)
      return cached
    }
    if (this.replayOnly) {
      trace('replay-miss')
      return []
    }
    if (!this.provider) {
      trace('disabled')
      return []
    }
    if (allocation) {
      const phaseLimit = allocation.phase === 'base' ? 4 : 2
      if (this.callsFor(allocation.domain, allocation.phase) >= phaseLimit) {
        trace('quota-exhausted')
        return []
      }
    }
    if (this.stats.calls >= this.dailyLimit) {
      this.stats.exhausted = true
      trace('quota-exhausted')
      return []
    }
    this.stats.calls += 1
    if (allocation) {
      const key = `${allocation.domain}:${allocation.phase}`
      this.phaseCalls.set(key, this.callsFor(allocation.domain, allocation.phase) + 1)
    }
    try {
      const hits = await this.provider.search({ query, maxResults, ...options, includeDomains })
      await this.cache?.set(signature, hits)
      trace('completed', hits.length)
      return hits
    } catch {
      this.stats.failures += 1
      trace('failed')
      return []
    }
  }

  reserveSecondSourceEvent(domain?: DomainId) {
    if (!domain) return false
    const total = [...this.verificationEvents.values()].reduce((sum, count) => sum + count, 0)
    const domainCount = this.verificationEvents.get(domain) ?? 0
    if (total >= this.secondSourceEventLimit || domainCount >= 2 || this.stats.calls >= this.dailyLimit) return false
    this.verificationEvents.set(domain, domainCount + 1)
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

export function normalizedHostname(url: string) {
  try {
    return new URL(url).hostname
      .toLocaleLowerCase()
      .replace(/^www\d*\./, '')
      .replace(/\.$/, '')
  } catch {
    return 'unknown-source'
  }
}

export function sourceForSearchResult(url: string, publisher?: string): FeedSource {
  const hostname = normalizedHostname(url)
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
    'AI infrastructure semiconductor HBM advanced packaging agent AI coding latest major news',
    '中国 人工智能 芯片 算力 HBM 先进封装 智能体 AI Coding 最新进展',
    'site:nvidia.com OR site:amd.com OR site:tsmc.com OR site:openai.com AI chip model announcement',
    'NVIDIA AMD TSMC datacenter supply chain enterprise AI agent adoption regulation',
  ],
  markets: [
    'global markets stock index bond yields inflation interest rates oil earnings latest major news',
    '中国 全球市场 指数 通胀 利率 债券收益率 油价 重要财报 最新动态',
    'site:federalreserve.gov OR site:bls.gov OR site:bea.gov OR site:sec.gov rates inflation earnings filing',
    'Federal Reserve CPI PCE Treasury yields EIA oil company earnings guidance investor relations',
  ],
  world: [
    'geopolitics conflict ceasefire sanctions diplomacy energy shipping food security latest major news',
    '国际 地缘冲突 外交 制裁 能源 航运 粮食 科技安全 最新进展',
    'site:un.org OR site:nato.int OR site:consilium.europa.eu conflict sanctions official statement',
    'China US EU Middle East technology security export controls trade verified latest',
  ],
  learning: [
    'IB education curriculum assessment reform AI literacy learning science latest major news',
    '教育 IB 课程 评估改革 AI 素养 学习科学 教师 最新趋势',
    'site:ibo.org OR site:oecd.org OR site:unesco.org education AI literacy assessment curriculum',
    'schools teachers university learning science assessment policy AI classroom adoption',
  ],
}

export function buildDiscoveryQueries(domain: DomainId, limit = 4) {
  return DISCOVERY_QUERY_TEMPLATES[domain]
    .slice(0, Math.min(4, Math.max(0, limit)))
}

function dateInShanghai(value: Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(value)
}

export function officialDomainsForQuery(query: string) {
  const requested = [...query.matchAll(/\bsite:([a-z0-9.-]+)/gi)]
    .map((match) => match[1].toLocaleLowerCase().replace(/^www\d*\./, '').replace(/\.$/, ''))
  return [...new Set(requested.filter((domain) => OFFICIAL_HOSTS.some((host) => matchesHost(domain, host))))].sort()
}

export function searchOptionsForDomain(domain: DomainId, now: Date, query: string): SearchOptions {
  const windowDays = DOMAIN_CONFIGS[domain].sourceWindowDays
  return {
    startDate: dateInShanghai(new Date(now.getTime() - windowDays * 86_400_000)),
    endDate: dateInShanghai(new Date(now.getTime() + 86_400_000)),
    includeDomains: officialDomainsForQuery(query),
  }
}
