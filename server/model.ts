import type { BriefingMode, DailyBriefing, GlossaryTerm, StoryTrend, TrendRadarItem } from '../shared/briefing.js'
import { DOMAIN_CONFIGS } from './sources.js'
import type { CollectionResult, NewsEvent } from './pipeline.js'
import { buildCandidatePool, buildRulesBriefing } from './pipeline.js'

type ProviderConfig = {
  mode: Exclude<BriefingMode, 'rules'>
  apiKey: string
  baseUrl: string
  model: string
}

type ModelStory = {
  id: string
  title: string
  summary: string
  keyFacts: string[]
  whyItMatters: string
  background: string
  impactChain: string[]
  affectedParties: string[]
  uncertainties: string
  glossary: GlossaryTerm[]
  trend: StoryTrend
  tags: string[]
}

type ModelBriefing = {
  overview: string
  keyTakeaway: string
  logic: string
  newKnowledge: string
  outlook: string
  trendRadar: TrendRadarItem[]
  watchNext: string[]
  stories: ModelStory[]
}

function providerFromEnvironment(): ProviderConfig | null {
  const requested = (process.env.AI_PROVIDER ?? 'auto').toLocaleLowerCase()
  const providers: ProviderConfig[] = [
    {
      mode: 'qwen',
      apiKey: process.env.DASHSCOPE_API_KEY ?? '',
      baseUrl: process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: process.env.QWEN_MODEL ?? 'qwen3.5-27b',
    },
    {
      mode: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    },
    {
      mode: 'openai',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
    },
  ]
  if (requested === 'rules') return null
  if (requested === 'auto') return providers.find((provider) => provider.apiKey) ?? null
  return providers.find((provider) => provider.mode === requested && provider.apiKey) ?? null
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return JSON.parse((fenced?.[1] ?? text).trim()) as unknown
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

function preferredString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function mergeModelBriefing(baseline: DailyBriefing, value: unknown, mode: Exclude<BriefingMode, 'rules'>) {
  if (!value || typeof value !== 'object') throw new Error(`${mode} 返回内容不是对象`)
  const analysis = value as Partial<ModelBriefing>
  const incomingStories = Array.isArray(analysis.stories) ? analysis.stories : []
  const incomingById = new Map(incomingStories.filter((story) => story && typeof story.id === 'string').map((story) => [story.id, story]))
  let enhancedCount = 0
  let partialCount = 0

  const stories = baseline.stories.map((story) => {
    const incoming = incomingById.get(story.id)
    if (!incoming) {
      partialCount += 1
      return story
    }
    enhancedCount += 1
    const complete = stringArray(incoming.keyFacts, 2)
      && stringArray(incoming.impactChain, 3)
      && stringArray(incoming.affectedParties, 2)
      && validGlossary(incoming.glossary)
      && validTrend(incoming.trend)
    if (!complete) partialCount += 1
    return {
      ...story,
      title: preferredString(incoming.title, story.title),
      summary: preferredString(incoming.summary, story.summary),
      keyFacts: stringArray(incoming.keyFacts) ? incoming.keyFacts.slice(0, 4) : story.keyFacts,
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

  if (!enhancedCount) throw new Error(`${mode} 未返回任何可匹配的新闻`)
  const warnings = partialCount
    ? [...baseline.pipeline.warnings, `${mode} 有 ${partialCount} 条新闻的部分字段使用规则补全`]
    : baseline.pipeline.warnings

  return {
    ...baseline,
    mode,
    overview: preferredString(analysis.overview, baseline.overview),
    keyTakeaway: preferredString(analysis.keyTakeaway, baseline.keyTakeaway),
    logic: preferredString(analysis.logic, baseline.logic),
    newKnowledge: preferredString(analysis.newKnowledge, baseline.newKnowledge),
    outlook: preferredString(analysis.outlook, baseline.outlook),
    trendRadar: validRadar(analysis.trendRadar) ? analysis.trendRadar.slice(0, 4) : baseline.trendRadar,
    watchNext: stringArray(analysis.watchNext, 3) ? analysis.watchNext.slice(0, 5) : baseline.watchNext,
    stories,
    pipeline: { ...baseline.pipeline, warnings },
  } satisfies DailyBriefing
}

function modelInput(events: NewsEvent[]) {
  return events.map((event) => ({
    id: event.id,
    canonicalTitle: event.canonicalTitle,
    entities: event.entities,
    topicTags: event.topicTags,
    publishedAt: event.publishedAt,
    latestUpdateAt: event.latestUpdateAt,
    evidence: event.evidence,
    articles: event.articles.map((article) => ({
      title: article.title,
      material: article.description.slice(0, 1_800),
      source: article.source.name,
      sourceType: article.source.type,
      sourceReliability: article.source.reliability,
      publishedAt: article.publishedAt,
      url: article.url,
    })),
  }))
}

async function requestAnalysis(provider: ProviderConfig, collection: CollectionResult, events: NewsEvent[]) {
  const config = DOMAIN_CONFIGS[collection.domain]
  const prompt = `你是 DailyNews 的中文深度简报编辑，当前领域是“${config.title}”。请先从候选材料中选择最重要的 5 条，再整理成既适合晨间速览、又能折叠深读的结构化简报。

筛选标准：
1. 优先全球或行业影响大、改变政策/资本/技术/教育结构、未来仍需持续跟踪的事件。
2. 兼顾来源可信度、主题多样性和不同参与方；同一来源最多 2 条，同一狭窄子话题不要重复占位。
3. 不因标题猎奇、情绪强烈或只是最新就提高排名；地方性事件只有具备更广泛示范意义时才入选。
4. 输入单位已经是聚类后的事件；stories 必须恰好输出 5 个事件，并按重要性从高到低排列；id 必须来自输入事件。
5. 不得把同一事件的多个来源重新当成多条新闻；优先结合 articles 中的多来源材料整理共同事实与差异。

事实边界：
1. title、summary、keyFacts 中的具体事实、数字、日期、引语和机构立场只能来自输入材料；材料不足时明确写“材料未提供”。
2. background、whyItMatters、impactChain 可以使用稳定的通用知识解释机制，但不得引入输入之外的最新事件或具体数字。
3. uncertainties 必须指出信息边界、来源立场或仍待验证之处。
4. trend 只能写条件式判断和可验证信号，禁止把预测写成确定事实。

深度要求：
1. 每条 summary 80–150 字；keyFacts 2–4 条；whyItMatters 80–150 字；background 100–180 字。
2. impactChain 用 3–5 个短节点表达“起因 → 传导 → 结果”；affectedParties 2–4 条。
3. glossary 自动识别首次出现且可能有理解门槛的专业术语、行业指标、缩写或学术概念，提供 1–4 个简明中文解释。不要只解释预设词，也不要解释普通词。
4. trend.nearTerm 写未来 24–72 小时；mediumTerm 写未来数周至数月；signalsToWatch 给 2–4 个可以验证预测的信号。
5. 领域级 overview、logic、newKnowledge、outlook 各 100–200 字；keyTakeaway 50–100 字；trendRadar 2–4 项；watchNext 3–5 项。
6. 标题翻译为自然克制的中文，专有名词保留；表达清楚、务实，不使用夸张语气。

只输出 JSON，不要 Markdown。必须严格使用以下结构并保留每条 id：
{
  "overview":"",
  "keyTakeaway":"",
  "logic":"",
  "newKnowledge":"",
  "outlook":"",
  "trendRadar":[{"theme":"","direction":"↑↑|↑|→|↓|高波动","reason":""}],
  "watchNext":[""],
  "stories":[{
    "id":"","title":"","summary":"","keyFacts":["",""],"whyItMatters":"","background":"",
    "impactChain":["起因","传导","结果"],"affectedParties":["",""],"uncertainties":"",
    "glossary":[{"term":"","definition":""}],
    "trend":{"nearTerm":"","mediumTerm":"","signalsToWatch":["",""]},
    "tags":[""]
  }]
}

输入事件：${JSON.stringify(modelInput(events))}`

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      max_tokens: 10_000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是严谨的中文新闻编辑。你会主动解释专业术语，严格区分事实、分析、不确定性与预测。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.mode} 返回 ${response.status}: ${detail.slice(0, 180)}`)
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error(`${provider.mode} 未返回可用内容`)
  return extractJson(content)
}

export async function buildBriefing(collection: CollectionResult, now = new Date()): Promise<DailyBriefing> {
  const baseline = buildRulesBriefing(collection, now)
  const provider = providerFromEnvironment()
  if (!provider) return baseline

  try {
    const pool = buildCandidatePool(collection)
    const analysis = await requestAnalysis(provider, collection, pool)
    const candidateIds = new Set(pool.map((candidate) => candidate.id))
    const preferredIds = Array.isArray((analysis as Partial<ModelBriefing>)?.stories)
      ? [...new Set((analysis as Partial<ModelBriefing>).stories!.map((story) => story?.id).filter((id): id is string => typeof id === 'string' && candidateIds.has(id)))].slice(0, 5)
      : []
    if (preferredIds.length !== 5) throw new Error(`${provider.mode} 没有选出 5 条有效新闻`)
    const selectedBaseline = buildRulesBriefing(collection, now, preferredIds)
    return mergeModelBriefing(selectedBaseline, analysis, provider.mode)
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型调用失败'
    return {
      ...baseline,
      pipeline: { ...baseline.pipeline, warnings: [...baseline.pipeline.warnings, `${message}；已使用规则模式生成`] },
    }
  }
}
