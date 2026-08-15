import assert from 'node:assert/strict'
import test from 'node:test'
import {
  candidateFromSearchHit,
  collectSearchCandidates,
} from './pipeline.js'
import {
  SearchRuntime,
  TavilySearchProvider,
  searchOptionsForDomain,
  sourceForSearchResult,
  type NewsSearchProvider,
  type SearchHit,
  type SearchRequest,
  type SearchResultCache,
} from './search.js'
import { DOMAIN_CONFIGS } from './sources.js'

const now = new Date('2026-08-15T00:00:00.000Z')

test('Tavily 请求保持 Basic，并传入领域时间范围和官方域名过滤', async () => {
  let body: Record<string, unknown> = {}
  const provider = new TavilySearchProvider('fixture-key', async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const query = 'site:ibo.org OR site:oecd.org education assessment'
  const options = searchOptionsForDomain('learning', now, query)
  await provider.search({ query, maxResults: 8, ...options })

  assert.equal(body.search_depth, 'basic')
  assert.equal(body.topic, 'news')
  assert.equal(body.start_date, options.startDate)
  assert.equal(body.end_date, options.endDate)
  assert.deepEqual(body.include_domains, ['ibo.org', 'oecd.org'])
  assert.ok(options.startDate! < searchOptionsForDomain('markets', now, 'markets').startDate!)
  assert.equal(new SearchRuntime(provider, { dailyLimit: 999 }).dailyLimit, 32)
})

test('新搜索参数仍可读取旧格式的当日缓存，不会因此重复调用 Tavily', async () => {
  const responses = new Map<string, SearchHit[]>([[
    'legacy query',
    [{ title: 'Legacy cached result', url: 'https://cache.example/story', snippet: 'Cached material' }],
  ]])
  const cache: SearchResultCache = {
    async get(key) { return responses.get(key) },
    async set(key, hits) { responses.set(key, hits) },
    async isComplete() { return true },
    async markComplete() {},
  }
  let providerCalls = 0
  const provider: NewsSearchProvider = {
    id: 'mock',
    async search() { providerCalls += 1; return [] },
  }
  const runtime = new SearchRuntime(provider, { dailyLimit: 32 }, cache)
  await runtime.prepare()
  const hits = await runtime.search('Legacy Query', 8, searchOptionsForDomain('ai-tech', now, 'Legacy Query'))

  assert.equal(hits.length, 1)
  assert.equal(providerCalls, 0)
  assert.equal(runtime.stats.cacheHits, 1)
})

test('无日期和无效日期不伪装成当前时间，并显著低于可靠日期候选', () => {
  const config = DOMAIN_CONFIGS['ai-tech']
  const base = {
    title: 'NVIDIA 发布新 AI 芯片平台',
    url: 'https://www.reuters.com/technology/nvidia-chip',
    snippet: 'The AI chip and GPU platform targets data center deployments.',
    score: 0.8,
  }
  const undated = candidateFromSearchHit(config, base, 'AI chip news', now)
  const invalid = candidateFromSearchHit(config, { ...base, url: `${base.url}-invalid`, publishedAt: 'not-a-date' }, 'AI chip news', now)
  const dated = candidateFromSearchHit(config, { ...base, url: `${base.url}-dated`, publishedAt: '2026-08-14T12:00:00Z' }, 'AI chip news', now)

  assert.equal(undated?.publishedAt, '')
  assert.equal(undated?.dateConfidence, 'unknown')
  assert.equal(invalid?.publishedAt, '')
  assert.equal(invalid?.dateConfidence, 'unknown')
  assert.equal(dated?.dateConfidence, 'reliable')
  assert.ok((undated?.score ?? 0) < (dated?.score ?? 0))
})

test('搜索候选执行领域相关性、旧新闻、未来日期和时间窗口检查', () => {
  const config = DOMAIN_CONFIGS.markets
  const relevant = {
    title: 'Federal Reserve rate decision moves bond yields',
    url: 'https://example.com/markets/rates',
    snippet: 'Inflation and stock market expectations changed after the rate announcement.',
  }
  assert.ok(candidateFromSearchHit(config, { ...relevant, publishedAt: '2026-08-14T00:00:00Z' }, 'market news', now))
  assert.equal(candidateFromSearchHit(config, { ...relevant, publishedAt: '2026-08-01T00:00:00Z' }, 'market news', now), null)
  assert.equal(candidateFromSearchHit(config, { ...relevant, publishedAt: '2026-08-17T00:00:01Z' }, 'market news', now), null)
  assert.equal(candidateFromSearchHit(config, {
    ...relevant,
    title: 'Local restaurant changes its summer menu',
    snippet: 'Chefs added three desserts and a weekend brunch.',
  }, 'market news', now), null)
})

test('publisher 缺失时使用规范化域名作为来源名', () => {
  const source = sourceForSearchResult('https://WWW2.Example.COM./path/story')
  assert.equal(source.id, 'example.com')
  assert.equal(source.name, 'example.com')
})

test('并行收集允许同一 URL 进入多个相关领域，不再发生跨领域抢占', async () => {
  const sharedUrl = 'https://news.example.com/nvidia-earnings'
  const requests: SearchRequest[] = []
  const provider: NewsSearchProvider = {
    id: 'mock',
    async search(request) {
      requests.push(request)
      await new Promise((resolve) => setTimeout(resolve, request.query.includes('global markets') ? 1 : 8))
      return [{
        title: 'NVIDIA AI chip earnings lift technology stocks',
        url: sharedUrl,
        snippet: 'GPU and data center revenue, profit and stock market guidance all increased.',
        publishedAt: '2026-08-14T12:00:00Z',
      }]
    },
  }
  const runtime = new SearchRuntime(provider, { dailyLimit: 32 })
  const [ai, markets] = await Promise.all([
    collectSearchCandidates('ai-tech', runtime, now),
    collectSearchCandidates('markets', runtime, now),
  ])

  assert.equal(ai.length, 6)
  assert.equal(markets.length, 6)
  assert.ok(ai.every((candidate) => candidate.url === sharedUrl))
  assert.ok(markets.every((candidate) => candidate.url === sharedUrl))
  assert.equal(requests.length, 12)
  assert.ok(requests.every((request) => request.startDate && request.endDate))
})
