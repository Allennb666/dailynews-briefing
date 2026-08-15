import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DomainId, SourceReliability } from '../shared/briefing.js'
import { deduplicateAcrossDomains } from './editorial.js'
import { buildVerificationQuery, enrichImportantEvents, searchSecondSource } from './enrichment.js'
import { ArticleReader, extractPublishedAtFromHtml, recoverMissingCandidateDates } from './material.js'
import {
  buildDynamicQueries,
  buildEvidence,
  candidateFromSearchHit,
  clusterCandidates,
  collectSearchCandidates,
  createEvent,
  deduplicateCandidates,
  type Candidate,
  type NewsEvent,
} from './pipeline.js'
import { SearchRuntime, sourceForSearchResult, type NewsSearchProvider } from './search.js'
import { DOMAIN_CONFIGS, DOMAIN_ORDER } from './sources.js'

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const now = new Date('2026-08-15T00:00:00.000Z')

type EventFixture = {
  title: string
  description: string
  url?: string
  sourceId?: string
  reliability?: SourceReliability
}

const source = (id: string, reliability: SourceReliability = 'tier-1') => ({
  id,
  name: id,
  url: `https://${id}`,
  type: reliability === 'primary' ? 'official' as const : 'media' as const,
  reliability,
  weight: reliability === 'primary' ? 42 : 36,
  focused: true,
})

