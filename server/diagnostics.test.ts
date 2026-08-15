import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import type { DomainId, SourceReliability } from '../shared/briefing.js'
import { DiagnosticRecorder } from './diagnostics.js'
import { evaluateDiagnostics, renderEvaluationMarkdown, type BenchmarkV1 } from './evaluate.js'
import { ArticleReader, recoverMissingCandidateDates } from './material.js'
import {
  buildCandidatePool,
  buildEvidence,
  createEvent,
  diagnoseSyndication,
  type Candidate,
  type CollectionResult,
} from './pipeline.js'
import { SearchRuntime } from './search.js'

function candidate(
  id: string,
  domain: DomainId = 'ai-tech',
  options: {
    title?: string
    description?: string
    url?: string
    publishedAt?: string
    dateConfidence?: Candidate['dateConfidence']
    sourceId?: string
    reliability?: SourceReliability
    discoveryMethod?: Candidate['discoveryMethod']
    searchPhase?: Candidate['searchPhase']
    score?: number
  } = {},
): Candidate {
  const sourceId = options.sourceId ?? `source-${id}`
  const reliability = options.reliability ?? 'tier-1'
  return {
    id,
    domain,
    title: options.title ?? `${id} announces major policy action`,
    description: options.description ?? `${id} confirms a distinct action with supporting details and a public date.`,
    url: options.url ?? `https://${sourceId}.example/${id}`,
    publishedAt: options.publishedAt ?? '2026-08-14T02:00:00.000Z',
    dateConfidence: options.dateConfidence ?? 'reliable',
    source: {
      id: sourceId,
      name: sourceId,
      url: `https://${sourceId}.example`,
      type: reliability === 'primary' ? 'official' : 'media',
      reliability,
      weight: reliability === 'primary' ? 42 : 36,
      focused: true,
    },
    score: options.score ?? 90,
    tags: ['测试'],
    discoveryMethod: options.discoveryMethod ?? 'rss',
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${sourceId}`,
    searchPhase: options.searchPhase,
  }
}

function collection(candidates: Candidate[], domain: DomainId = 'ai-tech'): CollectionResult {
  return {
    domain,
    candidates,
    fetched: candidates.length,
    sourceCount: new Set(candidates.map((item) => item.source.id)).size,
    rssCandidates: candidates.filter((item) => item.discoveryMethod === 'rss').length,
    searchCandidates: candidates.filter((item) => item.discoveryMethod !== 'rss').length,
    warnings: [],
  }
}

test('同一规范 URL 的日期只读取一次并传播到所有领域副本', async () => {
  let fetches = 0
  const url = 'https://shared.example/story?utm_source=test'
  const copies = [
    candidate('shared-ai', 'ai-tech', { url, publishedAt: '', dateConfidence: 'unknown', discoveryMethod: 'news-search', searchPhase: 'base' }),
    candidate('shared-market', 'markets', { url: 'https://shared.example/story', publishedAt: '', dateConfidence: 'unknown', discoveryMethod: 'news-search', searchPhase: 'dynamic' }),
  ]
  const reader = new ArticleReader(5, async () => {
    fetches += 1
    return new Response('<meta property="article:published_time" content="2026-08-14T03:00:00Z"><article><p>'.concat('正文材料'.repeat(100), '</p></article>'), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  })
  const retained = await recoverMissingCandidateDates(copies, reader, new Date('2026-08-15T00:00:00Z'))
  assert.equal(fetches, 1)
  assert.equal(retained.length, 2)
  assert.ok(retained.every((item) => item.publishedAt === '2026-08-14T03:00:00.000Z'))
  assert.equal(reader.dateRecoveryRecords.filter((item) => item.status === 'recovered').length, 2)
  await reader.read(url)
  assert.equal(fetches, 1)
})

test('事件保留最早可信发布时间并记录跨来源日期冲突', () => {
  const early = candidate('early', 'world', {
    title: 'Black Sea ceasefire talks resume',
    description: 'Officials confirmed ceasefire talks for Black Sea shipping.',
    publishedAt: '2026-08-12T01:00:00Z',
    sourceId: 'official',
    reliability: 'primary',
  })
  const late = candidate('late', 'world', {
    title: 'Black Sea ceasefire talks resume',
    description: 'Independent media confirmed ceasefire talks for Black Sea shipping.',
    publishedAt: '2026-08-13T08:00:00Z',
    sourceId: 'media',
  })
  const event = createEvent('world', [late, early])
  assert.equal(event.publishedAt, '2026-08-12T01:00:00.000Z')
  assert.equal(event.dateConflict?.spreadHours, 31)
})

test('隐藏转载仅在高置信时合并独立来源，中等置信只产生警告', () => {
  const wire = candidate('wire', 'world', {
    title: 'Strait of Hormuz shipping disruption lifts oil risk',
    description: 'Reuters reports shipping traffic fell 20 percent after restrictions.',
    sourceId: 'wire-site',
  })
  const exactCopy = candidate('copy', 'world', {
    title: wire.title,
    description: 'Shipping traffic fell 20 percent after restrictions in the Strait of Hormuz.',
    sourceId: 'republisher',
  })
  const high = diagnoseSyndication([wire, exactCopy])
  assert.ok(high.findings.some((item) => item.confidence === 'high'))
  assert.equal(buildEvidence([wire, exactCopy]).independentSourceCount, 1)

  const looseCopy = candidate('loose-copy', 'world', {
    title: 'Strait of Hormuz shipping disruption lifts oil risks',
    description: 'Maritime restrictions affected regional trade flows.',
    sourceId: 'other-media',
  })
  const medium = diagnoseSyndication([wire, looseCopy])
  assert.ok(medium.findings.some((item) => item.confidence === 'medium'))
  assert.ok(medium.findings.every((item) => item.confidence !== 'high'))
  assert.equal(buildEvidence([wire, looseCopy]).independentSourceCount, 2)
})

test('诊断快照不改变候选排序或最终候选池', () => {
  const candidates = [
    candidate('low', 'ai-tech', { score: 70 }),
    candidate('high', 'ai-tech', { score: 100 }),
    candidate('middle', 'ai-tech', { score: 85 }),
  ]
  const input = collection(candidates)
  const before = buildCandidatePool(input).map((event) => event.id)
  const sourceOrder = input.candidates.map((item) => item.id)
  const recorder = new DiagnosticRecorder(new Date('2026-08-15T00:00:00Z'))
  recorder.captureBeforeDateRecovery([input])
  recorder.captureAfterDateRecovery([input])
  const after = buildCandidatePool(input).map((event) => event.id)
  assert.deepEqual(after, before)
  assert.deepEqual(input.candidates.map((item) => item.id), sourceOrder)
})

test('离线评估与输入顺序无关，且无 benchmark 时不输出准确性指标', () => {
  const rss = candidate('rss', 'ai-tech')
  const search = candidate('search', 'ai-tech', { discoveryMethod: 'news-search', searchPhase: 'dynamic' })
  const input = collection([rss, search])
  const recorder = new DiagnosticRecorder(new Date('2026-08-15T00:00:00Z'))
  recorder.captureBeforeDateRecovery([input])
  recorder.captureAfterDateRecovery([input])
  const events = buildCandidatePool(input)
  recorder.capturePreselected([{ domain: 'ai-tech', events }])
  recorder.captureOwnership([{ domain: 'ai-tech', events }], [{ domain: 'ai-tech', events }])
  recorder.captureVerification(events, events)
  const runtime = new SearchRuntime(null)
  const diagnostics = recorder.build(runtime, [], 'succeeded', true, null, new Date('2026-08-15T01:00:00Z'))
  diagnostics.finalSelection = events.map((event, index) => ({ domain: 'ai-tech', eventId: event.id, rank: index + 1, primarySourceId: event.primaryArticle.source.id }))
  const reversed = structuredClone(diagnostics)
  reversed.clusters.reverse()
  reversed.candidatesBeforeDateRecovery.reverse()
  reversed.candidatesAfterDateRecovery.reverse()
  reversed.finalSelection.reverse()
  const fixed = new Date('2026-08-15T02:00:00Z')
  assert.deepEqual(evaluateDiagnostics(diagnostics, undefined, fixed), evaluateDiagnostics(reversed, undefined, fixed))
  const evaluation = evaluateDiagnostics(diagnostics, undefined, fixed)
  assert.equal(evaluation.benchmarkMetrics, undefined)
  assert.doesNotMatch(JSON.stringify(evaluation), /candidateRecall|finalRecall|domainAssignmentAccuracy|clusteringPrecision/)
  assert.match(renderEvaluationMarkdown(evaluation), /没有标注 benchmark/)
})

test('诊断文件会清除环境密钥且不包含完整正文', async () => {
  const previous = process.env.TAVILY_API_KEY
  process.env.TAVILY_API_KEY = 'diagnostic-secret-sentinel-12345'
  const recorder = new DiagnosticRecorder(new Date('2026-08-15T00:00:00Z'))
  const item = candidate('privacy')
  item.fullText = '不应进入诊断文件的完整正文'.repeat(50)
  const input = collection([item])
  recorder.captureBeforeDateRecovery([input])
  recorder.captureAfterDateRecovery([input])
  const runtime = new SearchRuntime(null)
  const diagnostics = recorder.build(runtime, [], 'failed', false, new Error('diagnostic-secret-sentinel-12345'))
  const directory = await mkdtemp(resolve(tmpdir(), 'dailynews-diagnostics-'))
  await recorder.write(directory, diagnostics)
  const saved = await readFile(resolve(directory, 'latest.json'), 'utf8')
  assert.doesNotMatch(saved, /diagnostic-secret-sentinel-12345/)
  assert.doesNotMatch(saved, /不应进入诊断文件的完整正文/)
  assert.match(saved, /\[REDACTED\]/)
  if (previous == null) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = previous
})

test('版本化 benchmark 覆盖指定案例，存在标注时才计算质量指标', async () => {
  const benchmark = JSON.parse(await readFile(resolve('server/fixtures/benchmark-v1.json'), 'utf8')) as BenchmarkV1
  const labels = benchmark.events.flatMap((event) => event.titleAliases).join(' ')
  assert.match(labels, /英伟达/)
  assert.match(labels, /霍尔木兹/)
  assert.match(labels, /黑海/)
  assert.match(labels, /中芯国际/)
  assert.match(labels, /PISA/)
  assert.match(labels, /国际文凭/)
  assert.ok(benchmark.events.some((event) => event.eventId === 'ai-funding' && event.correctDomain === 'markets'))

  const expected = benchmark.events[0]
  const item = candidate('benchmark-nvidia', 'ai-tech', {
    title: expected.articles[0].title,
    description: expected.articles[0].summary,
    url: expected.articles[0].url,
    publishedAt: expected.articles[0].publishedAt,
    sourceId: 'nvidia.example',
    reliability: 'primary',
  })
  const input = collection([item])
  const event = createEvent('ai-tech', [item])
  const recorder = new DiagnosticRecorder(new Date('2026-08-15T00:00:00Z'))
  recorder.captureBeforeDateRecovery([input])
  recorder.captureAfterDateRecovery([input])
  recorder.capturePreselected([{ domain: 'ai-tech', events: [event] }])
  recorder.captureOwnership([{ domain: 'ai-tech', events: [event] }], [{ domain: 'ai-tech', events: [event] }])
  recorder.captureVerification([event], [event])
  const diagnostics = recorder.build(new SearchRuntime(null), [], 'succeeded', true)
  diagnostics.finalSelection = [{ domain: 'ai-tech', eventId: event.id, rank: 1, primarySourceId: item.source.id }]
  const evaluation = evaluateDiagnostics(diagnostics, benchmark, new Date('2026-08-15T02:00:00Z'))
  assert.ok(evaluation.benchmarkMetrics)
  assert.ok(evaluation.benchmarkMetrics.candidateRecall > 0)
  assert.ok(evaluation.benchmarkMetrics.finalRecall > 0)
})

test('固定诊断样本能区分发现增量、验证支持和证据升级', async () => {
  const diagnostics = JSON.parse(await readFile(resolve('server/fixtures/diagnostic-run-v1.json'), 'utf8'))
  const evaluation = evaluateDiagnostics(diagnostics, undefined, new Date('2026-08-15T02:00:00Z'))
  assert.equal(evaluation.search.totalCalls, 2)
  assert.equal(evaluation.incrementalContribution.rss.newValidEvents, 1)
  assert.equal(evaluation.incrementalContribution['verification-search'].newValidEvents, 0)
  assert.equal(evaluation.incrementalContribution['verification-search'].supportingFinalEvents, 1)
  assert.equal(evaluation.evidence.verificationUpgrades, 1)
  assert.equal(evaluation.evidence.levels.confirmed.count, 1)
})

test('定时任务无论生成结果都评估并上传 Actions artifact，Pages 仍只发布 dist', async () => {
  const daily = await readFile(resolve('.github/workflows/daily-briefing.yml'), 'utf8')
  const pages = await readFile(resolve('.github/workflows/pages.yml'), 'utf8')
  assert.match(daily, /Evaluate private diagnostics[\s\S]*if: always\(\)/)
  assert.match(daily, /Upload private diagnostics[\s\S]*actions\/upload-artifact@v6/)
  assert.match(daily, /path: \.diagnostics/)
  assert.match(daily, /retention-days: 30/)
  assert.match(pages, /path: dist/)
  assert.doesNotMatch(pages, /\.diagnostics/)
})
