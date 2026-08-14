import type {
  BriefingMode,
  DailyBriefing,
  FactSourceLink,
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
  factSources: FactSourceLink[]
  whyItMatters: string
  background: string
  impactChain: string[]
  affectedParties: string[]
  uncertainties: string
  glossary: GlossaryTerm[]
  trend: StoryTrend
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

function validTrend(value: unknown): value is StoryTrend {
  if (!value || typeof value !== 'object') return false
  const trend = value as Partial<StoryTrend>
  return typeof trend.nearTerm === 'string' && typeof trend.mediumTerm === 'string' && stringArray(trend.signalsToWatch, 2)
}

function validRadar(value: unknown): value is TrendRadarItem[] {
  const directions = new Set(['↑↑', '↑', '→', '↓', '高波动'])
  return Array.isArray(value) && value.length >= 2 && value.every((item) =>
    item && typeof item.theme === 'string' && typeof item.reason === 'string' && directions.has(item.direction),
  )
}

function validFactSources(value: unknown): value is FactSourceLink[] {
  return Array.isArray(value) && value.every((item) => item
    && Number.isInteger(item.factIndex)
    && item.factIndex >= 0
    && stringArray(item.urls))
}

function preferredString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
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
    articles: event.articles.map((article) => ({
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
    const allowedUrls = new Set(eventById.get(story.id)?.articles.map((article) => article.url) ?? [])
    const factSources = validFactSources(incoming.factSources)
      ? incoming.factSources.map((link) => ({ ...link, urls: link.urls.filter((url) => allowedUrls.has(url)) })).filter((link) => link.urls.length)
      : story.factSources
    return {
      ...story,
      title: preferredString(incoming.title, story.title),
      summary: preferredString(incoming.summary, story.summary),
      keyFacts: stringArray(incoming.keyFacts) ? incoming.keyFacts.slice(0, 4) : story.keyFacts,
      factSources,
      whyItMatters: preferredString(incoming.whyItMatters, story.whyItMatters),
      background: preferredString(incoming.background, story.background),
      impactChain: stringArray(incoming.impactChain, 3) ? incoming.impactChain.slice(0, 5) : story.impactChain,
      affectedParties: stringArray(incoming.affectedParties, 2) ? incoming.affectedParties.slice(0, 4) : story.affectedParties,
      uncertainties: preferredString(incoming.uncertainties, story.uncertainties),
      glossary: validGlossary(incoming.glossary) ? incoming.glossary.slice(0, 4) : story.glossary,
      trend: validTrend(incoming.trend) ? incoming.trend : story.trend,
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
      if (/\d/.test(fact)) {
        const links = story.factSources.find((link) => link.factIndex === factIndex)?.urls ?? []
        if (!links.length || links.some((url) => !allowedUrls.has(url))) errors.push(`${story.id} 的数字事实 ${factIndex} 未关联候选来源 URL`)
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
事实规则：数字、日期、动作、引语只能来自 articles。每条 keyFacts 都要用 factSources 以 factIndex（从 0 开始）关联 articles 中的原文 URL，含数字的事实必须至少关联一个 URL。不得把分析写成事实。
预测规则：nearTerm 和 mediumTerm 必须使用“如果/若/可能/取决于/需观察”等条件表达，并给 2–4 个可验证 signalsToWatch。
深度：summary 80–150 字；keyFacts 2–4 条；whyItMatters 80–150 字；background 100–180 字；impactChain 3–5 节点；affectedParties 2–4 条；uncertainties 明确信息边界；glossary 1–4 个。领域 overview/logic/newKnowledge/outlook 各 100–200 字，keyTakeaway 50–100 字。
只输出 JSON：
{"overview":"","keyTakeaway":"","logic":"","newKnowledge":"","outlook":"","trendRadar":[{"theme":"","direction":"↑↑|↑|→|↓|高波动","reason":""}],"watchNext":[""],"stories":[{"id":"","title":"","summary":"","keyFacts":["",""],"factSources":[{"factIndex":0,"urls":[""]}],"whyItMatters":"","background":"","impactChain":["","", ""],"affectedParties":["",""],"uncertainties":"","glossary":[{"term":"","definition":""}],"trend":{"nearTerm":"如果……可能……","mediumTerm":"若……则可能……","signalsToWatch":["",""]},"tags":[""]}]}
输入事件：${JSON.stringify(modelInput(events, 5_000, collection.previousTitles ?? []))}`
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
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
      if (lastErrors.length) continue
      return {
        ...merged,
        pipeline: {
          ...pipelineMetrics(merged, attempt),
          qualityStatus: 'passed' as const,
          warnings: [...merged.pipeline.warnings, ...(attempt ? ['Qwen 初稿未通过门禁，已修复一次并通过'] : [])],
        },
      }
    } catch (error) {
      lastErrors = [error instanceof Error ? error.message : String(error)]
    }
  }
  return {
    ...fallback,
    pipeline: {
      ...pipelineMetrics(fallback, 1),
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
