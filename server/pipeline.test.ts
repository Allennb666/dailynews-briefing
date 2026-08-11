import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candidate } from './pipeline.js'
import { buildRulesBriefing, deduplicateCandidates, normalizeTitle, selectDiverseStories, titleSimilarity } from './pipeline.js'

const source = (id: string) => ({
  id,
  name: id,
  url: `https://${id}.example/feed`,
  type: 'official' as const,
  weight: 40,
  focused: true,
})

const candidate = (id: string, title: string, sourceId: string, score: number): Candidate => ({
  id,
  domain: 'ai-tech',
  title,
  description: 'description',
  url: `https://example.com/${id}`,
  publishedAt: '2026-08-11T00:00:00.000Z',
  source: source(sourceId),
  score,
  tags: ['模型'],
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
  assert.ok(briefing.stories.every((story) => story.impactChain.length >= 3))
})
