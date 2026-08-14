import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceReliability } from '../shared/briefing.js'
import type { Candidate } from './pipeline.js'
import {
  buildEvidence,
  buildRulesBriefing,
  clusterCandidates,
  deduplicateCandidates,
  normalizeTitle,
  selectDiverseStories,
  titleSimilarity,
} from './pipeline.js'

const source = (id: string, reliability: SourceReliability = 'primary') => ({
  id,
  name: id,
  url: `https://${id}.example/feed`,
  type: reliability === 'primary' ? 'official' as const : 'media' as const,
  reliability,
  weight: 40,
  focused: true,
})

const candidate = (
  id: string,
  title: string,
  sourceId: string,
  score: number,
  options: { description?: string; publishedAt?: string; reliability?: SourceReliability; tags?: string[] } = {},
): Candidate => ({
  id,
  domain: 'ai-tech',
  title,
  description: options.description ?? `specific material ${id}`,
  url: `https://example.com/${id}`,
  publishedAt: options.publishedAt ?? '2026-08-11T00:00:00.000Z',
  source: source(sourceId, options.reliability),
  score,
  tags: options.tags ?? ['模型'],
  discoveryMethod: 'rss',
  materialLevel: 'snippet-only',
  independenceKey: `publisher:${sourceId}`,
})

test('标题规范化会忽略空格与标点', () => {
  assert.equal(normalizeTitle('OpenAI 发布：新模型'), normalizeTitle('OpenAI发布新模型'))
})

test('中英文相近标题能够被识别', () => {
  assert.ok(titleSimilarity('NVIDIA launches new AI chip platform', 'NVIDIA launches a new AI chip platform') > 0.64)
})

test('去重保留评分更高的一条', () => {
  const result = deduplicateCandidates([
    candidate('low', 'OpenAI releases a new model', 'a', 60),
    candidate('high', 'OpenAI releases new model', 'b', 90),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'high')
})

test('五条重点默认限制单一来源最多两条', () => {
  const items = [
    candidate('a1', 'A one', 'a', 100),
    candidate('a2', 'A two', 'a', 99),
    candidate('a3', 'A three', 'a', 98),
    candidate('b1', 'B one', 'b', 97),
    candidate('c1', 'C one', 'c', 96),
    candidate('d1', 'D one', 'd', 95),
  ]
  const selected = selectDiverseStories(items)
  assert.equal(selected.length, 5)
  assert.equal(selected.filter((item) => item.source.id === 'a').length, 2)
})

test('生成后的新闻排名从 1 到 5', () => {
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(
    `item-${index}`,
    `Unique story ${index}`,
    `source-${index}`,
    100 - index,
  ))
  const briefing = buildRulesBriefing({ domain: 'ai-tech', candidates, fetched: 5, sourceCount: 5, warnings: [] }, new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(briefing.stories.map((story) => story.rank), [1, 2, 3, 4, 5])
  assert.equal(briefing.schemaVersion, 2)
  assert.equal(briefing.pipeline.afterClustering, 5)
  assert.ok(briefing.stories.every((story) => story.eventId === story.id && story.evidence.sourceCount === 1))
  assert.ok(briefing.stories.every((story) => story.impactChain.length >= 3))
})

test('模型已经选满五条时不会继续追加规则候选', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => candidate(
    `item-${index}`,
    `Unique model story ${index}`,
    `source-${index}`,
    100 - index,
  ))
  const preferredIds = clusterCandidates(deduplicateCandidates(candidates)).slice(3).map((event) => event.id)
  const briefing = buildRulesBriefing(
    { domain: 'ai-tech', candidates, fetched: 8, sourceCount: 8, warnings: [] },
    new Date('2026-08-11T01:00:00.000Z'),
    preferredIds,
  )

  assert.equal(briefing.stories.length, 5)
  assert.deepEqual(briefing.stories.map((story) => story.id), preferredIds)
})

