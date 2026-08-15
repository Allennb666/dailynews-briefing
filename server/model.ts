import type {
  DailyBriefing,
  GlossaryTerm,
  StoryTrend,
  TrendRadarItem,
} from '../shared/briefing.js'
import { DOMAIN_CONFIGS } from './sources.js'
import type { CollectionResult, NewsEvent } from './pipeline.js'
import { buildCandidatePool, buildRulesBriefing } from './pipeline.js'

type ProviderConfig = {
  mode: 'qwen'
  apiKey: string
  baseUrl: string
  model: string
}

export type ModelStory = {
  id: string
  title: string
  summary: string
  keyFacts: string[]
  factSources: Array<{
    factIndex: number
    sourceIds?: string[]
    urls?: string[]
  }>
  whyItMatters: string
  background: string
  impactChain: string[]
  affectedParties: string[]
  uncertainties: string
  glossary: GlossaryTerm[]
  trend: {
    nearTerm: string | { condition: string; outlook: string }
    mediumTerm: string | { condition: string; outlook: string }
    signalsToWatch: string[]
  }
  tags: string[]
}

export type ModelBriefing = {
  overview: string
  keyTakeaway: string
  logic: string
  newKnowledge: string
  outlook: string
  trendRadar: TrendRadarItem[]
  watchNext: string[]
  stories: ModelStory[]
}

export interface EditorialModel {
  readonly mode: 'qwen'
  complete(prompt: string, maxTokens: number): Promise<unknown>
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return JSON.parse((fenced?.[1] ?? text).trim()) as unknown
}

class QwenEditorialModel implements EditorialModel {
  readonly mode = 'qwen' as const

  constructor(private readonly provider: ProviderConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async complete(prompt: string, maxTokens: number) {
    const response = await this.fetchImpl(`${this.provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.provider.model,
        temperature: 0.15,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是严谨的中文新闻主编。只依据给定材料，严格区分事实、分析、不确定性与条件式预测。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Qwen 返回 ${response.status}: ${detail.slice(0, 180)}`)
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('Qwen 未返回可用内容')
    return extractJson(content)
  }
}

export function createEditorialModelFromEnvironment(fetchImpl: typeof fetch = fetch): EditorialModel | null {
  const requested = (process.env.AI_PROVIDER ?? 'auto').toLocaleLowerCase()
  if (requested === 'rules') return null
  if (!['auto', 'qwen'].includes(requested)) throw new Error(`AI_PROVIDER 仅支持 qwen、auto 或 rules；当前为 ${requested}`)
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? ''
  if (!apiKey) return null
  return new QwenEditorialModel({
    mode: 'qwen',
    apiKey,
    baseUrl: process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.QWEN_MODEL ?? 'qwen3.5-27b',
  }, fetchImpl)
}

function stringArray(value: unknown, minimum = 1): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}

function validGlossary(value: unknown): value is GlossaryTerm[] {
  return Array.isArray(value) && value.every((item) => item && typeof item.term === 'string' && typeof item.definition === 'string')
}

type ModelTrend = ModelStory['trend']

function validTrend(value: unknown): value is ModelTrend {
  if (!value || typeof value !== 'object') return false
  const trend = value as Partial<ModelTrend>
  const validPeriod = (period: unknown) => typeof period === 'string'
    || Boolean(period && typeof period === 'object'
      && typeof (period as { condition?: unknown }).condition === 'string'
      && typeof (period as { outlook?: unknown }).outlook === 'string')
  return validPeriod(trend.nearTerm) && validPeriod(trend.mediumTerm) && Array.isArray(trend.signalsToWatch)
}

function validRadar(value: unknown): value is TrendRadarItem[] {
  const directions = new Set(['↑↑', '↑', '→', '↓', '高波动'])
  return Array.isArray(value) && value.length >= 2 && value.every((item) =>
    item && typeof item.theme === 'string' && typeof item.reason === 'string' && directions.has(item.direction),
  )
}

function validFactSources(value: unknown): value is ModelStory['factSources'] {
  return Array.isArray(value) && value.every((item) => item
    && Number.isInteger(item.factIndex)
    && item.factIndex >= 0
    && (stringArray(item.sourceIds) || stringArray(item.urls)))
}