function candidate(id: string, domain: DomainId, fixture: EventFixture, score = 90): Candidate {
  const sourceId = fixture.sourceId ?? `${id}.example`
  return {
    id,
    domain,
    title: fixture.title,
    description: fixture.description,
    url: fixture.url ?? `https://${sourceId}/${id}`,
    publishedAt: '2026-08-14T01:30:00.000Z',
    dateConfidence: 'reliable',
    source: source(sourceId, fixture.reliability),
    score,
    tags: DOMAIN_CONFIGS[domain].tagRules.filter((rule) => rule.pattern.test(`${fixture.title} ${fixture.description}`)).map((rule) => rule.tag),
    discoveryMethod: 'news-search',
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${sourceId}`,
  }
}

async function wave2Fixtures() {
  return JSON.parse(await readFile(resolve(fixtureRoot, 'wave2-events.json'), 'utf8')) as {
    bilingualSameEvent: EventFixture[]
    sameCompanyDifferentEvents: EventFixture[]
    crossDomain: EventFixture
  }
}

test('动态查询由基础候选和上一期追踪信号中的实体、动作、数字及日期生成', () => {
  const base = [candidate('base', 'ai-tech', {
    title: 'NVIDIA announces $10 billion AI chip investment',
    description: 'NVIDIA will build the facility after its 2026-08-14 announcement.',
  })]
  const queries = buildDynamicQueries('ai-tech', base, [
    'watch NVIDIA funding execution',
    '验证 2026-08-14 的 100亿美元投资是否开始建设',
  ], now)

  assert.equal(queries.length, 2)
  assert.ok(queries.some((query) => /nvidia/i.test(query)))
  assert.ok(queries.some((query) => /funding|build/i.test(query)))
  assert.ok(queries.some((query) => /\$10 billion|2026-08-14/i.test(query)))
})

test('多信号相关性允许同一 AI 融资事件进入 AI 与市场候选池', async () => {
  const fixture = (await wave2Fixtures()).crossDomain
  const hit = {
    title: fixture.title,
    snippet: fixture.description,
    url: 'https://reuters.com/technology/openai-financing',
    publishedAt: '2026-08-14T04:00:00Z',
  }
  assert.ok(candidateFromSearchHit(DOMAIN_CONFIGS['ai-tech'], hit, 'AI infrastructure funding', now))
  assert.ok(candidateFromSearchHit(DOMAIN_CONFIGS.markets, hit, 'company funding valuation market', now))
})

test('中英文同一事件可聚合，同公司不同动作仍保持分离', async () => {
  const fixtures = await wave2Fixtures()
  const bilingual = fixtures.bilingualSameEvent.map((item, index) => candidate(`bilingual-${index}`, 'ai-tech', item, 100 - index))
  const clustered = clusterCandidates(deduplicateCandidates(bilingual))
  assert.equal(clustered.length, 1)
  assert.equal(clustered[0].articles.length, 2)
  assert.equal(clustered[0].evidence.level, 'confirmed')

  const different = fixtures.sameCompanyDifferentEvents.map((item, index) => candidate(`different-${index}`, 'ai-tech', item, 100 - index))
  assert.equal(clusterCandidates(deduplicateCandidates(different)).length, 2)
})

test('缺失日期从固定页面元数据恢复，并与后续全文读取共用一次抓取', async () => {
  const html = await readFile(resolve(fixtureRoot, 'article-date-metadata.html'), 'utf8')
  let fetchCalls = 0
  const reader = new ArticleReader(8, async () => {
    fetchCalls += 1
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  const undated = candidateFromSearchHit(DOMAIN_CONFIGS['ai-tech'], {
    title: 'NVIDIA announces $10 billion AI chip investment',
    snippet: 'NVIDIA will build a new artificial intelligence chip facility.',
    url: 'https://nvidia.com/news/date-recovery',
  }, 'NVIDIA AI chip investment', now)!
  const recovered = await recoverMissingCandidateDates([undated], reader, now)

  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].publishedAt, '2026-08-14T01:30:00.000Z')
  assert.equal(recovered[0].dateConfidence, 'reliable')
  assert.ok(await reader.read(undated.url))
  assert.equal(fetchCalls, 1)
  assert.equal(reader.attempted, 1)
  assert.equal(reader.metadataRecovered, 1)
  assert.equal(extractPublishedAtFromHtml('<meta name="dateModified" content="2026-08-15T01:00:00Z">'), null)
  assert.equal(
    extractPublishedAtFromHtml('<meta property="article:published_time" content="2026-08-14T05:00:00Z">'),
    '2026-08-14T05:00:00.000Z',
  )
  assert.equal(
    extractPublishedAtFromHtml('<time datetime="2026-08-14T06:00:00Z">Published</time>'),
    '2026-08-14T06:00:00.000Z',
  )
})

test('恢复出的旧日期会过滤，无法恢复时继续保持 unknown', async () => {
  const oldReader = new ArticleReader(2, async () => new Response(
    '<meta property="article:published_time" content="2026-07-01T00:00:00Z">',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ))
  const old = candidateFromSearchHit(DOMAIN_CONFIGS.markets, {
    title: 'Federal Reserve rate decision moves bond yields',
    snippet: 'Inflation and stock market expectations changed.',
    url: 'https://example.com/old-market-story',
  }, 'Federal Reserve rates', now)!
  assert.deepEqual(await recoverMissingCandidateDates([old], oldReader, now), [])

  const unknownReader = new ArticleReader(2, async () => new Response(
    '<meta name="dateModified" content="2026-08-15T01:00:00Z">',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ))
  const unknown = { ...old, id: 'unknown', url: 'https://example.com/unknown', dateConfidence: 'unknown' as const, publishedAt: '' }
  const retained = await recoverMissingCandidateDates([unknown], unknownReader, now)
  assert.equal(retained[0].dateConfidence, 'unknown')
  assert.equal(retained[0].publishedAt, '')

  const limitedReader = new ArticleReader(30, async () => new Response('<html><body>no date</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }))
  const manyUnknown = Array.from({ length: 12 }, (_, index) => ({
    ...unknown,
    id: `unknown-${index}`,
    url: `https://example.com/unknown-${index}`,
  }))
  await recoverMissingCandidateDates(manyUnknown, limitedReader, now, 20)
  assert.equal(limitedReader.metadataAttempted, 8)
  assert.equal(limitedReader.attempted, 8)
})