test('同一事件的不同标题会聚合为一个 Event', () => {
  const clustered = clusterCandidates(deduplicateCandidates([
    candidate('nvidia-primary', 'NVIDIA unveils Rubin Ultra platform at GTC', 'nvidia', 98, {
      description: 'NVIDIA launched the Rubin Ultra platform at GTC, targeting faster AI factories with a new rack-scale design.',
      reliability: 'primary',
      tags: ['芯片'],
    }),
    candidate('nvidia-media', 'New Rubin Ultra chips target faster AI factories', 'reuters', 92, {
      description: 'The Rubin Ultra rack-scale system unveiled at GTC is Nvidia’s latest platform for speeding up AI factories.',
      reliability: 'tier-1',
      tags: ['芯片'],
    }),
  ]))

  assert.equal(clustered.length, 1)
  assert.equal(clustered[0].articles.length, 2)
  assert.equal(clustered[0].sourceCount, 2)
})

test('同一公司发生的不同事件不会被合并', () => {
  const clustered = clusterCandidates(deduplicateCandidates([
    candidate('nvidia-launch', 'NVIDIA launches Rubin Ultra AI platform', 'nvidia', 98, {
      description: 'NVIDIA unveiled Rubin Ultra for AI factories at its developer conference.',
      reliability: 'primary',
      tags: ['芯片'],
    }),
    candidate('nvidia-earnings', 'NVIDIA reports record quarterly revenue', 'bbc', 92, {
      description: 'NVIDIA reported quarterly earnings and issued new revenue guidance for investors.',
      reliability: 'tier-1',
      tags: ['公司'],
    }),
  ]))

  assert.equal(clustered.length, 2)
})

test('时间差明显的相似事件不会轻易合并', () => {
  const clustered = clusterCandidates(deduplicateCandidates([
    candidate('rubin-week-one', 'NVIDIA unveils Rubin Ultra AI platform', 'nvidia', 98, {
      description: 'NVIDIA launched Rubin Ultra for AI factories at GTC.',
      publishedAt: '2026-08-01T00:00:00.000Z',
      reliability: 'primary',
    }),
    candidate('rubin-week-two', 'Rubin Ultra platform launched for AI factories', 'reuters', 92, {
      description: 'NVIDIA launched the Rubin Ultra platform for AI factories.',
      publishedAt: '2026-08-09T00:00:00.000Z',
      reliability: 'tier-1',
    }),
  ]))

  assert.equal(clustered.length, 2)
})

test('primary 加独立可靠媒体会得到 confirmed', () => {
  const evidence = buildEvidence([
    candidate('primary', 'NVIDIA launches Rubin Ultra', 'nvidia', 98, { reliability: 'primary' }),
    candidate('media', 'Rubin Ultra launch detailed', 'reuters', 92, { reliability: 'tier-1' }),
  ])
  assert.deepEqual(evidence, {
    level: 'confirmed',
    sourceCount: 2,
    independentSourceCount: 1,
    primarySourcePresent: true,
  })
})

test('两个独立可靠媒体会得到 corroborated', () => {
  const evidence = buildEvidence([
    candidate('media-a', 'Rubin Ultra launch detailed', 'reuters', 92, { reliability: 'tier-1' }),
    candidate('media-b', 'NVIDIA unveils Rubin Ultra', 'bbc', 90, { reliability: 'tier-2' }),
  ])
  assert.equal(evidence.level, 'corroborated')
  assert.equal(evidence.independentSourceCount, 2)
  assert.equal(evidence.primarySourcePresent, false)
})

test('单一非传闻来源会得到 single-source', () => {
  const evidence = buildEvidence([
    candidate('single', 'NVIDIA launches Rubin Ultra', 'reuters', 92, { reliability: 'tier-1' }),
  ])
  assert.equal(evidence.level, 'single-source')
})

test('传闻且只有单一来源会得到 unverified', () => {
  const evidence = buildEvidence([
    candidate('rumor', 'NVIDIA reportedly plans a new Rubin Ultra system', 'unknown', 70, {
      description: 'Sources say the unannounced system may launch later this year.',
      reliability: 'other',
    }),
  ])
  assert.equal(evidence.level, 'unverified')
})