function preferredString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function articleSourceId(event: NewsEvent, index: number) {
  return `${event.id}-source-${index + 1}`
}

function modelInput(events: NewsEvent[], materialLimit = 5_000, previousTitles: string[] = []) {
  return events.map((event) => ({
    id: event.id,
    canonicalTitle: event.canonicalTitle,
    entities: event.entities,
    topicTags: event.topicTags,
    publishedAt: event.publishedAt,
    latestUpdateAt: event.latestUpdateAt,
    editorialScore: Math.round(event.primaryArticle.score),
    evidence: event.evidence,
    comparedWithPrevious: previousTitles.some((title) => {
      const left = title.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      const right = event.canonicalTitle.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      return left === right || (left.length > 8 && right.includes(left.slice(0, Math.min(left.length, 16))))
    }) ? 'possible-repeat-needs-new-development' : 'new-candidate',
    articles: event.articles.map((article, index) => ({
      sourceId: articleSourceId(event, index),
      title: article.title,
      material: (article.fullText || article.description).slice(0, materialLimit),
      discoveryMethod: article.discoveryMethod,
      materialLevel: article.materialLevel,
      source: article.source.name,
      sourceType: article.source.type,
      sourceReliability: article.source.reliability,
      publishedAt: article.publishedAt,
      url: article.url,
    })),
  }))
}

const CONDITIONAL_PREDICTION = /如果|若|可能|取决于|需(?:要)?观察|在.+(?:情况下|前提下)/

function normalizeTrendPeriod(value: ModelTrend['nearTerm'], fallback: string) {
  const text = typeof value === 'string'
    ? value.trim()
    : [value.condition.trim(), value.outlook.trim()].filter(Boolean).join('，')
  const usable = text || fallback
  return CONDITIONAL_PREDICTION.test(usable)
    ? usable
    : `如果后续公开证据继续支持这一判断，${usable}`
}

function normalizeTrend(value: unknown, fallback: StoryTrend, event: NewsEvent): StoryTrend {
  if (!validTrend(value)) return fallback
  const defaultSignals = [
    `${event.primaryArticle.source.name}的后续正式信息`,
    '独立可靠来源的交叉验证',
  ]
  const signals = [...new Set([
    ...value.signalsToWatch.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()),
    ...defaultSignals,
  ])].slice(0, 4)
  return {
    nearTerm: normalizeTrendPeriod(value.nearTerm, fallback.nearTerm),
    mediumTerm: normalizeTrendPeriod(value.mediumTerm, fallback.mediumTerm),
    signalsToWatch: signals,
  }
}

function normalizedNumberTokens(value: string) {
  return (value.match(/\d[\d,.]*(?:\.\d+)?%?/g) ?? []).map((token) => token.replaceAll(',', '').toLocaleLowerCase())
}

function articleSupportsNumbers(article: NewsEvent['articles'][number], tokens: string[]) {
  const material = `${article.title} ${article.description} ${article.fullText ?? ''}`.replaceAll(',', '').toLocaleLowerCase()
  return tokens.length > 0 && tokens.every((token) => material.includes(token))
}

function resolveFactSources(
  value: unknown,
  event: NewsEvent,
  keyFacts: string[],
) {
  const sourceUrls = new Map(event.articles.map((article, index) => [articleSourceId(event, index), article.url]))
  const allowedUrls = new Set(event.articles.map((article) => article.url))
  const resolved = new Map<number, Set<string>>()
  if (validFactSources(value)) {
    for (const link of value) {
      if (link.factIndex >= keyFacts.length) continue
      const urls = [
        ...(link.sourceIds ?? []).flatMap((sourceId) => sourceUrls.get(sourceId) ?? []),
        ...(link.urls ?? []).filter((url) => allowedUrls.has(url)),
      ]
      if (urls.length) resolved.set(link.factIndex, new Set(urls))
    }
  }
  keyFacts.forEach((fact, factIndex) => {
    if (resolved.has(factIndex)) return
    const tokens = normalizedNumberTokens(fact)
    if (!tokens.length) return
    const matches = event.articles.filter((article) => articleSupportsNumbers(article, tokens))
    if (matches.length) resolved.set(factIndex, new Set(matches.slice(0, 2).map((article) => article.url)))
  })
  return [...resolved.entries()]
    .sort(([left], [right]) => left - right)
    .map(([factIndex, urls]) => ({ factIndex, urls: [...urls] }))
}

