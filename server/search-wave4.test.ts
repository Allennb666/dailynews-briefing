import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DomainId, SourceReliability } from '../shared/briefing.js'
import { enrichImportantEvents, searchSecondSource } from './enrichment.js'
import {
  assessEventMatch,
  buildDynamicQueries,
  candidateFromSearchHit,
  clusterCandidates,
  createEvent,
  deduplicateCandidates,
  extractKeyNumbers,
  keyNumbersCompatible,
  learningPersonalRelevance,
  type Candidate,
} from './pipeline.js'
import { SearchRuntime, type NewsSearchProvider, type SearchRequest } from './search.js'
import { DOMAIN_CONFIGS } from './sources.js'

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/wave4-real-regressions.json')
const now = new Date('2026-08-15T12:00:00.000Z')

type FixtureItem = {
  title: string
  description: string
  url?: string
  sourceId?: string
  reliability?: SourceReliability
}

type Wave4Fixture = {
  archiveHit: { title: string; snippet: string; url: string; publishedAt: string }
  marketIndicators: FixtureItem[]
  dynamicSeeds: FixtureItem[]
  previousSignals: string[]
  education: Record<'priority' | 'weakLocal', { title: string; snippet: string; url: string; publishedAt: string }>
  verificationEvents: Array<FixtureItem & { domain: DomainId; entity: string; hitTitle: string; hitSnippet: string }>
}

async function fixtures() {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Wave4Fixture
}

function source(id: string, reliability: SourceReliability = 'tier-1') {
  return {
    id,
    name: id,
    url: `https://${id}`,
    type: reliability === 'primary' ? 'official' as const : 'media' as const,
    reliability,
    weight: reliability === 'primary' ? 42 : 36,
    focused: true,
  }
}

