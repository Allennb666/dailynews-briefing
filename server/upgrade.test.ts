import assert from 'node:assert/strict'
import test from 'node:test'
import type { DailyBriefing, DomainId, SourceReliability } from '../shared/briefing.js'
import { deduplicateAcrossDomains, validateCrossDomainUniqueness } from './editorial.js'
import { ArticleReader } from './material.js'
import type { EditorialModel, ModelBriefing } from './model.js'
import { finalizeBriefing, validateBriefing } from './model.js'
import {
  buildEvidence,
  buildRulesBriefing,
  createEvent,
  deduplicateCandidates,
  type Candidate,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'
import { SearchRuntime, createSearchRuntimeFromEnvironment, type NewsSearchProvider } from './search.js'

const source = (id: string, reliability: SourceReliability = 'tier-1') => ({
  id,
  name: id,
  url: `https://${id}.example`,
  type: reliability === 'primary' ? 'official' as const : 'media' as const,
  reliability,
  weight: 40,
  focused: true,
})

function candidate(
  id: string,
  domain: DomainId = 'ai-tech',
  options: {
    sourceId?: string
    reliability?: SourceReliability
    title?: string
    description?: string
    score?: number
    tags?: string[]
    independenceKey?: string
  } = {},
): Candidate {
  const sourceId = options.sourceId ?? `source-${id}`
  return {
    id,
    domain,
    title: options.title ?? `事件 ${id} 发布重要更新`,
    description: options.description ?? `这是事件 ${id} 的具体材料，说明政策动作、产业影响和后续验证方向。`,
    url: `https://${sourceId}.example/${id}`,
    publishedAt: '2026-08-15T00:00:00.000Z',
    source: source(sourceId, options.reliability),
    score: options.score ?? 100,
    tags: options.tags ?? [`主题-${id}`],
    discoveryMethod: 'rss',
    materialLevel: 'snippet-only',
    independenceKey: options.independenceKey ?? `publisher:${sourceId}`,
  }
}

function fixtureEvents(count = 7, domain: DomainId = 'ai-tech') {
  const subjects = ['Alpha launches platform', 'Beta acquires studio', 'Gamma raises funding', 'Delta reports earnings', 'Epsilon appoints chair', 'Zeta security breach', 'Federal Reserve cuts rates', 'Eta signs agreement']
  return Array.from({ length: count }, (_, index) => createEvent(domain, [candidate(`item-${index}`, domain, {
    sourceId: `publisher-${index % 5}`,
    score: 100 - index,
    title: subjects[index] ?? `Unique subject ${index} builds facility`,
    description: `${subjects[index] ?? `Unique subject ${index} builds facility`} with verified details and a distinct action for this event.`,
    tags: [`主题-${index}`],
  })]))
}

function collection(events: NewsEvent[], domain: DomainId = 'ai-tech'): CollectionResult {
  return {
    domain,
    candidates: events.flatMap((event) => event.articles),
    fetched: events.length,
    sourceCount: 5,
    rssCandidates: events.length,
    searchCandidates: 0,
    searchCalls: 0,
    warnings: [],
  }
}

function validModelBriefing(events: NewsEvent[]): ModelBriefing {
  return {
    overview: '本期信息显示产业、政策与市场正在同步变化，需要结合可靠来源、后续执行数据和参与方行动判断其持续性。',
    keyTakeaway: '今日重点是验证政策动作能否转化为实际供给、采用与长期结构变化。',
    logic: '排序综合结构性影响、用户相关度、证据质量、时效性和来源多样性，并降低单一公司与狭窄主题的集中度。',
    newKnowledge: '评估重大新闻时，需要区分正式发布、实际执行、规模采用和最终结果，这些阶段的证据强度并不相同。',
    outlook: '如果后续官方文件、经营数据和独立报道相互印证，当前变化才可能发展为更稳定的中期趋势。',
    trendRadar: [
      { theme: '产业执行', direction: '↑', reason: '公开信息密度上升，但仍需验证实际落地。' },
      { theme: '证据质量', direction: '→', reason: '不同事件的来源完整度仍有差异。' },
    ],
    watchNext: ['官方文件', '独立媒体复核', '可量化经营数据'],
    stories: events.slice(0, 5).map((event, index) => ({
      id: event.id,
      title: `第${index + 1}项重要产业事件出现明确进展`,
      summary: '该事件已经出现可识别的新动作，现有材料说明参与方正在调整资源与执行安排，但影响范围和持续时间仍要等待更多可靠数据确认。',
      keyFacts: ['相关机构已经公布新的行动安排。', '现有来源提供了可追踪的原始材料。'],
      factSources: [
        { factIndex: 0, urls: [event.primaryArticle.url] },
        { factIndex: 1, urls: [event.primaryArticle.url] },
      ],
      whyItMatters: '这项变化可能影响产业投入、组织决策和用户采用。如果执行范围继续扩大，其影响会从单一参与方逐步传导到上下游。',
      background: '此前相关领域已经经历多轮技术和政策调整，但发布信息并不等于实际采用。判断这次变化需要观察执行主体、资源投入和可重复结果。',
      impactChain: ['正式动作出现', '参与方调整资源', '产业影响逐步显现'],
      affectedParties: ['产业参与者', '企业客户'],
      uncertainties: '当前材料仍不能确认长期效果，后续执行范围和独立验证结果尚不明确。',
      glossary: [{ term: '结构性影响', definition: '能够改变长期资源配置、规则或竞争格局的影响。' }],
      trend: {
        nearTerm: '如果官方继续补充材料，未来几天可能出现更多可验证细节。',
        mediumTerm: '若经营数据与执行结果一致，中期才可能形成稳定趋势。',
        signalsToWatch: ['官方后续文件', '独立来源确认'],
      },
      tags: [`主题-${index}`],
    })),
  }
}

class SequenceModel implements EditorialModel {
  readonly mode = 'qwen' as const
  calls = 0
  constructor(private readonly values: Array<unknown | Error>) {}
  async complete() {
    const value = this.values[this.calls++]
    if (value instanceof Error) throw value
    return value
  }
}

test('无 Tavily Key 时搜索层无调用并自动保持 RSS 回退能力', async () => {
  const previous = process.env.TAVILY_API_KEY
  delete process.env.TAVILY_API_KEY
  const runtime = createSearchRuntimeFromEnvironment()
  assert.equal(runtime.enabled, false)
  assert.deepEqual(await runtime.search('test'), [])
  assert.equal(runtime.stats.calls, 0)
  if (previous) process.env.TAVILY_API_KEY = previous
})

test('搜索、第二来源和全文读取限制由代码强制执行', async () => {
  let providerCalls = 0
  const provider: NewsSearchProvider = {
    id: 'mock',
    async search() { providerCalls += 1; return [] },
  }
  const runtime = new SearchRuntime(provider, { dailyLimit: 2, secondSourceEventLimit: 8 })
  await runtime.search('one')
  await runtime.search('two')
  await runtime.search('two')
  await runtime.search('three')
  assert.equal(providerCalls, 2)
  assert.equal(runtime.stats.skippedDuplicateQueries, 1)
  assert.equal(runtime.stats.exhausted, true)

  const secondRuntime = new SearchRuntime(provider, { dailyLimit: 32, secondSourceEventLimit: 8 })
  assert.equal(Array.from({ length: 10 }, () => secondRuntime.reserveSecondSourceEvent()).filter(Boolean).length, 8)

  const reader = new ArticleReader(2, async () => new Response('<article><p>'.concat('有效正文内容'.repeat(80), '</p></article>'), {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }))
  await reader.read('https://a.example/1')
  await reader.read('https://a.example/1')
  await reader.read('https://a.example/2')
  await reader.read('https://a.example/3')
  assert.equal(reader.attempted, 2)
  assert.equal(reader.succeeded, 2)
})

test('RSS 与搜索结果按 URL 和标题合并去重', () => {
  const rss = candidate('rss', 'ai-tech', { title: '英伟达发布新一代芯片平台', sourceId: 'rss' })
  const search = { ...candidate('search', 'ai-tech', { title: '英伟达发布新一代芯片平台', sourceId: 'search' }), url: rss.url, discoveryMethod: 'news-search' as const }
  const merged = deduplicateCandidates([rss, search])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].duplicates?.length, 1)
})

