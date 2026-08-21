import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DailyBriefing, DomainId, SourceReliability } from '../shared/briefing.js'
import { deduplicateAcrossDomains, validateCrossDomainUniqueness } from './editorial.js'
import { ArticleReader } from './material.js'
import type { EditorialModel, ModelBriefing } from './model.js'
import {
  analysisFieldHasSevereConflict,
  createEditorialModelFromEnvironment,
  finalizeBriefing,
  preselectEvents,
  stabilizeBriefingWithBackups,
  validateBriefing,
  validateBriefingStory,
} from './model.js'
import { FileSearchResultCache } from './search-cache.js'
import {
  buildEvidence,
  buildEventSpecificContent,
  buildRulesBriefing,
  createEvent,
  deduplicateCandidates,
  type Candidate,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'
import {
  SearchRuntime,
  createSearchRuntimeFromEnvironment,
  type NewsSearchProvider,
  type SearchHit,
  type SearchResultCache,
} from './search.js'
import { resolveCrossDomainDuplicatesWithBackups } from './stability.js'

const wave4FixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/wave4-real-regressions.json')
const stabilityFixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/stability-2026-08-17.json')

async function wave4ModelRegression() {
  const fixture = JSON.parse(await readFile(wave4FixturePath, 'utf8')) as {
    modelRegression: { illegalEventId: string; unsupportedNumericFact: string }
  }
  return fixture.modelRegression
}

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
  const subjects = ['Alpha launches artificial intelligence platform', 'Beta acquires artificial intelligence studio', 'Gamma raises artificial intelligence funding', 'Delta reports artificial intelligence earnings', 'Epsilon appoints artificial intelligence chair', 'Zeta artificial intelligence security breach', 'Federal Reserve cuts rates for artificial intelligence markets', 'Eta signs artificial intelligence agreement']
  return Array.from({ length: count }, (_, index) => createEvent(domain, [candidate(`item-${index}`, domain, {
    sourceId: `publisher-${index % 5}`,
    score: 100 - index,
    title: subjects[index] ?? `Unique subject ${index} builds facility`,
    description: `${subjects[index] ?? `Unique subject ${index} builds facility`}. ${(subjects[index] ?? `Unique subject ${index}`).split(' ')[0]} will begin implementation on 2026-08-${String(10 + index).padStart(2, '0')} for artificial intelligence infrastructure customers.`,
    tags: [`主题-${index}`],
  })]))
}