export type PreselectionResult = {
  events: NewsEvent[]
  reasons: Record<string, string>
  usedModel: boolean
  warnings: string[]
}

function fallbackPreselection(events: NewsEvent[]) {
  const selected: NewsEvent[] = []
  const sourceCounts = new Map<string, number>()
  const entityCounts = new Map<string, number>()
  for (const event of events) {
    const sourceId = event.primaryArticle.source.id
    const narrowEntity = event.entities[0] ?? event.topicTags[0] ?? event.id
    if ((sourceCounts.get(sourceId) ?? 0) >= 2 || (entityCounts.get(narrowEntity) ?? 0) >= 2) continue
    if (event.evidence.level === 'unverified' && selected.length < 3) continue
    selected.push(event)
    sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1)
    entityCounts.set(narrowEntity, (entityCounts.get(narrowEntity) ?? 0) + 1)
    if (selected.length === Math.min(10, events.length)) break
  }
  for (const event of events) {
    if (selected.length >= Math.min(10, events.length)) break
    if (!selected.includes(event)) selected.push(event)
  }
  return selected
}

function feasiblePreselection(proposed: NewsEvent[], pool: NewsEvent[]) {
  const ordered = [...proposed, ...fallbackPreselection(pool), ...pool]
  const selected: NewsEvent[] = []
  const sourceCounts = new Map<string, number>()
  const entityCounts = new Map<string, number>()
  let otherCount = 0
  let unverifiedCount = 0
  for (const event of ordered) {
    if (selected.some((item) => item.id === event.id)) continue
    const sourceId = event.primaryArticle.source.id
    const narrow = event.entities[0] ?? event.topicTags[0] ?? event.id
    const isOther = event.primaryArticle.source.reliability === 'other'
    const isUnverified = event.evidence.level === 'unverified'
    if ((sourceCounts.get(sourceId) ?? 0) >= 2 || (entityCounts.get(narrow) ?? 0) >= 2) continue
    if (isOther && otherCount >= 1) continue
    if (isUnverified && unverifiedCount >= 1) continue
    selected.push(event)
    sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1)
    entityCounts.set(narrow, (entityCounts.get(narrow) ?? 0) + 1)
    if (isOther) otherCount += 1
    if (isUnverified) unverifiedCount += 1
    if (selected.length === Math.min(10, pool.length)) break
  }
  for (const event of ordered) {
    if (selected.length >= Math.min(10, pool.length)) break
    if (!selected.some((item) => item.id === event.id)) selected.push(event)
  }
  return selected
}

