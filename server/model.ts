import type {
  BriefingStory,
  DailyBriefing,
  GlossaryTerm,
  StoryTrend,
  TrendRadarItem,
} from '../shared/briefing.js'
import { DOMAIN_CONFIGS } from './sources.js'
import type { CollectionResult, NewsEvent } from './pipeline.js'
import {
  buildCandidatePool,
  buildEventSpecificContent,
  buildRuleStory,
  buildRulesBriefing,
  assessEventForPreselection,
  claimMatchesEvent,
  cleanEventMaterial,
  eventFingerprint,
  eventDomainFit,
  fingerprintConflicts,
  fingerprintText,
  extractActions,
  extractDates,
  extractEntities,
  extractEventObjects,
  extractKeyNumbers,
  hasConcreteActorAndAction,
  hasHtmlArtifact,
  hasInformativeSummary,
  hasMeaninglessEnglishFragment,
  isPlaceholderSummary,
  isPlaceholderTitle,
  keyNumbersCompatible,
  supportingUrlsForClaim,
  summaryAddsNewInformation,
} from './pipeline.js'

type ProviderConfig = {
  mode: 'qwen'
  apiKey: string
  baseUrl: string
  model: string
}

export type ModelStory = {
  id?: string
  slot?: number
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

function modelInput(events: NewsEvent[], materialLimit = 5_000, previousTitles: string[] = [], fixedSlots = false) {
  return events.map((event, eventIndex) => ({
    ...(fixedSlots ? { slot: eventIndex + 1 } : { id: event.id }),
    canonicalTitle: event.canonicalTitle,
    entities: event.entities,
    topicTags: event.topicTags,
    publishedAt: event.publishedAt,
    latestUpdateAt: event.latestUpdateAt,
    editorialScore: Math.round(event.primaryArticle.score),
    evidence: event.evidence,
    ...(fixedSlots ? { numericFactWhitelist: numericFactWhitelist(event).map(({ fact, sourceIds }) => ({ fact, sourceIds })) } : {}),
    comparedWithPrevious: previousTitles.some((title) => {
      const left = title.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      const right = event.canonicalTitle.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      return left === right || (left.length > 8 && right.includes(left.slice(0, Math.min(left.length, 16))))
    }) ? 'possible-repeat-needs-new-development' : 'new-candidate',
    articles: event.articles.map((article, index) => ({
      sourceId: articleSourceId(event, index),
      title: article.title,
      material: cleanEventMaterial(article.title, article.fullText || article.description, article.domain).slice(0, materialLimit),
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

function articleSupportsNumbers(article: NewsEvent['articles'][number], tokens: string[], sentence = tokens.join(' ')) {
  const material = `${article.title} ${cleanEventMaterial(article.title, article.description, article.domain)} ${cleanEventMaterial(article.title, article.fullText ?? '', article.domain)} ${article.publishedAt.slice(0, 10)}`
  const materialClaims = extractKeyNumbers(material)
  const tokenClaims = extractKeyNumbers(sentence)
  if (tokenClaims.length && (!materialClaims.length || !tokenClaims.every((claim) => keyNumbersCompatible([claim], materialClaims)))) return false
  const normalizedMaterial = material.replaceAll(',', '').toLocaleLowerCase()
  const rawTokens = tokenClaims.length ? [] : tokens
  if (rawTokens.length && !rawTokens.every((token) => normalizedMaterial.includes(token))) return false

  const sentenceObjects = extractEventObjects(sentence)
  const materialObjects = extractEventObjects(material)
  const indicators = new Set(['cpi', 'ppi', 'pce', 'interest-rate', 'bond-yield', 'earnings-results', 'oil-price'])
  const sentenceIndicators = new Set([...sentenceObjects].filter((item) => indicators.has(item)))
  const materialIndicators = new Set([...materialObjects].filter((item) => indicators.has(item)))
  if (sentenceIndicators.size && materialIndicators.size && ![...sentenceIndicators].some((item) => materialIndicators.has(item))) return false

  const sentenceEntities = new Set(extractEntities(sentence))
  const materialEntities = new Set(extractEntities(material))
  if (sentenceEntities.size && materialEntities.size && ![...sentenceEntities].some((item) => materialEntities.has(item))) return false

  const sentenceActions = extractActions(sentence)
  const materialActions = extractActions(material)
  if (sentenceActions.size && materialActions.size && ![...sentenceActions].some((item) => materialActions.has(item))) return false

  const sentenceDates = extractDates(sentence)
  const materialDates = extractDates(material)
  if (sentenceDates.length && materialDates.length && !sentenceDates.every((date) => materialDates.includes(date))) return false
  return tokenClaims.length > 0 || rawTokens.length > 0
}

export type NumericFactWhitelistItem = { fact: string; sourceIds: string[]; urls: string[] }

function factSentences(value: string) {
  return value.split(/(?<=[。！？.!?;；])\s*/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 320 && normalizedNumberTokens(sentence).length > 0)
}

export function numericFactWhitelist(event: NewsEvent): NumericFactWhitelistItem[] {
  const facts = new Map<string, NumericFactWhitelistItem>()
  event.articles.forEach((article, index) => {
    const sourceId = articleSourceId(event, index)
    const sentences = [
      ...factSentences(article.title),
      ...factSentences(cleanEventMaterial(article.title, article.description, article.domain)),
      ...factSentences(cleanEventMaterial(article.title, article.fullText ?? '', article.domain)),
    ]
    for (const fact of sentences) {
      const key = fact.normalize('NFKC').replace(/\s+/g, ' ').trim()
      const existing = facts.get(key)
      if (existing) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId)
        if (!existing.urls.includes(article.url)) existing.urls.push(article.url)
      } else {
        facts.set(key, { fact: key, sourceIds: [sourceId], urls: [article.url] })
      }
    }
  })
  return [...facts.values()].slice(0, 24)
}

const NUMERIC_EXPRESSION = /(?:[$€£¥￥]\s*)?\d[\d,.]*(?:\.\d+)?(?:\s*[–-]\s*\d[\d,.]*(?:\.\d+)?)?\s*(?:%|percent|percentage points?|basis points?|bps|trillion|billion|million|tn|bn|mn|亿美元|亿元|万亿元|万亿|万吨|gw|mw|级|人|家|所|年|月|日)?/giu

function numericExpressions(value: string) {
  return [...value.matchAll(NUMERIC_EXPRESSION)].map((match) => ({ raw: match[0].trim(), index: match.index ?? 0 }))
}

function supportingArticlesForText(value: string, event: NewsEvent, articles = event.articles) {
  const tokens = normalizedNumberTokens(value)
  if (!tokens.length) return articles
  return articles.filter((article) => articleSupportsNumbers(article, tokens, value))
}

function articleSupportsNumericExpression(article: NewsEvent['articles'][number], expression: string, context: string) {
  if (!articleSupportsNumbers(article, normalizedNumberTokens(expression), expression)) return false
  const material = `${article.title} ${article.description} ${article.fullText ?? ''}`
  const contextObjects = extractEventObjects(context)
  const materialObjects = extractEventObjects(material)
  const indicators = new Set(['cpi', 'ppi', 'pce', 'interest-rate', 'bond-yield', 'earnings-results', 'oil-price'])
  const contextIndicators = new Set([...contextObjects].filter((item) => indicators.has(item)))
  const materialIndicators = new Set([...materialObjects].filter((item) => indicators.has(item)))
  if (contextIndicators.size && materialIndicators.size && ![...contextIndicators].some((item) => materialIndicators.has(item))) return false
  const contextEntities = new Set(extractEntities(context))
  const materialEntities = new Set(extractEntities(material))
  if (contextEntities.size && materialEntities.size && ![...contextEntities].some((item) => materialEntities.has(item))) return false
  const contextActions = extractActions(context)
  const materialActions = extractActions(material)
  if (contextActions.size && materialActions.size && ![...contextActions].some((item) => materialActions.has(item))) return false
  const contextDates = extractDates(context)
  const materialDates = extractDates(material)
  if (contextDates.length && materialDates.length && !contextDates.every((date) => materialDates.includes(date))) return false
  return true
}

function removeUnsupportedNumericExpressions(value: string, event: NewsEvent, articles = event.articles) {
  const expressions = numericExpressions(value)
  if (!expressions.length) return value.trim()
  let output = value
  for (const expression of [...expressions].reverse()) {
    if (articles.some((article) => articleSupportsNumericExpression(article, expression.raw, value))) continue
    output = `${output.slice(0, expression.index)}${output.slice(expression.index + expression.raw.length)}`
  }
  return output
    .replace(/(?:约|超过|近|逾|达到|增至|升至|降至|为)\s*(?=[，。；、]|$)/gu, '')
    .replace(/(?:筹集|募集|融资|投资)\s*(?=建设|扩建|扩产|推进|用于)/gu, (action) => `${action}资金并`)
    .replace(/(?:预计[^，。；]{0,24})?(?:减少|增加|达到|高达|造成约?|约|近|超过)\s*(?:万?人|亿?欧元|亿美元|亿元|万亿元|经济损失)(?=[，。；]|$)/gu, '')
    .replace(/增长\s*(?=[，。；]|$)/gu, '出现增长')
    .replace(/下降\s*(?=[，。；]|$)/gu, '出现下降')
    .replace(/\(\s*\)|（\s*）/gu, '')
    .replace(/\s+([，。；！？])/gu, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[，；、]{2,}/gu, '，')
    .trim()
}

function sanitizeNumericText(value: string, event: NewsEvent, fallback: string) {
  if (!normalizedNumberTokens(value).length) return value.trim()
  const sentences = value.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean)
  const repaired = sentences.map((sentence) => removeUnsupportedNumericExpressions(sentence, event)).filter((sentence) => {
    const meaningful = sentence.replace(/[\s\p{P}\p{S}]/gu, '')
    return meaningful.length >= 6
  })
  return repaired.join('').trim() || fallback
}

export function sanitizeModelFacts(event: NewsEvent, facts: string[], incomingSources: unknown) {
  const resolvedIncoming = resolveFactSources(incomingSources, event, facts)
  const incomingByIndex = new Map(resolvedIncoming.map((item) => [item.factIndex, item.urls]))
  const keyFacts: string[] = []
  const factSources: Array<{ factIndex: number; urls: string[] }> = []
  facts.slice(0, 4).forEach((fact, originalIndex) => {
    const normalized = fact.normalize('NFKC').replace(/\s+/g, ' ').trim()
    const incomingUrls = incomingByIndex.get(originalIndex) ?? []
    const linkedArticles = incomingUrls.length ? event.articles.filter((article) => incomingUrls.includes(article.url)) : event.articles
    const safeFact = removeUnsupportedNumericExpressions(normalized, event, linkedArticles)
    if (!safeFact || keyFacts.includes(safeFact)) return
    const numericMatches = supportingArticlesForText(safeFact, event, event.articles)
    const claimMatches = supportingUrlsForClaim(event, safeFact)
    const actualSupportingUrls = numericMatches.length
      ? numericMatches.map((article) => article.url)
      : claimMatches
    const incomingSupported = incomingUrls.filter((url) => actualSupportingUrls.includes(url))
    const urls = incomingSupported.length ? incomingSupported
      : actualSupportingUrls.length ? actualSupportingUrls.slice(0, 2)
        : []
    if (!urls.length) return
    const factIndex = keyFacts.length
    keyFacts.push(safeFact)
    factSources.push({ factIndex, urls: [...new Set(urls)].filter(Boolean) })
  })
  if (!keyFacts.length) {
    const specific = buildEventSpecificContent(event)
    return {
      keyFacts: specific.keyFacts,
      factSources: specific.factSources,
    }
  }
  return { keyFacts, factSources }
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
    const matches = event.articles.filter((article) => articleSupportsNumbers(article, tokens, fact))
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
    const allLegalIds = ids.filter((id) => poolById.has(id))
    const legalIds = allLegalIds.slice(0, 10)
    if (!legalIds.length) throw new Error('Qwen 预选未返回任何合法 ID')
    const reasons = Object.fromEntries((value.selections ?? []).flatMap((item) =>
      typeof item.id === 'string' && poolById.has(item.id) && typeof item.reason === 'string' ? [[item.id, item.reason]] : [],
    ))
    const invalidCount = ids.length - allLegalIds.length
    const overflowCount = Math.max(0, allLegalIds.length - legalIds.length)
    const selected = feasiblePreselection(legalIds.map((id) => poolById.get(id)!), pool)
    const warnings = invalidCount || overflowCount || legalIds.length < Math.min(7, pool.length)
      ? [`Qwen 预选保留 ${legalIds.length} 个合法 ID，忽略 ${invalidCount} 个非法 ID${overflowCount ? `，截去 ${overflowCount} 个超额合法 ID` : ''}，并由规则补足到 ${selected.length} 个事件`]
      : []
    return { events: selected, reasons, usedModel: true, warnings }
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
  const analysis = value && typeof value === 'object' ? value as Partial<ModelBriefing> : {}
  const incomingStories = Array.isArray(analysis.stories) ? analysis.stories : []
  const incomingBySlot = new Map<number, ModelStory>()
  incomingStories.forEach((story, index) => {
    if (!story || typeof story !== 'object') return
    const requested = Number.isInteger(story.slot) ? Number(story.slot) : index + 1
    if (requested >= 1 && requested <= baseline.stories.length && !incomingBySlot.has(requested)) incomingBySlot.set(requested, story)
  })
  const eventById = new Map(events.map((event) => [event.id, event]))
  const safeGlobal = (value: unknown, fallback: string) => {
    const preferred = preferredString(value, fallback)
    if (!normalizedNumberTokens(preferred).length) return preferred
    return events.some((event) => numericFactWhitelist(event).some((item) => item.fact === preferred)) ? preferred : fallback
  }
  const stories = baseline.stories.map((story, index) => {
    const incoming = incomingBySlot.get(index + 1)
    if (!incoming) return story
    const event = eventById.get(story.id)
    if (!event) return story
    const hasIncomingKeyFacts = stringArray(incoming.keyFacts)
    const sanitizedFacts = hasIncomingKeyFacts
      ? sanitizeModelFacts(event, incoming.keyFacts, incoming.factSources)
      : { keyFacts: story.keyFacts, factSources: story.factSources }
    const specific = buildEventSpecificContent(event)
    const safeArray = (value: unknown, minimum: number, fallback: string[]) => stringArray(value, minimum)
      ? value.slice(0, 5).map((item, itemIndex) => sanitizeNumericText(item, event, fallback[itemIndex] ?? fallback[0] ?? specific.summary))
      : fallback
    const trend = normalizeTrend(incoming.trend, story.trend, event)
    const mergedStory = {
      ...story,
      title: sanitizeNumericText(preferredString(incoming.title, story.title), event, story.title),
      summary: sanitizeNumericText(preferredString(incoming.summary, story.summary), event, story.summary),
      keyFacts: sanitizedFacts.keyFacts,
      factSources: sanitizedFacts.factSources,
      whyItMatters: sanitizeNumericText(preferredString(incoming.whyItMatters, story.whyItMatters), event, story.whyItMatters),
      background: sanitizeNumericText(preferredString(incoming.background, story.background), event, story.background),
      impactChain: safeArray(incoming.impactChain, 3, story.impactChain),
      affectedParties: safeArray(incoming.affectedParties, 2, story.affectedParties).slice(0, 4),
      uncertainties: sanitizeNumericText(preferredString(incoming.uncertainties, story.uncertainties), event, story.uncertainties),
      glossary: validGlossary(incoming.glossary) ? incoming.glossary.slice(0, 4).map((item) => ({
        term: sanitizeNumericText(item.term, event, '相关概念'),
        definition: sanitizeNumericText(item.definition, event, '该概念的具体量化口径以来源材料为准。'),
      })) : story.glossary,
      trend: {
        nearTerm: sanitizeNumericText(trend.nearTerm, event, story.trend.nearTerm),
        mediumTerm: sanitizeNumericText(trend.mediumTerm, event, story.trend.mediumTerm),
        signalsToWatch: trend.signalsToWatch.map((signal, signalIndex) => sanitizeNumericText(signal, event, story.trend.signalsToWatch[signalIndex] ?? '后续可验证信号')),
      },
      tags: stringArray(incoming.tags) ? incoming.tags.slice(0, 3) : story.tags,
    }
    return repairStoryContentFields(mergedStory, story, event)
  })
  return {
    ...baseline,
    mode: 'qwen' as const,
    overview: safeGlobal(analysis.overview, baseline.overview),
    keyTakeaway: safeGlobal(analysis.keyTakeaway, baseline.keyTakeaway),
    logic: safeGlobal(analysis.logic, baseline.logic),
    newKnowledge: safeGlobal(analysis.newKnowledge, baseline.newKnowledge),
    outlook: safeGlobal(analysis.outlook, baseline.outlook),
    trendRadar: validRadar(analysis.trendRadar) ? analysis.trendRadar.slice(0, 4).map((item, index) => ({
      ...item,
      theme: safeGlobal(item.theme, baseline.trendRadar[index]?.theme ?? item.theme),
      reason: safeGlobal(item.reason, baseline.trendRadar[index]?.reason ?? item.reason),
    })) : baseline.trendRadar,
    watchNext: stringArray(analysis.watchNext, 3)
      ? analysis.watchNext.slice(0, 5).map((item, index) => safeGlobal(item, baseline.watchNext[index] ?? '后续公开信号'))
      : baseline.watchNext,
    stories,
  } satisfies DailyBriefing
}

function hanRatio(value: string) {
  const meaningful = value.replace(/\s|[\p{P}\p{S}\d]/gu, '')
  if (!meaningful.length) return 0
  return (meaningful.match(/[\p{Script=Han}]/gu) ?? []).length / meaningful.length
}

const BROKEN_QUANTIFIER = /(?:减少|增加|达到|高达|造成约?|约|近|超过)\s*(?:万?人|亿?欧元|亿美元|亿元|万亿元|经济损失)(?=[，。；]|$)/u

const CONDITIONAL_ANALYSIS = /如果|若|可能|或将|有望|取决于|需(?:要)?观察|在.+(?:情况下|前提下)|影响|传导|风险|机会|承压|受益/
const CONCRETE_FACT_ASSERTION = /宣布|发布|推出|收购|融资|扩建|下调|上调|袭击|死亡|签署|批准|实施|发生|公布|启动|停止|关闭|裁员|invest|launch|announce|acquire|attack|kill|approve|implement/i

function overlaps(left: string[], right: string[]) {
  return left.some((value) => right.includes(value))
}

/**
 * Analysis may legitimately connect an event to rates, supply chains or policy.
 * Only block a field when it introduces an unsupported number or asserts a
 * concrete, incompatible event involving the same or a clearly unrelated actor.
 */
export function analysisFieldHasSevereConflict(value: string, event: NewsEvent) {
  const clean = value.trim()
  if (!clean) return false
  if (normalizedNumberTokens(clean).length && !supportingArticlesForText(clean, event).length) return true
  const reference = eventFingerprint(event)
  const claim = fingerprintText(clean, event.domain)
  if (!fingerprintConflicts(reference, claim) || !CONCRETE_FACT_ASSERTION.test(clean)) return false

  const sameEntity = overlaps(reference.entities, claim.entities)
  const unrelatedEntity = reference.entities.length > 0 && claim.entities.length > 0 && !sameEntity
  const objectConflict = reference.objects.length > 0 && claim.objects.length > 0 && !overlaps(reference.objects, claim.objects)
  const actionConflict = reference.actions.length > 0 && claim.actions.length > 0 && !overlaps(reference.actions, claim.actions)
  const explicitOtherEvent = unrelatedEntity && (objectConflict || actionConflict)
  const contradictorySameActor = sameEntity && objectConflict && actionConflict
  if (!explicitOtherEvent && !contradictorySameActor) return false
  return !CONDITIONAL_ANALYSIS.test(clean)
}

export function repairStoryContentFields(story: BriefingStory, baseline: BriefingStory, event: NewsEvent): BriefingStory {
  const specific = buildEventSpecificContent(event)
  const fallbackTitle = !isPlaceholderTitle(baseline.title) && hasConcreteActorAndAction(baseline.title, event)
    ? baseline.title
    : specific.title
  const title = isPlaceholderTitle(story.title) || !hasConcreteActorAndAction(story.title, event)
    || !claimMatchesEvent(story.title, event) || hasHtmlArtifact(story.title) || hasMeaninglessEnglishFragment(story.title)
    || hanRatio(story.title) < 0.18
    ? fallbackTitle
    : story.title
  const fallbackSummary = !isPlaceholderSummary(baseline.summary) && summaryAddsNewInformation(title, baseline.summary, event)
    ? baseline.summary
    : specific.summary
  const summary = isPlaceholderSummary(story.summary) || !summaryAddsNewInformation(title, story.summary, event)
    || hasHtmlArtifact(story.summary) || hasMeaninglessEnglishFragment(story.summary) || BROKEN_QUANTIFIER.test(story.summary) || hanRatio(story.summary) < 0.32
    ? fallbackSummary
    : story.summary

  const retainedFacts: string[] = []
  const retainedSources: BriefingStory['factSources'] = []
  const allowedUrls = new Set(event.articles.map((article) => article.url))
  story.keyFacts.forEach((fact, originalIndex) => {
    if (!fact.trim() || isPlaceholderSummary(fact) || hasHtmlArtifact(fact) || hasMeaninglessEnglishFragment(fact) || !claimMatchesEvent(fact, event)) return
    const urls = story.factSources.find((link) => link.factIndex === originalIndex)?.urls ?? []
    if (!urls.length || urls.some((url) => !allowedUrls.has(url))) return
    const supportedUrls = new Set(supportingUrlsForClaim(event, fact))
    if (!urls.some((url) => supportedUrls.has(url))) return
    const numberTokens = normalizedNumberTokens(fact)
    if (numberTokens.length) {
      const linkedArticles = event.articles.filter((article) => urls.includes(article.url))
      if (!linkedArticles.some((article) => articleSupportsNumbers(article, numberTokens, fact))) return
    }
    const factIndex = retainedFacts.length
    retainedFacts.push(fact)
    retainedSources.push({ factIndex, urls })
  })
  const keyFacts = retainedFacts.length ? retainedFacts : specific.keyFacts
  const factSources = retainedFacts.length
    ? retainedSources
    : specific.factSources
  const prediction = `${story.trend.nearTerm} ${story.trend.mediumTerm}`
  const trend = CONDITIONAL_PREDICTION.test(prediction) && story.trend.signalsToWatch.length >= 2 ? story.trend : baseline.trend
  const alignedAnalysis = (value: string, fallback: string, minimumHan = 0.32) => {
    const clean = value.trim()
    if (!clean || hanRatio(clean) < minimumHan || hasHtmlArtifact(clean) || hasMeaninglessEnglishFragment(clean)) return fallback
    return analysisFieldHasSevereConflict(clean, event) ? fallback : clean
  }
  const alignedArray = (values: string[], fallback: string[]) => values.length
    && values.every((value) => !analysisFieldHasSevereConflict(value, event) && !hasHtmlArtifact(value) && !hasMeaninglessEnglishFragment(value))
    ? values
    : fallback
  return {
    ...story,
    title,
    summary,
    keyFacts,
    factSources,
    whyItMatters: alignedAnalysis(story.whyItMatters, baseline.whyItMatters),
    background: alignedAnalysis(story.background, baseline.background),
    impactChain: alignedArray(story.impactChain, baseline.impactChain),
    affectedParties: alignedArray(story.affectedParties, baseline.affectedParties),
    uncertainties: alignedAnalysis(story.uncertainties, baseline.uncertainties, 0.25),
    glossary: story.glossary.every((item) => !analysisFieldHasSevereConflict(`${item.term} ${item.definition}`, event))
      ? story.glossary : baseline.glossary,
    trend: analysisFieldHasSevereConflict(`${trend.nearTerm} ${trend.mediumTerm} ${trend.signalsToWatch.join(' ')}`, event)
      ? baseline.trend : trend,
    tags: alignedArray(story.tags, baseline.tags),
  }
}

export type ContentQualityMetrics = NonNullable<DailyBriefing['pipeline']['contentQuality']>

function storyTextFields(story: BriefingStory) {
  return [
    story.title, story.summary, ...story.keyFacts, story.whyItMatters, story.background,
    ...story.impactChain, ...story.affectedParties, story.uncertainties,
    ...story.glossary.flatMap((item) => [item.term, item.definition]),
    story.trend.nearTerm, story.trend.mediumTerm, ...story.trend.signalsToWatch, ...story.tags,
  ]
}

export function contentQualityMetrics(briefing: DailyBriefing, events: NewsEvent[]): ContentQualityMetrics {
  const byId = new Map(events.map((event) => [event.id, event]))
  const metrics: ContentQualityMetrics = {
    repeatedSummaryCount: 0,
    noNewFactSummaryCount: 0,
    titleSummaryMismatchCount: 0,
    crossEventSourceCount: 0,
    htmlArtifactCount: 0,
    englishFragmentCount: 0,
  }
  for (const story of briefing.stories) {
    const event = byId.get(story.id)
    const normalizedTitle = story.title.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')
    const normalizedSummary = story.summary.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')
    if (normalizedSummary.startsWith(normalizedTitle) || (normalizedTitle.length > 12 && normalizedSummary.includes(normalizedTitle))) {
      metrics.repeatedSummaryCount += 1
    }
    if (event) {
      if (!summaryAddsNewInformation(story.title, story.summary, event)) metrics.noNewFactSummaryCount += 1
      if (!claimMatchesEvent(story.title, event) || !claimMatchesEvent(story.summary, event)) metrics.titleSummaryMismatchCount += 1
      story.keyFacts.forEach((fact, factIndex) => {
        const linked = story.factSources.find((item) => item.factIndex === factIndex)?.urls ?? []
        const supported = new Set(supportingUrlsForClaim(event, fact))
        if (!linked.length || !linked.some((url) => supported.has(url))) metrics.crossEventSourceCount += 1
      })
    } else {
      metrics.titleSummaryMismatchCount += 1
    }
    const fields = storyTextFields(story)
    metrics.htmlArtifactCount += fields.filter(hasHtmlArtifact).length
    metrics.englishFragmentCount += fields.filter(hasMeaninglessEnglishFragment).length
  }
  return metrics
}

export function validateBriefingStory(story: BriefingStory, event?: NewsEvent) {
  const errors: string[] = []
  if (hanRatio(story.title) < 0.18 || hanRatio(`${story.summary}${story.whyItMatters}${story.background}`) < 0.45) errors.push(`${story.id} 不是自然完整中文`)
  if (isPlaceholderTitle(story.title)) errors.push(`${story.id} 使用占位模板标题`)
  if (isPlaceholderSummary(story.summary)) errors.push(`${story.id} 使用占位模板摘要`)
  if (event && !hasConcreteActorAndAction(story.title, event)) errors.push(`${story.id} 标题未说明具体主体与动作`)
  if (event && !hasInformativeSummary(story.summary, event, story.title)) errors.push(`${story.id} 摘要没有标题之外的来源支持信息`)
  if (event && (!claimMatchesEvent(story.title, event) || !claimMatchesEvent(story.summary, event))) errors.push(`${story.id} 标题与摘要不属于同一事件`)
  if (event) {
    const analyticalFields = [
      story.whyItMatters, story.background, ...story.impactChain, ...story.affectedParties, story.uncertainties,
      ...story.glossary.flatMap((item) => [item.term, item.definition]),
      story.trend.nearTerm, story.trend.mediumTerm, ...story.trend.signalsToWatch,
    ]
    if (analyticalFields.some((value) => analysisFieldHasSevereConflict(value, event))) {
      errors.push(`${story.id} 分析字段包含明确冲突事实或无来源数字`)
    }
  }
  if (storyTextFields(story).some(hasHtmlArtifact)) errors.push(`${story.id} 含有 HTML 或乱码残片`)
  if (storyTextFields(story).some(hasMeaninglessEnglishFragment)) errors.push(`${story.id} 含有无意义英文残句`)
  if (storyTextFields(story).some((value) => BROKEN_QUANTIFIER.test(value))) errors.push(`${story.id} 含有数字删除后的残缺量词`)
  if (story.keyFacts.some((fact) => isPlaceholderSummary(fact))) errors.push(`${story.id} 关键事实包含占位文案`)
  const allowedUrls = new Set(event?.articles.map((article) => article.url) ?? [])
  story.keyFacts.forEach((fact, factIndex) => {
    const links = story.factSources.find((link) => link.factIndex === factIndex)?.urls ?? []
    const numberTokens = normalizedNumberTokens(fact)
    if (!links.length || links.some((url) => !allowedUrls.has(url))) {
      errors.push(`${story.id} 的${numberTokens.length ? '数字事实' : '关键事实'} ${factIndex} 未关联候选来源`)
      return
    }
    const supportedUrls = new Set(event ? supportingUrlsForClaim(event, fact) : [])
    if (!links.some((url) => supportedUrls.has(url))) {
      errors.push(`${story.id} 的关键事实 ${factIndex} 与关联来源不是同一事件`)
      return
    }
    if (numberTokens.length) {
      const linkedArticles = event?.articles.filter((article) => links.includes(article.url)) ?? []
      if (!linkedArticles.some((article) => articleSupportsNumbers(article, numberTokens, fact))) {
        errors.push(`${story.id} 的数字事实 ${factIndex} 未被关联来源材料支持`)
      }
    }
  })
  const prediction = `${story.trend.nearTerm} ${story.trend.mediumTerm}`
  if (!CONDITIONAL_PREDICTION.test(prediction) || story.trend.signalsToWatch.length < 2) {
    errors.push(`${story.id} 的预测缺少条件表达或验证信号`)
  }
  return [...new Set(errors)]
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
    errors.push(...validateBriefingStory(story, event))
  }
  if ([...sourceCounts.values()].some((count) => count > 2)) errors.push('同一主来源超过 2 条')
  if (sourceCounts.size < 3) errors.push('主来源少于 3 个')
  if (briefing.stories.filter((story) => story.source.reliability === 'other').length > 1) errors.push('other 来源超过 1 条')
  const unverified = briefing.stories.filter((story) => story.evidence.level === 'unverified')
  if (unverified.length > 1 || briefing.stories.slice(0, 3).some((story) => story.evidence.level === 'unverified')) errors.push('unverified 数量或排名不合规')
  const first = briefing.stories[0]
  if (first?.source.reliability === 'other' && first.evidence.level === 'single-source') errors.push('第一名不能是 other + single-source')
  if ([...entityCounts.values()].some((count) => count > 2)) errors.push('同一公司或狭窄子话题超过 2 条')
  const contentMetrics = contentQualityMetrics(briefing, events)
  if (contentMetrics.repeatedSummaryCount) errors.push(`摘要重复标题 ${contentMetrics.repeatedSummaryCount} 条`)
  if (contentMetrics.noNewFactSummaryCount) errors.push(`摘要无新增事实 ${contentMetrics.noNewFactSummaryCount} 条`)
  if (contentMetrics.titleSummaryMismatchCount) errors.push(`标题摘要错配 ${contentMetrics.titleSummaryMismatchCount} 条`)
  if (contentMetrics.crossEventSourceCount) errors.push(`跨事件来源 ${contentMetrics.crossEventSourceCount} 条`)
  if (contentMetrics.htmlArtifactCount) errors.push(`HTML 残片 ${contentMetrics.htmlArtifactCount} 处`)
  if (contentMetrics.englishFragmentCount) errors.push(`英文残句 ${contentMetrics.englishFragmentCount} 处`)
  return [...new Set(errors)]
}

function selectedCollection(collection: CollectionResult, events: NewsEvent[]): CollectionResult {
  return { ...collection, candidates: events.flatMap((event) => event.articles) }
}

export function selectFixedSlotEvents(events: NewsEvent[]) {
  const ordered = [
    ...events.filter((event) => event.evidence.level !== 'unverified'),
    ...events.filter((event) => event.evidence.level === 'unverified'),
  ]
  const search = (
    start: number,
    selected: NewsEvent[],
    sourceCounts: Map<string, number>,
    entityCounts: Map<string, number>,
    otherCount: number,
    unverifiedCount: number,
  ): NewsEvent[] | null => {
    if (selected.length === 5) return sourceCounts.size >= 3 ? selected : null
    if (ordered.length - start < 5 - selected.length) return null
    for (let index = start; index < ordered.length; index += 1) {
      const event = ordered[index]
      const sourceId = event.primaryArticle.source.id
      const narrow = event.entities[0] ?? event.topicTags[0] ?? event.id
      const isOther = event.primaryArticle.source.reliability === 'other'
      const isUnverified = event.evidence.level === 'unverified'
      if ((sourceCounts.get(sourceId) ?? 0) >= 2 || (entityCounts.get(narrow) ?? 0) >= 2) continue
      if (isOther && otherCount >= 1) continue
      if (isUnverified && (unverifiedCount >= 1 || selected.length < 3)) continue
      if (!selected.length && isOther && event.evidence.level === 'single-source') continue
      const nextSources = new Map(sourceCounts).set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1)
      const nextEntities = new Map(entityCounts).set(narrow, (entityCounts.get(narrow) ?? 0) + 1)
      const result = search(index + 1, [...selected, event], nextSources, nextEntities, otherCount + Number(isOther), unverifiedCount + Number(isUnverified))
      if (result) return result
    }
    return null
  }
  return search(0, [], new Map(), new Map(), 0, 0) ?? fallbackPreselection(events).slice(0, 5)
}

const USER_TOPIC_PRIORITY: Record<NewsEvent['domain'], RegExp> = {
  'ai-tech': /AI基础设施|人工智能基础设施|芯片|半导体|服务器|HBM|高带宽内存|先进封装|AI\s*Coding|编程智能体|Agent|算力/i,
  markets: /公司基本面|财报|营收|利润|通胀|CPI|PPI|PCE|利率|债券收益率|油价|投资|融资/i,
  world: /能源|航运|海峡|粮食|地缘|冲突|停火|制裁|科技安全|出口管制|供应链/i,
  learning: /\bIB\b|International Baccalaureate|\bOECD\b|\bPISA\b|\bUNESCO\b|AI Literacy|人工智能素养|AI素养|学习科学|Assessment|评估|课程改革|教育政策/i,
}
const LOW_VALUE_TOPIC = /celebrity|viral|shocking|奇闻|网红|明星八卦|普通校园活动|校友聚会|校长任命|school board meeting|campus event/i

function backupPriority(event: NewsEvent, domain: NewsEvent['domain'], _originalIndex: number) {
  const material = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const priorityMatches = material.match(new RegExp(USER_TOPIC_PRIORITY[domain].source, 'gi'))?.length ?? 0
  const reliability = event.primaryArticle.source.reliability === 'primary' ? 5
    : event.primaryArticle.source.reliability === 'tier-1' ? 3 : 0
  const officialLearning = domain === 'learning' && event.primaryArticle.source.type === 'official' ? 5 : 0
  return event.primaryArticle.score + eventDomainFit(event, domain) * 0.25
    + Math.min(priorityMatches, 4) * 4 + reliability + officialLearning
    - (LOW_VALUE_TOPIC.test(material) ? 18 : 0)
}

export type BriefingReplacement = {
  removedEventId: string
  addedEventId: string
  reason: 'content-gate' | 'cross-domain-duplicate'
}

type StoryOption = {
  event: NewsEvent
  story: BriefingStory
  originalRank: number | null
  preservesQwenStory: boolean
  priority: number
}

function combinations<T>(items: T[], size: number) {
  const result: T[][] = []
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push(selected)
      return
    }
    for (let index = start; index <= items.length - (size - selected.length); index += 1) {
      visit(index + 1, [...selected, items[index]])
    }
  }
  visit(0, [])
  return result
}

export function stabilizeBriefingWithBackups(
  collection: CollectionResult,
  briefing: DailyBriefing,
  events: NewsEvent[],
  now = new Date(),
  forcedRejectIds: string[] = [],
) {
  const eventById = new Map(events.map((event) => [event.id, event]))
  const forced = new Set(forcedRejectIds)
  const originalById = new Map(briefing.stories.map((story) => [story.id, story]))
  const options: StoryOption[] = events.flatMap((event, index) => {
    if (forced.has(event.id) || !assessEventForPreselection(event, collection.domain).accepted) return []
    const original = originalById.get(event.id)
    const originalValid = Boolean(original && !validateBriefingStory(original, event).length)
    const baseline = buildRuleStory(event, original?.rank ?? 99)
    const story = originalValid ? original!
      : original ? repairStoryContentFields(original, baseline, event)
        : baseline
    if (validateBriefingStory(story, event).length) return []
    return [{
      event,
      story,
      originalRank: original?.rank ?? null,
      preservesQwenStory: Boolean(original),
      priority: backupPriority(event, collection.domain, index),
    }]
  }).sort((left, right) => {
    const preserved = Number(right.preservesQwenStory) - Number(left.preservesQwenStory)
    if (preserved) return preserved
    const original = Number(right.originalRank !== null) - Number(left.originalRank !== null)
    if (original) return original
    if (left.originalRank !== null && right.originalRank !== null) return left.originalRank - right.originalRank
    return right.priority - left.priority || left.event.id.localeCompare(right.event.id)
  })

  let best: { briefing: DailyBriefing; events: NewsEvent[]; errors: string[]; score: number; key: string } | null = null
  let consideredCombinations = 0
  for (const chosen of combinations(options, 5)) {
    consideredCombinations += 1
    const ordered = [...chosen].sort((left, right) => {
      const leftRank = left.originalRank ?? Number.POSITIVE_INFINITY
      const rightRank = right.originalRank ?? Number.POSITIVE_INFINITY
      return leftRank - rightRank || right.priority - left.priority || left.event.id.localeCompare(right.event.id)
    })
    const trial = normalizeRanking({ ...briefing, stories: ordered.map((option) => option.story) })
    const trialEvents = trial.stories.map((story) => eventById.get(story.id)!).filter(Boolean)
    const errors = validateBriefing(trial, trialEvents)
    const score = ordered.reduce((total, option) => total
      + Number(option.preservesQwenStory) * 1_000_000
      + Number(option.originalRank !== null) * 100_000
      + option.priority, 0)
    const key = trial.stories.map((story) => story.id).join('|')
    if (!best || errors.length < best.errors.length
      || (errors.length === best.errors.length && (score > best.score || (score === best.score && key < best.key)))) {
      best = { briefing: trial, events: trialEvents, errors, score, key }
    }
  }

  const current = best?.briefing ?? briefing
  const currentEvents = best?.events ?? briefing.stories.map((story) => eventById.get(story.id)).filter((event): event is NewsEvent => Boolean(event))
  const errors = best?.errors ?? validateBriefing(current, currentEvents)
  const finalIds = new Set(current.stories.map((story) => story.id))
  const removed = briefing.stories.filter((story) => !finalIds.has(story.id))
  const added = current.stories.filter((story) => !originalById.has(story.id))
  const replacements: BriefingReplacement[] = removed.map((story, index) => ({
    removedEventId: story.id,
    addedEventId: added[index]?.id ?? added.at(-1)?.id ?? '',
    reason: forced.has(story.id) ? 'cross-domain-duplicate' as const : 'content-gate' as const,
  })).filter((item) => item.addedEventId)
  const unresolvedRejectIds = forcedRejectIds.filter((id) => finalIds.has(id) || !best || best.errors.length > 0)
  const replacementWarnings = replacements.map((item) =>
    `${item.reason === 'content-gate' ? '内容门禁' : '跨领域去重'}已将 ${item.removedEventId} 替换为备用事件 ${item.addedEventId}`)
  return {
    briefing: {
      ...current,
      pipeline: {
        ...pipelineMetrics(current, current.pipeline.qwenRetries ?? 0, currentEvents),
        qualityStatus: errors.length ? current.pipeline.qualityStatus : 'passed' as const,
        warnings: [...current.pipeline.warnings, ...replacementWarnings],
      },
    },
    selectedEvents: currentEvents,
    replacements,
    errors,
    unresolvedRejectIds,
    consideredCombinations,
    eligibleOptionIds: options.map((option) => option.event.id),
  }
}

function finalPrompt(collection: CollectionResult, events: NewsEvent[]) {
  const config = DOMAIN_CONFIGS[collection.domain]
  return `你是 DailyNews 的中文深度简报主编，当前领域是“${config.title}”。程序已经确定并排序了 5 个事件槽位。请逐槽写作，不得选择、删除、交换或自行生成事件 ID。

硬规则：严格按 slot 1–5 返回且每个 slot 仅一次；不要输出 id。标题与正文使用自然克制中文。
事实规则：每个数字都必须能在该槽位 numericFactWhitelist 或 articles 中按“主体、指标、数值、单位、时间、来源”对应；允许等值货币单位转换、百分比与合理舍入，不得把不同指标拼接。无法确认的数字只删去对应数字或句子，绝不能把整条新闻改成套话。非数字事实只能来自 articles。每条 keyFacts 都要用 factSources 关联已有 sourceId；不要复制或编造 URL。不得把分析写成事实。
内容规则：每个标题必须明确“谁做了什么”，并包含动作对象或结果；摘要必须写出 1–2 个来源直接支持的具体变化。禁止“来源/公司＋发布＋主题＋相关更新”，也禁止“来源材料发布了相关新信息”“这里只保留定性结论”“具体细节以来源为准”等占位文案。英文材料要写成具体中文，不得退化成来源名模板。
预测规则：nearTerm 和 mediumTerm 分别输出 condition 与 outlook；condition 说明成立条件，outlook 只写条件成立时可能发生的结果。另给 2–4 个可验证 signalsToWatch。
深度：summary 80–150 字；keyFacts 2–4 条；whyItMatters 80–150 字；background 100–180 字；impactChain 3–5 节点；affectedParties 2–4 条；uncertainties 明确信息边界；glossary 1–4 个。领域 overview/logic/newKnowledge/outlook 各 100–200 字，keyTakeaway 50–100 字。
只输出 JSON：
{"overview":"","keyTakeaway":"","logic":"","newKnowledge":"","outlook":"","trendRadar":[{"theme":"","direction":"↑↑|↑|→|↓|高波动","reason":""}],"watchNext":[""],"stories":[{"slot":1,"title":"","summary":"","keyFacts":["",""],"factSources":[{"factIndex":0,"sourceIds":[""]}],"whyItMatters":"","background":"","impactChain":["","", ""],"affectedParties":["",""],"uncertainties":"","glossary":[{"term":"","definition":""}],"trend":{"nearTerm":{"condition":"如果……","outlook":"可能……"},"mediumTerm":{"condition":"若……","outlook":"可能……"},"signalsToWatch":["",""]},"tags":[""]}]}
固定槽位：${JSON.stringify(modelInput(events, 5_000, collection.previousTitles ?? [], true))}`
}

function pipelineMetrics(briefing: DailyBriefing, retries: number, events: NewsEvent[]) {
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
    contentQuality: contentQualityMetrics(briefing, events),
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
  const slotEvents = selectFixedSlotEvents(events)
  const fallback = buildRulesBriefing(selectedCollection(collection, slotEvents), now, slotEvents.map((event) => event.id))
  if (!model) return {
    ...fallback,
    pipeline: {
      ...pipelineMetrics(fallback, 0, slotEvents),
      qualityStatus: 'degraded' as const,
      warnings: [...fallback.pipeline.warnings, '未配置 Qwen；这是 RSS/规则降级稿，不作为正常深度简报发布'],
    },
  }

  let lastErrors = ['Qwen 未返回可用内容']
  let modelCalls = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      modelCalls += 1
      const value = await model.complete(finalPrompt(collection, slotEvents), 14_000)
      const merged = normalizeRanking(mergeModelBriefing(fallback, value, slotEvents))
      lastErrors = validateBriefing(merged, slotEvents)
      if (lastErrors.length) {
        const fallbackById = new Map(fallback.stories.map((story) => [story.id, story]))
        const eventById = new Map(slotEvents.map((event) => [event.id, event]))
        const locallyRepaired = normalizeRanking({
          ...merged,
          stories: merged.stories.map((story) => {
            const event = eventById.get(story.id)
            const baselineStory = fallbackById.get(story.id)
            return event && baselineStory ? repairStoryContentFields(story, baselineStory, event) : story
          }),
        })
        const repairedErrors = validateBriefing(locallyRepaired, slotEvents)
        if (!repairedErrors.length) {
          return {
            ...locallyRepaired,
            pipeline: {
              ...pipelineMetrics(locallyRepaired, Math.max(0, modelCalls - 1), slotEvents),
              qualityStatus: 'passed' as const,
              warnings: [...locallyRepaired.pipeline.warnings, '程序已逐字段修复未通过事实或语言门禁的内容，保留其余合格字段'],
            },
          }
        }
        const stabilized = stabilizeBriefingWithBackups(collection, locallyRepaired, events, now)
        if (!stabilized.errors.length) {
          const stableBriefing = stabilized.briefing
          return {
            ...stableBriefing,
            pipeline: {
              ...pipelineMetrics(stableBriefing, Math.max(0, modelCalls - 1), stabilized.selectedEvents),
              qualityStatus: 'passed' as const,
              warnings: [
                ...stableBriefing.pipeline.warnings,
                `程序保留合格成稿字段，并通过整体组合选择修复不合格槽位（检查 ${stabilized.consideredCombinations} 种组合）`,
              ],
            },
          }
        }
        lastErrors = stabilized.errors.length ? stabilized.errors : repairedErrors
      } else {
        return {
          ...merged,
          pipeline: {
            ...pipelineMetrics(merged, Math.max(0, modelCalls - 1), slotEvents),
            qualityStatus: 'passed' as const,
            warnings: merged.pipeline.warnings,
          },
        }
      }

      const fallbackErrors = validateBriefing(fallback, slotEvents)
      if (!fallbackErrors.length) {
        return {
          ...fallback,
          mode: 'qwen' as const,
          pipeline: {
            ...pipelineMetrics(fallback, Math.max(0, modelCalls - 1), slotEvents),
            qualityStatus: 'passed' as const,
            warnings: [...fallback.pipeline.warnings, `Qwen 内容未通过门禁，程序已按固定槽位逐条回退：${lastErrors.join('；')}`],
          },
        }
      }
      const stabilizedFallback = stabilizeBriefingWithBackups(collection, fallback, events, now)
      if (!stabilizedFallback.errors.length) {
        const stableBriefing = stabilizedFallback.briefing
        return {
          ...stableBriefing,
          mode: 'qwen' as const,
          pipeline: {
            ...pipelineMetrics(stableBriefing, Math.max(0, modelCalls - 1), stabilizedFallback.selectedEvents),
            qualityStatus: 'passed' as const,
            warnings: [...stableBriefing.pipeline.warnings, `Qwen 内容未通过门禁，程序只替换不合格槽位：${lastErrors.join('；')}`],
          },
        }
      }
      lastErrors = stabilizedFallback.errors.length ? stabilizedFallback.errors : fallbackErrors
      break
    } catch (error) {
      lastErrors = [error instanceof Error ? error.message : String(error)]
      if (attempt === 0) continue
    }
  }
  return {
    ...fallback,
    pipeline: {
      ...pipelineMetrics(fallback, Math.max(0, modelCalls - 1), slotEvents),
      qualityStatus: 'degraded' as const,
      warnings: [...fallback.pipeline.warnings, `Qwen 最终稿与本地逐条回退仍未通过：${lastErrors.join('；')}；已生成明确标记的规则降级稿`],
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