function stabilityEvents(domain: DomainId, marketVariant = false) {
  const aiStories = [
    ['NVIDIA推出企业级AI服务器平台', 'NVIDIA于2026年8月17日推出企业级AI服务器平台，首批面向需要部署推理服务的企业客户。'],
    ['OpenAI上线企业编程智能体', 'OpenAI于2026年8月17日上线企业编程智能体，帮助软件团队处理协作开发和代码审查任务。'],
    ['SK海力士扩建HBM内存产能', 'SK海力士于2026年8月17日宣布扩建HBM内存产能，以增加面向AI服务器客户的供给。'],
    ['Anthropic发布Claude水印工具', 'Anthropic于2026年8月17日发布Claude水印工具，用于识别模型生成内容并支持企业治理。'],
    ['微软扩建欧洲数据中心', '微软于2026年8月17日宣布扩建欧洲数据中心，为企业云服务和人工智能应用增加算力。'],
    ['AMD推出新款数据中心芯片', 'AMD于2026年8月17日推出新款数据中心芯片，面向企业推理和服务器部署场景。'],
    ['英特尔启动先进封装生产线', '英特尔于2026年8月17日启动先进封装生产线，为数据中心芯片提供新增制造能力。'],
  ]
  const marketStories = [
    aiStories[0],
    ['美联储维持基准利率不变', '美联储于2026年8月17日维持基准利率不变，并表示将继续观察通胀和就业数据。'],
    ['美国劳工统计局公布消费者价格指数', '美国劳工统计局于2026年8月17日公布消费者价格指数，报告说明当月通胀指标的变化。'],
    ['美国政府公布原油运输计划', '美国政府于2026年8月17日公布原油运输计划，以应对主要航道的能源供应风险。'],
    ['伯克希尔增持Alphabet股份', '伯克希尔于2026年8月17日披露增持Alphabet股份，调整大型科技公司持仓配置。'],
    ['美国证监会起诉预IPO投资骗局', '美国证监会于2026年8月17日起诉一宗预IPO投资骗局，指控相关机构欺诈散户投资者。'],
    ['美国财政部公布债券收益率数据', '美国财政部于2026年8月17日公布债券收益率数据，为市场判断融资成本提供最新指标。'],
  ]
  const worldStories = [
    ['欧盟实施新一轮制裁', '欧盟于2026年8月17日实施新一轮制裁，措施覆盖贸易和技术出口。'],
    ['韩国政府签署安全协议', '韩国政府于2026年8月17日签署安全协议，协议涉及地区防务合作。'],
    ['黎巴嫩推进停火谈判', '黎巴嫩于2026年8月17日推进停火谈判，联合国代表参与新一轮会谈。'],
    ['印度尼西亚发生地震', '印度尼西亚于2026年8月17日发生地震，救援人员继续搜寻受影响居民。'],
    ['俄罗斯反战政治人物获刑', '俄罗斯法院于2026年8月17日判处反战政治人物十一年监禁。'],
    ['阿联酋油轮在霍尔木兹海峡遇袭', '两艘阿联酋油轮于2026年8月17日在霍尔木兹海峡遇袭，航运安全风险上升。'],
    ['俄罗斯袭击黑海粮食设施', '俄罗斯于2026年8月17日袭击黑海粮食设施，乌克兰称出口供应受到影响。'],
  ]
  const learningStories = [
    ['OECD发布PISA评估框架', 'OECD于2026年8月17日发布PISA评估框架，新增能力指标供成员教育系统参考。'],
    ['IB更新课程评估标准', 'IB于2026年8月17日更新课程评估标准，新要求面向后续考试周期。'],
    ['UNESCO启动AI素养项目', 'UNESCO于2026年8月17日启动AI素养项目，为教师培训提供课程材料。'],
    ['研究团队公布学习科学实验', '研究团队于2026年8月17日公布学习科学实验，结果比较两种反馈方式。'],
    ['教育部门实施课程改革', '教育部门于2026年8月17日实施课程改革，新课程覆盖评估和数字素养。'],
    ['大学推出教师AI培训', '大学于2026年8月17日推出教师AI培训，课程聚焦课堂使用和学术诚信。'],
    ['OECD发布教育趋势报告', 'OECD于2026年8月17日发布教育趋势报告，材料比较成员国课程政策变化。'],
  ]
  const stories = marketVariant ? marketStories : domain === 'world' ? worldStories : domain === 'learning' ? learningStories : aiStories
  return stories.map(([title, description], index) => createEvent(domain, [candidate(`stable-${domain}-${index}`, domain, {
    sourceId: `stable-${domain}-source-${index}`,
    title,
    description,
    score: 120 - index,
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
  const safeContent = events.slice(0, 5).map(buildEventSpecificContent)
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
      title: safeContent[index].title,
      summary: safeContent[index].summary,
      keyFacts: safeContent[index].keyFacts,
      factSources: safeContent[index].keyFacts.map((_, factIndex) => ({ factIndex, urls: [event.primaryArticle.url] })),
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

class MemorySearchCache implements SearchResultCache {
  complete = false
  responses = new Map<string, SearchHit[]>()
  async get(query: string) { return this.responses.get(query) }
  async set(query: string, hits: SearchHit[]) { this.responses.set(query, hits) }
  async isComplete() { return this.complete }
  async markComplete() { this.complete = true }
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
  assert.equal(Array.from({ length: 4 }, () => secondRuntime.reserveSecondSourceEvent('ai-tech')).filter(Boolean).length, 2)
  assert.equal(Array.from({ length: 4 }, () => secondRuntime.reserveSecondSourceEvent('markets')).filter(Boolean).length, 2)

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

test('同日完整搜索缓存会阻止重复 Tavily 调用', async () => {
  let providerCalls = 0
  const provider: NewsSearchProvider = {
    id: 'mock',
    async search() {
      providerCalls += 1
      return [{ title: '缓存新闻', url: 'https://cache.example/story', snippet: '缓存材料' }]
    },
  }
  const cache = new MemorySearchCache()
  const first = new SearchRuntime(provider, { dailyLimit: 32 }, cache)
  await first.prepare()
  assert.equal((await first.search('same query')).length, 1)
  await first.markCacheComplete()

  const replay = new SearchRuntime(provider, { dailyLimit: 32 }, cache)
  await replay.prepare()
  assert.equal(replay.cacheReplay, true)
  assert.equal((await replay.search('same query')).length, 1)
  assert.deepEqual(await replay.search('new query'), [])
  assert.equal(providerCalls, 1)
  assert.equal(replay.stats.calls, 0)
  assert.equal(replay.stats.cacheHits, 1)
})

test('搜索缓存可以跨进程实例保存并读取当天结果', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dailynews-search-cache-'))
  const path = resolve(directory, 'cache.json')
  const first = new FileSearchResultCache(path, '2026-08-15')
  const hits = [{ title: '持久缓存新闻', url: 'https://cache.example/persisted', snippet: '已保存材料' }]
  await first.set('persisted query', hits)
  await first.markComplete()

  const restored = new FileSearchResultCache(path, '2026-08-15')
  assert.equal(await restored.isComplete(), true)
  assert.deepEqual(await restored.get('persisted query'), hits)
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
  markets.slice(1).forEach((event, index) => {
    event.canonicalTitle = `市场独立事件 ${index + 1} 公布不同数据`
    event.primaryArticle.title = event.canonicalTitle
    event.primaryArticle.description = `该市场事件 ${index + 1} 具有独立主体、动作和数据。`
    event.primaryArticle.url = `https://markets.example/unique-${index + 1}`
    event.articles[0].title = event.primaryArticle.title
    event.articles[0].description = event.primaryArticle.description
    event.articles[0].url = event.primaryArticle.url
  })
  markets[0].canonicalTitle = ai[0].canonicalTitle
  markets[0].primaryArticle.title = ai[0].primaryArticle.title
  markets[0].articles[0].title = ai[0].articles[0].title
  const deduped = deduplicateAcrossDomains([{ domain: 'ai-tech', events: ai }, { domain: 'markets', events: markets }])
  assert.equal(deduped[0].events.length + deduped[1].events.length, 11)

  const gateAi = fixtureEvents(6, 'ai-tech')
  const gateMarkets = fixtureEvents(6, 'markets')
  const left = buildRulesBriefing(collection(gateAi), new Date('2026-08-15T00:00:00Z'), gateAi.slice(0, 5).map((event) => event.id))
  const right = buildRulesBriefing(collection(gateMarkets, 'markets'), new Date('2026-08-15T00:00:00Z'), gateMarkets.slice(0, 5).map((event) => event.id))
  right.stories[0].title = left.stories[0].title
  assert.ok(validateCrossDomainUniqueness([left, right]).length >= 1)
})

test('固定槽位忽略 Qwen 非法 ID，只有 JSON 失败才重试', async () => {
  const events = fixtureEvents()
  const regression = await wave4ModelRegression()
  const valid = validModelBriefing(events)
  const invalid = { ...valid, stories: valid.stories.map((story, index) => index === 0 ? { ...story, id: regression.illegalEventId } : story) }
  const invalidIdModel = new SequenceModel([invalid, valid])
  const repaired = await finalizeBriefing(collection(events), events, invalidIdModel, new Date('2026-08-15T00:00:00Z'))
  assert.equal(repaired.pipeline.qualityStatus, 'passed')
  assert.equal(repaired.pipeline.qwenRetries, 0)
  assert.equal(invalidIdModel.calls, 1)
  assert.equal(repaired.stories[0].id, events[0].id)

  const jsonFailureModel = new SequenceModel([new SyntaxError('invalid JSON'), valid])
  const retried = await finalizeBriefing(collection(events), events, jsonFailureModel, new Date('2026-08-15T00:00:00Z'))
  assert.equal(retried.pipeline.qualityStatus, 'passed')
  assert.equal(jsonFailureModel.calls, 2)
})

test('程序把结构化预测和来源 ID 转成可发布格式', async () => {
  const events = fixtureEvents()
  const value = validModelBriefing(events)
  value.stories[0] = {
    ...value.stories[0],
    factSources: value.stories[0].keyFacts.map((_, factIndex) => ({
      factIndex,
      sourceIds: [`${events[0].id}-source-1`],
    })),
    trend: {
      nearTerm: { condition: '官方继续披露执行材料', outlook: '未来几天出现更多细节' },
      mediumTerm: { condition: '经营数据与执行结果一致', outlook: '中期形成稳定趋势' },
      signalsToWatch: [],
    },
  }
  const model = new SequenceModel([value])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-15T00:00:00Z'))
  assert.equal(briefing.pipeline.qualityStatus, 'passed')
  assert.match(briefing.stories[0].trend.nearTerm, /如果/)
  assert.ok(briefing.stories[0].trend.signalsToWatch.length >= 2)
  assert.deepEqual(briefing.stories[0].factSources[0].urls, [events[0].primaryArticle.url])
})

test('无来源数字只删除对应数字并保留其余事实且不增加 Qwen 调用', async () => {
  const events = fixtureEvents()
  const regression = await wave4ModelRegression()
  const broken = validModelBriefing(events)
  broken.stories[0] = {
    ...broken.stories[0],
    keyFacts: [regression.unsupportedNumericFact],
    factSources: [{ factIndex: 0, sourceIds: [`${events[0].id}-source-1`] }],
  }
  const model = new SequenceModel([broken])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-15T00:00:00Z'))
  assert.equal(briefing.pipeline.qualityStatus, 'passed')
  assert.equal(model.calls, 1)
  assert.doesNotMatch(briefing.stories[0].keyFacts.join(' '), /99/)
  assert.match(briefing.stories[0].keyFacts.join(' '), /Alpha.*2026-08/)
  assert.doesNotMatch(briefing.stories[0].keyFacts.join(' '), /定性结论|这里仅保留/)
})

test('固定槽位不会因单条数字错误替换事件', async () => {
  const events = fixtureEvents()
  const regression = await wave4ModelRegression()
  const broken = validModelBriefing(events)
  broken.stories[0] = {
    ...broken.stories[0],
    keyFacts: [regression.unsupportedNumericFact],
    factSources: [{ factIndex: 0, sourceIds: [`${events[0].id}-source-1`] }],
  }
  const model = new SequenceModel([broken])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-15T00:00:00Z'))
  assert.equal(briefing.pipeline.qualityStatus, 'passed')
  assert.equal(model.calls, 1)
  assert.equal(briefing.stories[0].id, events[0].id)
  assert.ok(!briefing.stories.some((story) => story.id === events[5].id))
})

test('8月17日回归：预选保留合法 ID 并用规则补足，不废弃整份结果', async () => {
  const events = fixtureEvents(10)
  const model = new SequenceModel([{
    selections: [
      { id: events[2].id, reason: '高价值合法事件' },
      { id: 'illegal-event-id', reason: '模型幻觉 ID' },
      { id: events[0].id, reason: '第二个合法事件' },
    ],
  }])
  const result = await preselectEvents(collection(events), model)
  assert.equal(model.calls, 1)
  assert.equal(result.usedModel, true)
  assert.ok(result.events.length >= 7 && result.events.length <= 10)
  assert.deepEqual(result.events.slice(0, 2).map((event) => event.id), [events[2].id, events[0].id])
  assert.equal(result.events.some((event) => event.id === 'illegal-event-id'), false)
  assert.match(result.warnings.join(' '), /忽略 1 个非法 ID.*规则补足/)
})

test('8月17日诊断夹具固定真实错误、门禁误报和32次生产预算', async () => {
  const fixture = JSON.parse(await readFile(stabilityFixturePath, 'utf8')) as {
    runId: number
    diagnosticArtifactId: number
    searchCalls: number
    domains: Record<string, { realGateFindings: number; analysisFalsePositives: number; selectedIds: string[]; backupIds: string[] }>
    crossDomainDuplicate: string[]
    expected: { productionSearchBudget: number }
  }
  const domains = Object.values(fixture.domains)
  assert.equal(fixture.runId, 31980121053)
  assert.equal(fixture.diagnosticArtifactId, 9272177382)
  assert.equal(domains.reduce((sum, item) => sum + item.analysisFalsePositives, 0), 5)
  assert.equal(domains.reduce((sum, item) => sum + item.realGateFindings, 0) + Number(fixture.crossDomainDuplicate.length === 2), 21)
  assert.equal(domains.every((item) => item.selectedIds.length === 5 && item.backupIds.length >= 4), true)
  assert.equal(domains.every((item) => item.backupIds.every((id) => !item.selectedIds.includes(id))), true)
  assert.equal(fixture.searchCalls, fixture.expected.productionSearchBudget)
  assert.equal(fixture.searchCalls, 32)
})

test('8月17日回归：四个领域的单条坏稿都会换入最高优先级备用事件并保持通过', () => {
  for (const domain of ['ai-tech', 'markets', 'world', 'learning'] as const) {
    const events = stabilityEvents(domain, domain === 'markets')
    const domainCollection = collection(events, domain)
    const baseline = buildRulesBriefing(domainCollection, new Date('2026-08-17T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
    const badId = baseline.stories[0].id
    const broken: DailyBriefing = {
      ...baseline,
      mode: 'qwen',
      stories: baseline.stories.map((story) => story.id === badId ? {
        ...story,
        title: '来源发布相关更新',
        summary: '来源材料发布了与当前主题相关的新信息。',
      } : story),
    }
    const stabilized = stabilizeBriefingWithBackups(domainCollection, broken, events, new Date('2026-08-17T00:00:00Z'))
    assert.equal(stabilized.errors.length, 0, `${domain}: ${stabilized.errors.join('；')} | events=${events.map((event) => `${event.id}:${event.canonicalTitle}`).join('|')} | eligible=${stabilized.eligibleOptionIds.join(',')}`)
    assert.ok(stabilized.replacements.length <= 1, domain)
    if (stabilized.replacements.length) {
      assert.ok(events.slice(5).some((event) => event.id === stabilized.replacements[0].addedEventId), domain)
    }
    assert.equal(stabilized.briefing.pipeline.qualityStatus, 'passed', domain)
    assert.equal(stabilized.briefing.stories.some((story) => story.title === '来源发布相关更新'), false, domain)
  }
})

test('8月17日回归：合理跨领域因果分析放行，冲突事实和无来源数字仍拦截', () => {
  const event = createEvent('ai-tech', [candidate('nvidia-chain', 'ai-tech', {
    title: 'NVIDIA launches an AI server platform',
    description: 'NVIDIA launched an AI server platform for enterprise inference customers on 2026-08-17.',
    sourceId: 'nvidia.com',
    reliability: 'primary',
  })])
  assert.equal(analysisFieldHasSevereConflict('如果利率继续上升，企业融资成本可能增加，并影响AI服务器的部署节奏。', event), false)
  assert.equal(analysisFieldHasSevereConflict('OpenAI宣布推出一款面向儿童的新疫苗。', event), true)
  assert.equal(analysisFieldHasSevereConflict('如果需求延续，该平台可能带来999亿美元收入。', event), true)

  const briefing = buildRulesBriefing(collection([event, ...fixtureEvents(4)]), new Date('2026-08-17T00:00:00Z'), [event.id, ...fixtureEvents(4).map((item) => item.id)])
  const story = briefing.stories.find((item) => item.id === event.id)!
  const causalStory = { ...story, whyItMatters: '如果利率继续上升，企业融资成本可能增加，并影响AI服务器的部署节奏。' }
  assert.equal(validateBriefingStory(causalStory, event).some((error) => error.includes('分析字段')), false)
})

test('8月17日回归：跨领域重复自动保留高匹配领域并在另一领域换备用', () => {
  const ai = stabilityEvents('ai-tech')
  const markets = stabilityEvents('markets', true)
  markets[0] = createEvent('markets', [{ ...ai[0].primaryArticle, domain: 'markets' }])

  const aiCollection = collection(ai, 'ai-tech')
  const marketCollection = collection(markets, 'markets')
  const aiRules = buildRulesBriefing(aiCollection, new Date('2026-08-17T00:00:00Z'), ai.slice(0, 5).map((event) => event.id))
  const marketRules = buildRulesBriefing(marketCollection, new Date('2026-08-17T00:00:00Z'), markets.slice(0, 5).map((event) => event.id))
  const aiBriefing = { ...aiRules, pipeline: { ...aiRules.pipeline, qualityStatus: 'passed' as const } }
  const marketBriefing = { ...marketRules, pipeline: { ...marketRules.pipeline, qualityStatus: 'passed' as const } }
  const selections = [{ domain: 'ai-tech' as const, events: ai }, { domain: 'markets' as const, events: markets }]
  const resolved = resolveCrossDomainDuplicatesWithBackups(
    [aiBriefing, marketBriefing],
    [aiCollection, marketCollection],
    selections,
    new Date('2026-08-17T00:00:00Z'),
  )
  assert.equal(resolved.errors.length, 0, resolved.errors.join('；'))
  assert.ok(resolved.replacements.some((item) => item.reason === 'cross-domain-duplicate'))
  assert.equal(resolved.briefings.every((briefing) => briefing.pipeline.qualityStatus === 'passed'), true)
})

test('可靠 single-source 事件不会仅因未达到多源确认而被门禁拒绝', async () => {
  const events = fixtureEvents(7)
  assert.equal(events.every((event) => event.evidence.level === 'single-source'), true)
  const model = new SequenceModel([validModelBriefing(events)])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-17T00:00:00Z'))
  assert.equal(briefing.pipeline.qualityStatus, 'passed', briefing.pipeline.warnings.join('；'))
  assert.equal(validateBriefing(briefing, events).some((error) => /single-source|confirmed|corroborated/.test(error)), false)
})

test('Qwen 两次失败后明确降级，不伪装成正常简报', async () => {
  const events = fixtureEvents()
  const model = new SequenceModel([new Error('bad one'), new Error('bad two')])
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-15T00:00:00Z'))
  assert.equal(briefing.mode, 'rules')
  assert.equal(briefing.pipeline.qualityStatus, 'degraded')
  assert.match(briefing.pipeline.warnings.join(' '), /降级稿/)
})

test('Qwen 只对无响应的网络连接做短重试，正常响应仍只调用一次', async () => {
  const previous = {
    provider: process.env.AI_PROVIDER,
    key: process.env.DASHSCOPE_API_KEY,
    baseUrl: process.env.QWEN_BASE_URL,
    retryDelays: process.env.QWEN_NETWORK_RETRY_DELAYS_MS,
  }
  process.env.AI_PROVIDER = 'qwen'
  process.env.DASHSCOPE_API_KEY = 'test-only-key'
  process.env.QWEN_BASE_URL = 'https://dashscope.test/v1'
  process.env.QWEN_NETWORK_RETRY_DELAYS_MS = '1,1'
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    if (calls < 3) throw new TypeError('fetch failed', { cause: new Error('temporary connect error') })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
  }) as typeof fetch
  try {
    const model = createEditorialModelFromEnvironment(fetchImpl)!
    assert.deepEqual(await model.complete('test', 20), { ok: true })
    assert.equal(calls, 3)
  } finally {
    if (previous.provider == null) delete process.env.AI_PROVIDER
    else process.env.AI_PROVIDER = previous.provider
    if (previous.key == null) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previous.key
    if (previous.baseUrl == null) delete process.env.QWEN_BASE_URL
    else process.env.QWEN_BASE_URL = previous.baseUrl
    if (previous.retryDelays == null) delete process.env.QWEN_NETWORK_RETRY_DELAYS_MS
    else process.env.QWEN_NETWORK_RETRY_DELAYS_MS = previous.retryDelays
  }
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