function candidate(id: string, domain: DomainId, item: FixtureItem, score = 90): Candidate {
  const sourceId = item.sourceId ?? `${id}.example`
  return {
    id,
    domain,
    title: item.title,
    description: item.description,
    url: item.url ?? `https://${sourceId}/${id}`,
    publishedAt: '2026-08-14T08:00:00.000Z',
    dateConfidence: 'reliable',
    source: source(sourceId, item.reliability),
    score,
    tags: DOMAIN_CONFIGS[domain].tagRules.filter((rule) => rule.pattern.test(`${item.title} ${item.description}`)).map((rule) => rule.tag),
    discoveryMethod: 'news-search',
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${sourceId}`,
  }
}

test('真实回归：NVIDIA News Archive 不得进入候选池', async () => {
  const fixture = await fixtures()
  const result = candidateFromSearchHit(DOMAIN_CONFIGS['ai-tech'], fixture.archiveHit, 'NVIDIA AI chip announcement', now)
  assert.equal(result, null)
})

test('真实回归：CPI 与 PPI 即使同机构同日发布也保持分离', async () => {
  const fixture = await fixtures()
  const events = clusterCandidates(deduplicateCandidates(fixture.marketIndicators.map((item, index) => candidate(`indicator-${index}`, 'markets', item))))
  assert.equal(events.length, 2)
  assert.ok(events.some((event) => /CPI/i.test(event.canonicalTitle)))
  assert.ok(events.some((event) => /PPI/i.test(event.canonicalTitle)))
})

test('事件聚类不通过中间新闻产生链式误合并', () => {
  const items = [
    candidate('chain-a', 'ai-tech', { title: 'NVIDIA launches Rubin GPU platform', description: 'NVIDIA launches the Rubin AI chip product.' }, 100),
    candidate('chain-b', 'ai-tech', { title: 'NVIDIA launches Rubin platform and funds factory capacity', description: 'NVIDIA launches Rubin and invests in chip factory capacity.' }, 99),
    candidate('chain-c', 'ai-tech', { title: 'NVIDIA funds new chip factory capacity', description: 'NVIDIA invests in a new semiconductor factory.' }, 98),
  ]
  assert.equal(clusterCandidates(items).length, 2)
})

test('验证数字支持单位换算、百分比和合理舍入，但指标仍须一致', () => {
  assert.ok(keyNumbersCompatible(extractKeyNumbers('$10 billion'), extractKeyNumbers('100亿美元')))
  assert.ok(keyNumbersCompatible(extractKeyNumbers('2.50%'), extractKeyNumbers('2.52%')))
  assert.ok(keyNumbersCompatible(extractKeyNumbers('25 bps'), extractKeyNumbers('0.25%')))
})

test('真实回归：动态查询每条只围绕一个种子事件且清除无意义词', async () => {
  const fixture = await fixtures()
  const seeds = fixture.dynamicSeeds.map((item, index) => candidate(`seed-${index}`, 'ai-tech', item, 100 - index))
  const queries = buildDynamicQueries('ai-tech', seeds, fixture.previousSignals, now)
  assert.equal(queries.length, 2)
  assert.ok(queries.some((query) => /nvidia/i.test(query) && !/openai|codecraft/i.test(query)))
  assert.ok(queries.some((query) => /openai|codecraft/i.test(query) && !/nvidia/i.test(query)))
  assert.ok(queries.every((query) => !/\b(?:archive|latest|report)\b|am the fri|arday scandal/i.test(query)))
})

test('真实回归：教育核心主题显著高于地方行政新闻', async () => {
  const fixture = await fixtures()
  const priority = candidateFromSearchHit(DOMAIN_CONFIGS.learning, fixture.education.priority, 'OECD PISA AI literacy assessment', now)!
  const weak = candidateFromSearchHit(DOMAIN_CONFIGS.learning, fixture.education.weakLocal, 'schools education policy', now)!
  assert.ok(learningPersonalRelevance(`${priority.title} ${priority.description}`).score >= 16)
  assert.ok(priority.score - weak.score >= 30)
})

test('真实回归：每领域两个定向验证均可升级，8 次验证升级多个事件', async () => {
  const fixture = await fixtures()
  const events = fixture.verificationEvents.map((item, index) => createEvent(item.domain, [candidate(`verify-${index}`, item.domain, { ...item, reliability: 'primary' }, 100 - index)]))
  const provider: NewsSearchProvider = {
    id: 'wave4-mock',
    async search(request: SearchRequest) {
      const match = fixture.verificationEvents.find((item) => request.query.toLocaleLowerCase().includes(item.entity.toLocaleLowerCase()))
        ?? fixture.verificationEvents.find((item) => request.query.toLocaleLowerCase().includes(item.title.split(' ')[0].toLocaleLowerCase()))
      if (!match) return []
      const index = fixture.verificationEvents.indexOf(match)
      return [{
        title: match.hitTitle,
        snippet: match.hitSnippet,
        url: `https://${index % 2 ? 'apnews.com' : 'reuters.com'}/article/wave4-${index}`,
        publishedAt: '2026-08-14T10:00:00Z',
      }]
    },
  }
  const runtime = new SearchRuntime(provider, { dailyLimit: 32, secondSourceEventLimit: 8 })
  const decisions: string[] = []
  const enriched = await enrichImportantEvents(events, runtime, now, (decision) => decisions.push(decision.reason))
  assert.equal(runtime.stats.calls, 8)
  assert.equal(enriched.length, 8)
  assert.ok(enriched.filter((event) => event.evidence.level === 'confirmed').length >= 4)
  assert.ok(decisions.filter((reason) => reason === 'accepted').length >= 4)
})

test('验证拒绝会记录具体的指标不一致原因', async () => {
  const event = createEvent('markets', [candidate('cpi-official', 'markets', {
    title: 'BLS releases CPI showing inflation at 2.5%',
    description: 'The Consumer Price Index release measured CPI inflation at 2.5%.',
    sourceId: 'bls.gov',
    reliability: 'primary',
  })])
  const provider: NewsSearchProvider = {
    id: 'mismatch-mock',
    async search() {
      return [{
        title: 'BLS releases PPI showing producer prices at 0.4%',
        snippet: 'The Producer Price Index release measured PPI inflation at 0.4%.',
        url: 'https://reuters.com/markets/ppi-release',
        publishedAt: '2026-08-14T10:00:00Z',
      }]
    },
  }
  const reasons: string[] = []
  const result = await searchSecondSource(event, new SearchRuntime(provider), now, (decision) => reasons.push(decision.reason))
  assert.equal(result.evidence.level, 'single-source')
  assert.deepEqual(reasons, ['indicator-mismatch'])
  assert.equal(assessEventMatch(event.primaryArticle, candidate('ppi-media', 'markets', {
    title: 'BLS releases PPI showing producer prices at 0.4%',
    description: 'The Producer Price Index release measured PPI inflation at 0.4%.',
  }), true).reason, 'indicator-mismatch')
})