test('不同网站转载同一通讯社内容只算一个独立来源', () => {
  const evidence = buildEvidence([
    candidate('wire-a', 'world', { sourceId: 'site-a', description: 'Reuters reported the verified action.', independenceKey: 'wire:reuters' }),
    candidate('wire-b', 'world', { sourceId: 'site-b', description: 'Reuters reported the same action.', independenceKey: 'wire:reuters' }),
  ])
  assert.equal(evidence.sourceCount, 2)
  assert.equal(evidence.independentSourceCount, 1)
  assert.equal(evidence.level, 'unverified')
})

test('最终门禁限制主来源数量和 unverified 排名', () => {
  const events = fixtureEvents()
  events.forEach((event) => { event.primaryArticle.source = source('same-publisher') })
  const briefing = buildRulesBriefing(collection(events), new Date('2026-08-15T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
  const broken: DailyBriefing = {
    ...briefing,
    stories: briefing.stories.map((story, index) => ({
      ...story,
      title: `第${index + 1}条自然中文重点新闻`,
      summary: '这是完整的中文摘要，用于说明事件的事实边界、潜在影响以及后续需要观察的验证信号。',
      whyItMatters: '这项变化可能影响多个参与方，但仍要结合后续数据和可靠来源判断。',
      background: '相关领域此前已经出现多轮变化，当前信息需要放入更长时间范围内判断。',
      source: { ...story.source, name: '集中来源' },
      evidence: index === 0 ? { ...story.evidence, level: 'unverified' } : story.evidence,
      trend: { nearTerm: '如果信息增加，短期可能变化。', mediumTerm: '若数据确认，中期可能延续。', signalsToWatch: ['官方文件', '数据'] },
    })),
  }
  const errors = validateBriefing(broken, events)
  assert.ok(errors.some((error) => error.includes('主来源')))
  assert.ok(errors.some((error) => error.includes('unverified')))
})

test('跨领域重复事件只保留主归属且全局门禁可识别重复', () => {
  const ai = fixtureEvents(6, 'ai-tech')
  const markets = fixtureEvents(6, 'markets')
  markets[0].canonicalTitle = ai[0].canonicalTitle
  markets[0].primaryArticle.title = ai[0].primaryArticle.title
  const deduped = deduplicateAcrossDomains([{ domain: 'ai-tech', events: ai }, { domain: 'markets', events: markets }])
  assert.equal(deduped[0].events.length + deduped[1].events.length, 11)

  const left = buildRulesBriefing(collection(ai), new Date('2026-08-15T00:00:00Z'), ai.slice(0, 5).map((event) => event.id))
  const right = buildRulesBriefing(collection(markets, 'markets'), new Date('2026-08-15T00:00:00Z'), markets.slice(0, 5).map((event) => event.id))
  right.stories[0].title = left.stories[0].title
  assert.ok(validateCrossDomainUniqueness([left, right]).length >= 1)
})

test('Qwen 非法 ID 会修复一次，JSON 失败也会重试', async () => {
  const events = fixtureEvents()
  const valid = validModelBriefing(events)
  const invalid = { ...valid, stories: valid.stories.map((story, index) => index === 0 ? { ...story, id: 'not-in-pool' } : story) }
  const invalidIdModel = new SequenceModel([invalid, valid])
  const repaired = await finalizeBriefing(collection(events), events, invalidIdModel, new Date('2026-08-15T00:00:00Z'))
  assert.equal(repaired.pipeline.qualityStatus, 'passed')
  assert.equal(repaired.pipeline.qwenRetries, 1)
  assert.equal(invalidIdModel.calls, 2)

  const jsonFailureModel = new SequenceModel([new SyntaxError('invalid JSON'), valid])
  const retried = await finalizeBriefing(collection(events), events, jsonFailureModel, new Date('2026-08-15T00:00:00Z'))
  assert.equal(retried.pipeline.qualityStatus, 'passed')
  assert.equal(jsonFailureModel.calls, 2)
})

test('Qwen 两次失败后明确降级，不伪装成正常简报', async () => {
  const events = fixtureEvents()
  const model = new SequenceModel([new Error('bad one'), new Error('bad two')])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-15T00:00:00Z'))
  assert.equal(briefing.mode, 'rules')
  assert.equal(briefing.pipeline.qualityStatus, 'degraded')
  assert.match(briefing.pipeline.warnings.join(' '), /降级稿/)
})

test('门禁检查中文完整性和数字事实来源关联', () => {
  const events = fixtureEvents()
  const baseline = buildRulesBriefing(collection(events), new Date('2026-08-15T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
  baseline.stories = baseline.stories.map((story, index) => ({
    ...story,
    title: index === 0 ? 'Only English title' : `第${index + 1}条自然中文新闻`,
    summary: '这是自然完整的中文摘要，解释当前事实、背景边界和后续需要关注的验证信号。',
    whyItMatters: '如果事件继续推进，可能影响相关参与方的资源配置与长期决策。',
    background: '此前已经存在相关变化，但这一次是否形成长期趋势仍需更多公开数据确认。',
    keyFacts: index === 1 ? ['相关指标上升 25%。'] : ['相关机构公布新的执行安排。'],
    factSources: [],
    trend: { nearTerm: '如果官方补充材料，短期可能变化。', mediumTerm: '若数据确认，中期可能延续。', signalsToWatch: ['官方文件', '经营数据'] },
  }))
  const errors = validateBriefing(baseline, events)
  assert.ok(errors.some((error) => error.includes('自然完整中文')))
  assert.ok(errors.some((error) => error.includes('数字事实')))
})