export async function preselectEvents(
  collection: CollectionResult,
  model: EditorialModel | null,
): Promise<PreselectionResult> {
  const pool = buildCandidatePool(collection, 60)
  if (!model) return {
    events: fallbackPreselection(pool),
    reasons: {},
    usedModel: false,
    warnings: ['未配置 Qwen，新闻预选使用规则降级'],
  }
  const config = DOMAIN_CONFIGS[collection.domain]
  const prompt = `你是 DailyNews 的预选编辑。当前领域是“${config.title}”。从事件池预选 7–10 个事件供后续阅读全文和深度写作。

只输出事件 ID 和一句简短理由，不写简报。综合：结构性影响、用户关注、证据质量、相比昨日的新变化、时效性、来源/主题多样性和跨领域影响。惩罚猎奇标题、低可靠性单源、传闻、无新进展的重复，以及同公司/来源/子话题集中。
用户重点：AI 基础设施/芯片/HBM/先进封装/AI Coding/Agent；科技公司基本面、通胀、利率、债券、油价、财报；地缘冲突、能源、航运、粮食、科技安全；IB、AI Literacy、学习科学、Assessment、课程改革。
重大新闻若只有 other 单一来源不得排在前三。ID 必须来自输入。
JSON：{"selections":[{"id":"","reason":""}]}
昨日标题：${JSON.stringify(collection.previousTitles ?? [])}
事件池：${JSON.stringify(modelInput(pool, 900, collection.previousTitles ?? []))}`
  try {
    const value = await model.complete(prompt, 3_000) as { selections?: Array<{ id?: unknown; reason?: unknown }> }
    const poolById = new Map(pool.map((event) => [event.id, event]))
    const ids = [...new Set((value?.selections ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string'))]
    if (ids.length < 7 || ids.length > 10 || ids.some((id) => !poolById.has(id))) throw new Error('Qwen 预选返回非法 ID 或数量')
    const reasons = Object.fromEntries((value.selections ?? []).flatMap((item) =>
      typeof item.id === 'string' && typeof item.reason === 'string' ? [[item.id, item.reason]] : [],
    ))
    return { events: feasiblePreselection(ids.map((id) => poolById.get(id)!), pool), reasons, usedModel: true, warnings: [] }
  } catch (error) {
    return {
      events: fallbackPreselection(pool),
      reasons: {},
      usedModel: false,
      warnings: [`Qwen 预选失败：${error instanceof Error ? error.message : String(error)}；已使用规则预选`],
    }
  }
}

function mergeModelBriefing(baseline: DailyBriefing, value: unknown, events: NewsEvent[]) {
  if (!value || typeof value !== 'object') throw new Error('Qwen 返回内容不是对象')
  const analysis = value as Partial<ModelBriefing>
  if (!Array.isArray(analysis.stories)) throw new Error('Qwen 未返回 stories')
  const incomingById = new Map(analysis.stories.filter((story) => story && typeof story.id === 'string').map((story) => [story.id, story]))
  const eventById = new Map(events.map((event) => [event.id, event]))
  const stories = baseline.stories.map((story) => {
    const incoming = incomingById.get(story.id)
    if (!incoming) return story
    const event = eventById.get(story.id)
    if (!event) return story
    const hasIncomingKeyFacts = stringArray(incoming.keyFacts)
    const keyFacts = hasIncomingKeyFacts ? incoming.keyFacts.slice(0, 4) : story.keyFacts
    const factSources = hasIncomingKeyFacts ? resolveFactSources(incoming.factSources, event, keyFacts) : story.factSources
    return {
      ...story,
      title: preferredString(incoming.title, story.title),
      summary: preferredString(incoming.summary, story.summary),
      keyFacts,
      factSources,
      whyItMatters: preferredString(incoming.whyItMatters, story.whyItMatters),
      background: preferredString(incoming.background, story.background),
      impactChain: stringArray(incoming.impactChain, 3) ? incoming.impactChain.slice(0, 5) : story.impactChain,
      affectedParties: stringArray(incoming.affectedParties, 2) ? incoming.affectedParties.slice(0, 4) : story.affectedParties,
      uncertainties: preferredString(incoming.uncertainties, story.uncertainties),
      glossary: validGlossary(incoming.glossary) ? incoming.glossary.slice(0, 4) : story.glossary,
      trend: normalizeTrend(incoming.trend, story.trend, event),
      tags: stringArray(incoming.tags) ? incoming.tags.slice(0, 3) : story.tags,
    }
  })
  return {
    ...baseline,
    mode: 'qwen' as const,
    overview: preferredString(analysis.overview, baseline.overview),
    keyTakeaway: preferredString(analysis.keyTakeaway, baseline.keyTakeaway),
    logic: preferredString(analysis.logic, baseline.logic),
    newKnowledge: preferredString(analysis.newKnowledge, baseline.newKnowledge),
    outlook: preferredString(analysis.outlook, baseline.outlook),
    trendRadar: validRadar(analysis.trendRadar) ? analysis.trendRadar.slice(0, 4) : baseline.trendRadar,
    watchNext: stringArray(analysis.watchNext, 3) ? analysis.watchNext.slice(0, 5) : baseline.watchNext,
    stories,
  } satisfies DailyBriefing
}

function hanRatio(value: string) {
  const meaningful = value.replace(/\s|[\p{P}\p{S}\d]/gu, '')
  if (!meaningful.length) return 0
  return (meaningful.match(/[\p{Script=Han}]/gu) ?? []).length / meaningful.length
}

export function validateBriefing(briefing: DailyBriefing, events: NewsEvent[]) {
  const errors: string[] = []
  const eventById = new Map(events.map((event) => [event.id, event]))
  if (briefing.stories.length !== 5) errors.push('每领域必须正好 5 条')
  if (new Set(briefing.stories.map((story) => story.id)).size !== briefing.stories.length) errors.push('存在重复事件 ID')
  if (briefing.stories.some((story) => !eventById.has(story.id))) errors.push('存在候选池之外的事件 ID')
  const sourceCounts = new Map<string, number>()
  const entityCounts = new Map<string, number>()
  for (const story of briefing.stories) {
    const event = eventById.get(story.id)
    const source = event?.primaryArticle.source.id ?? story.source.name
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
    const narrow = event?.entities[0] ?? story.tags[0] ?? story.id
    entityCounts.set(narrow, (entityCounts.get(narrow) ?? 0) + 1)
    if (hanRatio(story.title) < 0.18 || hanRatio(`${story.summary}${story.whyItMatters}${story.background}`) < 0.45) errors.push(`${story.id} 不是自然完整中文`)
    const allowedUrls = new Set(event?.articles.map((article) => article.url) ?? [])
    story.keyFacts.forEach((fact, factIndex) => {
      const links = story.factSources.find((link) => link.factIndex === factIndex)?.urls ?? []
      const numberTokens = normalizedNumberTokens(fact)
      if (!links.length || links.some((url) => !allowedUrls.has(url))) {
        errors.push(`${story.id} 的${numberTokens.length ? '数字事实' : '关键事实'} ${factIndex} 未关联候选来源`)
        return
      }
      if (numberTokens.length) {
        const linkedArticles = event?.articles.filter((article) => links.includes(article.url)) ?? []
        if (!linkedArticles.some((article) => articleSupportsNumbers(article, numberTokens))) {
          errors.push(`${story.id} 的数字事实 ${factIndex} 未被关联来源材料支持`)
        }
      }
    })
    const prediction = `${story.trend.nearTerm} ${story.trend.mediumTerm}`
    if (!/如果|若|可能|取决于|需(?:要)?观察|在.+(?:情况下|前提下)/.test(prediction) || story.trend.signalsToWatch.length < 2) {
      errors.push(`${story.id} 的预测缺少条件表达或验证信号`)
    }
  }
  if ([...sourceCounts.values()].some((count) => count > 2)) errors.push('同一主来源超过 2 条')
  if (sourceCounts.size < 3) errors.push('主来源少于 3 个')
  if (briefing.stories.filter((story) => story.source.reliability === 'other').length > 1) errors.push('other 来源超过 1 条')
  const unverified = briefing.stories.filter((story) => story.evidence.level === 'unverified')
  if (unverified.length > 1 || briefing.stories.slice(0, 3).some((story) => story.evidence.level === 'unverified')) errors.push('unverified 数量或排名不合规')
  const first = briefing.stories[0]
  if (first?.source.reliability === 'other' && first.evidence.level === 'single-source') errors.push('第一名不能是 other + single-source')
  if ([...entityCounts.values()].some((count) => count > 2)) errors.push('同一公司或狭窄子话题超过 2 条')
  return [...new Set(errors)]
}

function selectedCollection(collection: CollectionResult, events: NewsEvent[]): CollectionResult {
  return { ...collection, candidates: events.flatMap((event) => event.articles) }
}

function finalPrompt(collection: CollectionResult, events: NewsEvent[], repair?: { errors: string[]; previous?: unknown }) {
  const config = DOMAIN_CONFIGS[collection.domain]
  const repairBlock = repair
    ? `\n上一次输出未通过程序门禁。错误：${JSON.stringify(repair.errors)}。请完整重写，不要解释错误。上一次输出：${JSON.stringify(repair.previous ?? {})}`
    : ''
  return `你是 DailyNews 的中文深度简报主编，当前领域是“${config.title}”。从 7–10 个预选事件中最终选择并排序恰好 5 条，生成适合晨间速览和折叠深读的结构化简报。${repairBlock}

硬规则：同一主来源最多 2 条；至少 3 个主来源；other 最多 1 条；unverified 最多 1 条且不得前三；第一名不得 other+single-source；同公司/窄话题最多 2 条；ID 只能来自输入且不得重复；标题与正文使用自然克制中文。
事实规则：数字、日期、动作、引语只能来自 articles。每条 keyFacts 都要用 factSources 以 factIndex（从 0 开始）关联 articles 中已有的 sourceId；不要复制或编造 URL。不得把分析写成事实。
预测规则：nearTerm 和 mediumTerm 分别输出 condition 与 outlook；condition 说明成立条件，outlook 只写条件成立时可能发生的结果。另给 2–4 个可验证 signalsToWatch。
深度：summary 80–150 字；keyFacts 2–4 条；whyItMatters 80–150 字；background 100–180 字；impactChain 3–5 节点；affectedParties 2–4 条；uncertainties 明确信息边界；glossary 1–4 个。领域 overview/logic/newKnowledge/outlook 各 100–200 字，keyTakeaway 50–100 字。
只输出 JSON：
{"overview":"","keyTakeaway":"","logic":"","newKnowledge":"","outlook":"","trendRadar":[{"theme":"","direction":"↑↑|↑|→|↓|高波动","reason":""}],"watchNext":[""],"stories":[{"id":"","title":"","summary":"","keyFacts":["",""],"factSources":[{"factIndex":0,"sourceIds":[""]}],"whyItMatters":"","background":"","impactChain":["","", ""],"affectedParties":["",""],"uncertainties":"","glossary":[{"term":"","definition":""}],"trend":{"nearTerm":{"condition":"如果……","outlook":"可能……"},"mediumTerm":{"condition":"若……","outlook":"可能……"},"signalsToWatch":["",""]},"tags":[""]}]}
输入事件：${JSON.stringify(modelInput(events, 5_000, collection.previousTitles ?? []))}`
}

function storyIdsFromErrors(errors: string[], events: NewsEvent[]) {
  return events
    .map((event) => event.id)
    .filter((id) => errors.some((error) => error.startsWith(`${id} `)))
}

function storyRepairPrompt(
  collection: CollectionResult,
  briefing: DailyBriefing,
  events: NewsEvent[],
  storyIds: string[],
  errors: string[],
) {
  const affected = events.filter((event) => storyIds.includes(event.id))
  const current = briefing.stories.filter((story) => storyIds.includes(story.id))
  return `你是 DailyNews 的定向校对编辑。只修复指定新闻，不要重写其他新闻，也不要改变事件 ID。

错误：${JSON.stringify(errors)}
当前新闻：${JSON.stringify(current)}
来源材料：${JSON.stringify(modelInput(affected, 5_000, collection.previousTitles ?? []))}

事实只能来自来源材料。factSources 必须使用材料内已有的 sourceId，不要输出 URL。预测必须分别给 condition、outlook，并提供至少两个可验证信号。
只输出：{"stories":[{"id":"原事件ID","title":"","summary":"","keyFacts":[""],"factSources":[{"factIndex":0,"sourceIds":["已有sourceId"]}],"whyItMatters":"","background":"","impactChain":["","",""],"affectedParties":["",""],"uncertainties":"","glossary":[{"term":"","definition":""}],"trend":{"nearTerm":{"condition":"如果……","outlook":"可能……"},"mediumTerm":{"condition":"若……","outlook":"可能……"},"signalsToWatch":["",""]},"tags":[""]}]}`
}

function contentError(error: string, events: NewsEvent[]) {
  return events.some((event) => error.startsWith(`${event.id} `))
}

function replacementBaseline(
  collection: CollectionResult,
  current: DailyBriefing,
  events: NewsEvent[],
  brokenId: string,
  replacement: NewsEvent,
  now: Date,
) {
  const ids = current.stories.map((story) => story.id === brokenId ? replacement.id : story.id)
  const baseline = buildRulesBriefing(selectedCollection(collection, events), now, ids)
  const currentById = new Map(current.stories.map((story) => [story.id, story]))
  return {
    ...baseline,
    mode: 'qwen' as const,
    overview: current.overview,
    keyTakeaway: current.keyTakeaway,
    logic: current.logic,
    newKnowledge: current.newKnowledge,
    outlook: current.outlook,
    trendRadar: current.trendRadar,
    watchNext: current.watchNext,
    stories: baseline.stories.map((story) => currentById.get(story.id) ?? story),
  }
}

function replacementPrompt(collection: CollectionResult, brokenId: string, replacement: NewsEvent, errors: string[]) {
  return `你是 DailyNews 的替补新闻编辑。事件 ${brokenId} 未通过门禁，请只为给定替补事件写一条完整中文新闻。

原错误：${JSON.stringify(errors)}
替补材料：${JSON.stringify(modelInput([replacement], 5_000, collection.previousTitles ?? []))}

不得使用原事件 ID。事实只能来自替补材料；factSources 只使用已有 sourceId；预测分别输出 condition、outlook 和至少两个验证信号。
只输出：{"stories":[{"id":"${replacement.id}","title":"","summary":"","keyFacts":[""],"factSources":[{"factIndex":0,"sourceIds":["已有sourceId"]}],"whyItMatters":"","background":"","impactChain":["","",""],"affectedParties":["",""],"uncertainties":"","glossary":[{"term":"","definition":""}],"trend":{"nearTerm":{"condition":"如果……","outlook":"可能……"},"mediumTerm":{"condition":"若……","outlook":"可能……"},"signalsToWatch":["",""]},"tags":[""]}]}`
}

function pipelineMetrics(briefing: DailyBriefing, retries: number) {
  const counts = new Map<string, number>()
  for (const story of briefing.stories) counts.set(story.source.name, (counts.get(story.source.name) ?? 0) + 1)
  return {
    ...briefing.pipeline,
    articleFetchSuccess: briefing.stories.flatMap((story) => story.evidenceSources).filter((source) => source.materialLevel === 'full-text').length,
    confirmedCount: briefing.stories.filter((story) => story.evidence.level === 'confirmed').length,
    corroboratedCount: briefing.stories.filter((story) => story.evidence.level === 'corroborated').length,
    singleSourceCount: briefing.stories.filter((story) => story.evidence.level === 'single-source').length,
    unverifiedCount: briefing.stories.filter((story) => story.evidence.level === 'unverified').length,
    primarySourceCount: briefing.stories.filter((story) => story.evidence.primarySourcePresent).length,
    maxSourceConcentration: Math.max(0, ...counts.values()),
    qwenRetries: retries,
  }
}

function normalizeRanking(briefing: DailyBriefing) {
  const eligible = briefing.stories.filter((story) =>
    story.evidence.level !== 'unverified'
    && !(story.source.reliability === 'other' && story.evidence.level === 'single-source'))
  const restricted = briefing.stories.filter((story) => !eligible.includes(story))
  return {
    ...briefing,
    stories: [...eligible, ...restricted].map((story, index) => ({ ...story, rank: index + 1 })),
  }
}

export async function finalizeBriefing(
  collection: CollectionResult,
  events: NewsEvent[],
  model: EditorialModel | null,
  now = new Date(),
) {
  const fallbackEvents = fallbackPreselection(events).slice(0, 5)
  const fallback = buildRulesBriefing(selectedCollection(collection, events), now, fallbackEvents.map((event) => event.id))
  if (!model) return {
    ...fallback,
    pipeline: {
      ...pipelineMetrics(fallback, 0),
      qualityStatus: 'degraded' as const,
      warnings: [...fallback.pipeline.warnings, '未配置 Qwen；这是 RSS/规则降级稿，不作为正常深度简报发布'],
    },
  }

  let previous: unknown
  let lastErrors = ['初次生成失败']
  let current: DailyBriefing | null = null
  let modelCalls = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      modelCalls += 1
      const value = await model.complete(finalPrompt(collection, events, attempt ? { errors: lastErrors, previous } : undefined), 14_000)
      previous = value
      const rawStories = (value as Partial<ModelBriefing>)?.stories
      const ids = Array.isArray(rawStories)
        ? rawStories.map((story) => story?.id).filter((id): id is string => typeof id === 'string')
        : []
      if (ids.length !== 5 || new Set(ids).size !== 5 || ids.some((id) => !events.some((event) => event.id === id))) {
        lastErrors = ['Qwen 返回非法事件 ID、重复 ID 或不是正好 5 条']
        continue
      }
      const baseline = buildRulesBriefing(selectedCollection(collection, events), now, ids)
      const merged = normalizeRanking(mergeModelBriefing(baseline, value, events))
      lastErrors = validateBriefing(merged, events)
      if (lastErrors.length) {
        const globalErrors = lastErrors.filter((error) => !contentError(error, events))
        if (globalErrors.length && attempt === 0) {
          previous = value
          continue
        }
        current = merged
        break
      }
      return {
        ...merged,
        pipeline: {
          ...pipelineMetrics(merged, Math.max(0, modelCalls - 1)),
          qualityStatus: 'passed' as const,
          warnings: [...merged.pipeline.warnings, ...(attempt ? ['Qwen 初稿未通过门禁，已修复一次并通过'] : [])],
        },
      }
    } catch (error) {
      lastErrors = [error instanceof Error ? error.message : String(error)]
    }
  }

  if (current) {
    const affectedIds = storyIdsFromErrors(lastErrors, events)
    if (affectedIds.length) {
      try {
        modelCalls += 1
        const patch = await model.complete(storyRepairPrompt(collection, current, events, affectedIds, lastErrors), 8_000)
        const repaired = normalizeRanking(mergeModelBriefing(current, patch, events))
        lastErrors = validateBriefing(repaired, events)
        current = repaired
        if (!lastErrors.length) {
          return {
            ...repaired,
            pipeline: {
              ...pipelineMetrics(repaired, Math.max(0, modelCalls - 1)),
              qualityStatus: 'passed' as const,
              warnings: [...repaired.pipeline.warnings, 'Qwen 初稿存在单条问题，已定向修复并通过门禁'],
            },
          }
        }
      } catch (error) {
        lastErrors = [...lastErrors, `定向修复调用失败：${error instanceof Error ? error.message : String(error)}`]
      }
    }

    const brokenId = storyIdsFromErrors(lastErrors, events)[0]
    if (brokenId) {
      const replacementErrors = [...lastErrors]
      const selectedIds = new Set(current.stories.map((story) => story.id))
      const alternatives = events.filter((event) => !selectedIds.has(event.id))
      for (const alternative of alternatives.slice(0, 2)) {
        const trial = replacementBaseline(collection, current, events, brokenId, alternative, now)
        const selectionErrors = validateBriefing(trial, events).filter((error) => !contentError(error, events))
        if (selectionErrors.length) continue
        try {
          modelCalls += 1
          const patch = await model.complete(replacementPrompt(collection, brokenId, alternative, replacementErrors), 6_000)
          const repaired = normalizeRanking(mergeModelBriefing(trial, patch, events))
          lastErrors = validateBriefing(repaired, events)
          if (!lastErrors.length) {
            return {
              ...repaired,
              pipeline: {
                ...pipelineMetrics(repaired, Math.max(0, modelCalls - 1)),
                qualityStatus: 'passed' as const,
                warnings: [...repaired.pipeline.warnings, `事件 ${brokenId} 修复失败，已由合格候选 ${alternative.id} 替换`],
              },
            }
          }
        } catch (error) {
          lastErrors = [...lastErrors, `替补编辑调用失败：${error instanceof Error ? error.message : String(error)}`]
        }
      }
    }
  }
  return {
    ...fallback,
    pipeline: {
      ...pipelineMetrics(fallback, Math.max(0, modelCalls - 1)),
      qualityStatus: 'degraded' as const,
      warnings: [...fallback.pipeline.warnings, `Qwen 最终稿修复后仍未通过：${lastErrors.join('；')}；已生成明确标记的规则降级稿`],
    },
  }
}

export async function buildBriefing(collection: CollectionResult, now = new Date()): Promise<DailyBriefing> {
  const model = createEditorialModelFromEnvironment()
  const preselection = await preselectEvents(collection, model)
  const briefing = await finalizeBriefing(collection, preselection.events, model, now)
  return {
    ...briefing,
    pipeline: { ...briefing.pipeline, warnings: [...briefing.pipeline.warnings, ...preselection.warnings] },
  }
}