test('第二来源查询使用实体、动作、数字和日期，验证后形成 confirmed/corroborated', async () => {
  const officialEvent = createEvent('ai-tech', [candidate('official', 'ai-tech', {
    title: 'NVIDIA announces $10 billion investment to build AI chip factory',
    description: 'NVIDIA announced the investment and construction plan.',
    sourceId: 'nvidia.com',
    reliability: 'primary',
  })])
  const query = buildVerificationQuery(officialEvent)
  assert.doesNotMatch(query, /"/)
  assert.match(query, /nvidia/i)
  assert.match(query, /funding|build/i)
  assert.match(query, /\$10 billion/)
  assert.match(query, /2026-08-14/)

  const confirmedProvider: NewsSearchProvider = {
    id: 'mock',
    async search() {
      return [{
        title: 'NVIDIA $10 billion AI factory investment confirmed',
        snippet: 'Reuters reports NVIDIA announced the investment and will build the chip facility.',
        url: 'https://reuters.com/technology/nvidia-factory',
        publishedAt: '2026-08-14T02:00:00Z',
      }]
    },
  }
  const confirmed = await searchSecondSource(officialEvent, new SearchRuntime(confirmedProvider), now)
  assert.equal(confirmed.evidence.level, 'confirmed')

  const mediaEvent = createEvent('ai-tech', [candidate('reuters', 'ai-tech', {
    title: 'NVIDIA announces $10 billion investment to build AI chip factory',
    description: 'Reuters reports the investment and construction plan.',
    sourceId: 'reuters.com',
    reliability: 'tier-1',
  })])
  const officialProvider: NewsSearchProvider = {
    id: 'mock',
    async search() {
      return [{
        title: 'NVIDIA confirms $10 billion investment in AI chip factory',
        snippet: 'NVIDIA confirms the funding and construction plan for the AI chip factory.',
        url: 'https://nvidia.com/news/nvidia-factory-confirmation',
        publishedAt: '2026-08-14T02:30:00Z',
      }]
    },
  }
  const confirmedFromOfficial = await searchSecondSource(mediaEvent, new SearchRuntime(officialProvider), now)
  assert.equal(confirmedFromOfficial.evidence.level, 'confirmed')

  const reprints = buildEvidence([
    candidate('wire-a', 'world', { title: 'Outlet A update', description: 'Reuters reported the action.', sourceId: 'a.com', reliability: 'tier-1' }),
    candidate('wire-b', 'world', { title: 'Outlet B update', description: '路透社报道同一行动。', sourceId: 'b.com', reliability: 'tier-1' }),
  ])
  assert.equal(reprints.independentSourceCount, 1)
})

test('每领域 4+2+2 固定分配且全天搜索调用不超过 32', async () => {
  const provider: NewsSearchProvider = { id: 'mock', async search() { return [] } }
  const runtime = new SearchRuntime(provider, { dailyLimit: 32, secondSourceEventLimit: 8 })
  for (const domain of DOMAIN_ORDER) await collectSearchCandidates(domain, runtime, now, [`${domain} 2026-08-14 follow-up`])
  assert.equal(runtime.stats.calls, 24)
  for (const domain of DOMAIN_ORDER) {
    assert.equal(runtime.callsFor(domain, 'base'), 4)
    assert.equal(runtime.callsFor(domain, 'dynamic'), 2)
  }

  const entities: Record<DomainId, string[]> = {
    'ai-tech': ['NVIDIA', 'OpenAI'],
    markets: ['Federal Reserve', 'SEC'],
    world: ['United Nations', 'China'],
    learning: ['OECD', 'UNESCO'],
  }
  const events = DOMAIN_ORDER.flatMap((domain) => entities[domain].map((entity, index) => createEvent(domain, [candidate(
    `${domain}-${index}`,
    domain,
    {
      title: `${entity} announces $${index + 1} billion policy investment`,
      description: `${entity} announced funding and policy action on 2026-08-14.`,
    },
    100 - index,
  )])))
  await enrichImportantEvents(events, runtime, now)

  assert.equal(runtime.stats.calls, 32)
  for (const domain of DOMAIN_ORDER) assert.equal(runtime.callsFor(domain, 'verification'), 2)
})

test('跨领域候选在预选后按多信号确定唯一归属且结果确定', async () => {
  const fixture = (await wave2Fixtures()).crossDomain
  const url = 'https://reuters.com/technology/openai-financing'
  const ai = createEvent('ai-tech', [candidate('ai-copy', 'ai-tech', { ...fixture, url }, 92)])
  const markets = createEvent('markets', [candidate('market-copy', 'markets', {
    ...fixture,
    description: `${fixture.description} Stock market earnings revenue profit and valuation changed after the funding.`,
    url,
  }, 92)])

  const forward = deduplicateAcrossDomains([{ domain: 'ai-tech', events: [ai] }, { domain: 'markets', events: [markets] }])
  const reversed = deduplicateAcrossDomains([{ domain: 'markets', events: [markets] }, { domain: 'ai-tech', events: [ai] }])
  const snapshot = (selections: Array<{ domain: DomainId; events: NewsEvent[] }>) => selections.map((selection) => ({
    domain: selection.domain,
    ids: selection.events.map((event) => event.id),
  }))

  assert.deepEqual(snapshot(forward), snapshot(reversed))
  assert.equal(forward.find((selection) => selection.domain === 'ai-tech')?.events.length, 0)
  assert.equal(forward.find((selection) => selection.domain === 'markets')?.events.length, 1)
})
