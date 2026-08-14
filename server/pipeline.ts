import { createHash } from 'node:crypto'
import Parser from 'rss-parser'
import type { BriefingStory, DailyBriefing, DiscoveryMethod, DomainId, EventEvidence, MaterialLevel } from '../shared/briefing.js'
import { DOMAIN_CONFIGS, type DomainConfig, type FeedSource } from './sources.js'
import {
  buildDiscoveryQueries,
  discoveryMethodForQuery,
  type SearchHit,
  type SearchRuntime,
  sourceForSearchResult,
} from './search.js'

export type Candidate = {
  id: string
  domain: DomainId
  title: string
  description: string
  url: string
  publishedAt: string
  source: FeedSource
  score: number
  tags: string[]
  discoveryMethod: DiscoveryMethod
  materialLevel: MaterialLevel
  fullText?: string
  independenceKey?: string
  duplicates?: Candidate[]
}

export type NewsEvent = {
  id: string
  domain: DomainId
  canonicalTitle: string
  articles: Candidate[]
  primaryArticle: Candidate
  entities: string[]
  topicTags: string[]
  publishedAt: string
  latestUpdateAt: string
  sourceCount: number
  evidence: EventEvidence
}

const parser = new Parser({
  timeout: 12_000,
  headers: {
    'User-Agent': 'DailyNews/0.2 (+personal RSS reader)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  },
})

export function stripHtml(value = '') {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&hellip;|&#8230;/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['ref', 'source', 'rss'].includes(key)) url.searchParams.delete(key)
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return rawUrl.trim()
  }
}

export function normalizeTitle(title: string) {
  return title.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')
}

function titleTokens(title: string) {
  const normalized = title.toLocaleLowerCase().normalize('NFKC')
  const latin = normalized.match(/[a-z0-9]+/g) ?? []
  const cjk = (normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) => {
    if (part.length < 2) return [part]
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
  })
  return new Set([...latin, ...cjk])
}

export function titleSimilarity(a: string, b: string) {
  const left = titleTokens(a)
  const right = titleTokens(b)
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / new Set([...left, ...right]).size
}

const ENTITY_ALIASES: Array<[string, RegExp]> = [
  ['openai', /\bopenai\b/i],
  ['nvidia', /\bnvidia\b|英伟达/i],
  ['google', /\bgoogle\b|谷歌/i],
  ['anthropic', /\banthropic\b/i],
  ['microsoft', /\bmicrosoft\b|微软/i],
  ['meta', /\bmeta\b|元宇宙平台/i],
  ['apple', /\bapple\b|苹果公司/i],
  ['amazon', /\bamazon\b|亚马逊/i],
  ['amd', /\bamd\b/i],
  ['intel', /\bintel\b|英特尔/i],
  ['tsmc', /\btsmc\b|台积电/i],
  ['federal-reserve', /\bfederal reserve\b|\bthe fed\b|美联储/i],
  ['sec', /\bu\.?s\.? sec\b|\bsecurities and exchange commission\b|美国证监会/i],
  ['united-nations', /\bunited nations\b|\bun\b|联合国/i],
  ['china', /\bchina\b|中国/i],
  ['united-states', /\bunited states\b|\bu\.?s\.?\b|美国/i],
  ['european-union', /\beuropean union\b|\beu\b|欧盟/i],
]

const GENERIC_ENTITY_WORDS = new Set([
  'a', 'an', 'the', 'new', 'ai', 'us', 'u', 's', 'ceo', 'government', 'company', 'market', 'report',
  'unique', 'story', 'model',
])

const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'new', 'of', 'on',
  'or', 'says', 'that', 'the', 'to', 'with', 'after', 'amid', 'about', 'into', 'its', 'their', 'this', 'will',
  'ai', 'news', 'report', 'reports', 'update', 'latest', 'company', 'market', 'industry',
])

const ACTION_GROUPS: Array<[string, RegExp]> = [
  ['launch', /\blaunch(?:es|ed|ing)?\b|\breleas(?:e|es|ed|ing)\b|\bunveil(?:s|ed|ing)?\b|\bintroduc(?:e|es|ed|ing)\b|\bannounc(?:e|es|ed|ing)\b|发布|推出|亮相|上线|公布|宣布/i],
  ['acquire', /\bacquir(?:e|es|ed|ing)\b|\bmerg(?:e|es|ed|ing)\b|\bbuy(?:s|ing)?\b|收购|并购|合并/i],
  ['funding', /\bfund(?:ing|ed)?\b|\brais(?:e|es|ed|ing)\b|\binvest(?:s|ed|ing|ment)\b|融资|募资|投资/i],
  ['earnings', /\bearnings?\b|\brevenue\b|\bprofit\b|\bguidance\b|财报|营收|利润|业绩|指引/i],
  ['appoint', /\bappoint(?:s|ed|ing)?\b|\bresign(?:s|ed|ing)?\b|\bsteps? down\b|任命|辞职|离任/i],
  ['investigate', /\binvestigat(?:e|es|ed|ing|ion)\b|\blawsuit\b|\bsues?\b|\bprobe\b|调查|起诉|诉讼|审查/i],
  ['security', /\bhack(?:s|ed|ing)?\b|\bbreach\b|\bcyberattack\b|\bvulnerability\b|黑客|泄露|网络攻击|漏洞/i],
  ['rates', /\brate (?:cut|hike)\b|\bcuts? rates?\b|\braises? rates?\b|降息|加息|利率决定/i],
  ['agreement', /\bagreement\b|\bdeal\b|\bpartner(?:s|ed|ship)?\b|\bceasefire\b|协议|合作|停火/i],
  ['restriction', /\bban(?:s|ned|ning)?\b|\bsanction(?:s|ed)?\b|\bexport control\b|禁令|制裁|出口管制/i],
  ['attack', /\battack(?:s|ed|ing)?\b|\bstrike(?:s)?\b|\binvad(?:e|es|ed|ing)\b|袭击|空袭|入侵/i],
  ['policy', /\bregulat(?:e|es|ed|ing|ion)\b|\bpolicy\b|\brule\b|监管|政策|新规/i],
  ['build', /\bbuild(?:s|ing)?\b|\bopen(?:s|ed|ing)?\b|\bexpand(?:s|ed|ing)?\b|建设|开设|扩建|扩张/i],
]

const RUMOR_PATTERN = /\brumou?r(?:s|ed)?\b|\breportedly\b|\bsources? (?:say|said)\b|\bpeople familiar with\b|消息人士|知情人士|传闻|据悉|或将|据称/i

function textTokens(value: string) {
  const normalized = value.toLocaleLowerCase().normalize('NFKC')
  const latin = (normalized.match(/[a-z0-9][a-z0-9.-]*/g) ?? []).filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token))
  const cjk = (normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) => {
    if (part.length < 2) return [part]
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
  })
  return new Set([...latin, ...cjk])
}

function setSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / new Set([...left, ...right]).size
}

function overlapCoefficient(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / Math.min(left.size, right.size)
}

function extractEntities(text: string) {
  const entities = new Set(ENTITY_ALIASES.filter(([, pattern]) => pattern.test(text)).map(([entity]) => entity))
  const named = text.match(/\b(?:[A-Z][A-Za-z0-9.-]{2,}|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9.-]{2,}|[A-Z]{2,})){0,2}\b/g) ?? []
  for (const value of named) {
    const normalized = value.toLocaleLowerCase().replace(/[.]/g, '').trim()
    if (!GENERIC_ENTITY_WORDS.has(normalized)) entities.add(normalized)
  }
  return [...entities]
}

function extractActions(text: string) {
  return new Set(ACTION_GROUPS.filter(([, pattern]) => pattern.test(text)).map(([action]) => action))
}

function sharedDistinctiveTerms(a: Candidate, b: Candidate) {
  const left = textTokens(`${a.title} ${a.description}`)
  const right = textTokens(`${b.title} ${b.description}`)
  const entityTokens = new Set([...extractEntities(`${a.title} ${a.description}`), ...extractEntities(`${b.title} ${b.description}`)])
  return [...left].filter((token) => right.has(token) && !entityTokens.has(token) && token.length >= 3).length
}

export function eventMatch(a: Candidate, b: Candidate) {
  if (a.domain !== b.domain) return false
  const timeDistanceHours = Math.abs(new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()) / 3_600_000
  if (!Number.isFinite(timeDistanceHours) || timeDistanceHours > 72) return false

  const titleScore = titleSimilarity(a.title, b.title)
  const descriptionScore = setSimilarity(textTokens(a.description), textTokens(b.description))
  const entityScore = overlapCoefficient(
    new Set(extractEntities(`${a.title} ${a.description}`)),
    new Set(extractEntities(`${b.title} ${b.description}`)),
  )
  const leftActions = extractActions(`${a.title} ${a.description}`)
  const rightActions = extractActions(`${b.title} ${b.description}`)
  const actionScore = overlapCoefficient(leftActions, rightActions)
  if (leftActions.size && rightActions.size && actionScore === 0) return false

  const tagScore = overlapCoefficient(new Set(a.tags), new Set(b.tags))
  const distinctiveTerms = sharedDistinctiveTerms(a, b)
  if (entityScore === 0 && titleScore < 0.58) return false
  if (!distinctiveTerms && titleScore < 0.5 && descriptionScore < 0.45) return false

  const timeBoost = timeDistanceHours <= 24 ? 0.06 : timeDistanceHours <= 48 ? 0.03 : 0
  const score = titleScore * 0.3
    + descriptionScore * 0.28
    + entityScore * 0.22
    + actionScore * 0.15
    + tagScore * 0.05
    + timeBoost
  return score >= 0.46
}

function detectTags(config: DomainConfig, text: string) {
  const tags = config.tagRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.tag)
  return tags.length ? tags.slice(0, 3) : [config.title.split(' · ')[0]]
}

function isRelevant(config: DomainConfig, text: string) {
  const lower = text.toLocaleLowerCase()
  return config.topicTerms.some((term) => lower.includes(term))
}

function scoreCandidate(config: DomainConfig, source: FeedSource, publishedAt: string, text: string, now: Date) {
  const ageHours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000)
  const freshness = Math.max(0, 36 - ageHours / 4)
  const lower = text.toLocaleLowerCase()
  const impact = config.impactTerms.reduce((score, term) => score + (lower.includes(term) ? 2.5 : 0), 0)
  const detail = Math.min(8, text.length / 220)
  return source.weight + freshness + Math.min(impact, 18) + detail
}

export function sourceIndependenceKey(candidate: Pick<Candidate, 'source' | 'title' | 'description' | 'independenceKey'>) {
  const material = `${candidate.title} ${candidate.description}`
  if (/\breuters\b|路透/i.test(material) || candidate.source.id.includes('reuters')) return 'wire:reuters'
  if (/\bassociated press\b|\bAP News\b|美联社/i.test(material) || candidate.source.id.includes('apnews')) return 'wire:ap'
  if (/\bagence france-presse\b|\bAFP\b|法新社/i.test(material)) return 'wire:afp'
  if (candidate.independenceKey) return candidate.independenceKey
  return `publisher:${candidate.source.id}`
}

async function fetchSource(config: DomainConfig, source: FeedSource, now: Date): Promise<Candidate[]> {
  const feed = await parser.parseURL(source.url)
  return feed.items.flatMap((item) => {
    const title = stripHtml(item.title ?? '')
    const description = stripHtml(item.content ?? item.contentSnippet ?? item.summary ?? '')
    const url = cleanUrl(item.link ?? item.guid ?? '')
    const rawDate = item.isoDate ?? item.pubDate ?? ''
    const parsedDate = rawDate ? new Date(rawDate) : now
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? now.toISOString() : parsedDate.toISOString()
    const ageDays = (now.getTime() - new Date(publishedAt).getTime()) / 86_400_000
    const text = `${title} ${description}`
    if (!title || !url || ageDays > config.sourceWindowDays || ageDays < -1 || (!source.focused && !isRelevant(config, text))) return []
    return [{
      id: createHash('sha1').update(`${config.id}:${source.id}:${url || title}`).digest('hex').slice(0, 12),
      domain: config.id,
      title,
      description,
      url,
      publishedAt,
      source,
      score: scoreCandidate(config, source, publishedAt, text, now),
      tags: detectTags(config, text),
      discoveryMethod: 'rss',
      materialLevel: 'snippet-only',
      independenceKey: `publisher:${source.id}`,
    }]
  })
}

export function candidateFromSearchHit(config: DomainConfig, hit: SearchHit, query: string, now: Date): Candidate | null {
  const title = stripHtml(hit.title)
  const description = stripHtml(hit.snippet)
  const url = cleanUrl(hit.url)
  if (!title || !url) return null
  const source = sourceForSearchResult(url, hit.publisher)
  const parsed = hit.publishedAt ? new Date(hit.publishedAt) : now
  const publishedAt = Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString()
  const text = `${title} ${description}`
  return {
    id: createHash('sha1').update(`${config.id}:search:${url}`).digest('hex').slice(0, 12),
    domain: config.id,
    title,
    description,
    url,
    publishedAt,
    source,
    score: scoreCandidate(config, source, publishedAt, text, now) + Math.max(0, Math.min(6, (hit.score ?? 0) * 6)),
    tags: detectTags(config, text),
    discoveryMethod: discoveryMethodForQuery(query, source),
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${source.id}`,
  }
}

export async function collectSearchCandidates(
  domain: DomainId,
  runtime: SearchRuntime,
  now = new Date(),
  previousEntities: string[] = [],
) {
  if (!runtime.enabled) return []
  const config = DOMAIN_CONFIGS[domain]
  const queries = buildDiscoveryQueries(domain, previousEntities, runtime.discoveryQueriesPerDomain)
  const batches = await Promise.all(queries.map(async (query) => {
    const hits = await runtime.search(query, 8)
    return hits.flatMap((hit) => {
      const candidate = candidateFromSearchHit(config, hit, query, now)
      if (!candidate || !runtime.claimUrl(cleanUrl(candidate.url))) return []
      return [candidate]
    })
  }))
  return batches.flat()
}

export function deduplicateCandidates(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const accepted: Candidate[] = []
  for (const candidate of sorted) {
    const duplicateIndex = accepted.findIndex((item) =>
      cleanUrl(item.url) === cleanUrl(candidate.url)
      || normalizeTitle(item.title) === normalizeTitle(candidate.title)
      || titleSimilarity(item.title, candidate.title) >= 0.64,
    )
    if (duplicateIndex === -1) {
      accepted.push({ ...candidate, duplicates: candidate.duplicates ? [...candidate.duplicates] : undefined })
    } else {
      const duplicate = accepted[duplicateIndex]
      accepted[duplicateIndex] = {
        ...duplicate,
        duplicates: [...(duplicate.duplicates ?? []), candidate, ...(candidate.duplicates ?? [])],
      }
    }
  }
  return accepted
}

function uniqueArticles(candidates: Candidate[]) {
  const byId = new Map<string, Candidate>()
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate)
    for (const duplicate of candidate.duplicates ?? []) byId.set(duplicate.id, duplicate)
  }
  return [...byId.values()].map(({ duplicates: _duplicates, ...candidate }) => candidate)
}

export function buildEvidence(articles: Candidate[]): EventEvidence {
  const uniqueSources = new Map(articles.map((article) => [article.source.id, article.source]))
  const sources = [...uniqueSources.values()]
  const primarySourcePresent = sources.some((source) => source.reliability === 'primary')
  const reliableIndependentSources = new Set(
    articles
      .filter((article) => article.source.reliability === 'tier-1' || article.source.reliability === 'tier-2')
      .map(sourceIndependenceKey),
  )
  const independentSourceCount = reliableIndependentSources.size
  const sourceCount = sources.length
  const rumorLike = articles.some((article) => RUMOR_PATTERN.test(`${article.title} ${article.description}`))

  let level: EventEvidence['level']
  if (primarySourcePresent && independentSourceCount >= 1) level = 'confirmed'
  else if (independentSourceCount >= 2) level = 'corroborated'
  else if (sourceCount === 1 && rumorLike) level = 'unverified'
  else if (sourceCount === 1) level = 'single-source'
  else level = 'unverified'

  return { level, sourceCount, independentSourceCount, primarySourcePresent }
}

export function createEvent(domain: DomainId, members: Candidate[]): NewsEvent {
  const representatives = [...members].sort((a, b) => b.score - a.score)
  const primaryArticle = representatives[0]
  const articles = uniqueArticles(representatives)
  const publishedTimes = articles.map((article) => new Date(article.publishedAt).getTime()).filter(Number.isFinite)
  const publishedAt = new Date(Math.min(...publishedTimes)).toISOString()
  const latestUpdateAt = new Date(Math.max(...publishedTimes)).toISOString()
  const entities = [...new Set(articles.flatMap((article) => extractEntities(`${article.title} ${article.description}`)))]
  const topicTags = [...new Set(articles.flatMap((article) => article.tags))].slice(0, 6)
  const evidence = buildEvidence(articles)
  const id = createHash('sha1').update(`${domain}:event:${primaryArticle.id}`).digest('hex').slice(0, 12)
  return {
    id,
    domain,
    canonicalTitle: primaryArticle.title,
    articles,
    primaryArticle,
    entities,
    topicTags,
    publishedAt,
    latestUpdateAt,
    sourceCount: evidence.sourceCount,
    evidence,
  }
}

export function clusterCandidates(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const clusters: Candidate[][] = []
  for (const candidate of sorted) {
    const cluster = clusters.find((members) => eventMatch(members[0], candidate))
    if (cluster) cluster.push(candidate)
    else clusters.push([candidate])
  }
  return clusters
    .map((members) => createEvent(members[0].domain, members))
    .sort((a, b) => b.primaryArticle.score - a.primaryArticle.score)
}

function buildEventLayer(collection: CollectionResult) {
  const deduped = deduplicateCandidates(collection.candidates)
  const events = clusterCandidates(deduped)
  return { deduped, events }
}

export function selectDiverseStories(candidates: Candidate[], limit = 5) {
  const selected: Candidate[] = []
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if ((counts.get(candidate.source.id) ?? 0) >= 2) continue
    selected.push(candidate)
    counts.set(candidate.source.id, (counts.get(candidate.source.id) ?? 0) + 1)
    if (selected.length === limit) return selected
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate)) selected.push(candidate)
    if (selected.length === limit) break
  }
  return selected
}

function rankedEventCandidates(events: NewsEvent[]) {
  return events.map((event) => ({ ...event.primaryArticle, id: event.id }))
}

function selectDiverseEvents(events: NewsEvent[], limit = 5) {
  const byId = new Map(events.map((event) => [event.id, event]))
  return selectDiverseStories(rankedEventCandidates(events), limit)
    .map((candidate) => byId.get(candidate.id))
    .filter((event): event is NewsEvent => Boolean(event))
}

export function buildCandidatePool(collection: CollectionResult, limit = 60) {
  const { events } = buildEventLayer(collection)
  const previousTitles = collection.previousTitles ?? []
  return events
    .map((event) => ({
      event,
      adjustedScore: event.primaryArticle.score
        - (previousTitles.some((title) => titleSimilarity(title, event.canonicalTitle) >= 0.62) ? 18 : 0),
    }))
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .map(({ event }) => event)
    .slice(0, Math.max(1, Math.min(60, limit)))
}

function shorten(text: string, max = 180) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text
}

function ruleAnalysis(config: DomainConfig, event: NewsEvent, rank: number): BriefingStory {
  const candidate = event.primaryArticle
  const fact = shorten(candidate.description) || `来自 ${candidate.source.name} 的最新更新，完整事实需查看原文。`
  const sourceDescription = event.sourceCount > 1
    ? `该事件由 ${event.sourceCount} 个来源报道，证据等级为 ${event.evidence.level}。`
    : '当前只有一个来源，仍需等待独立信息补充。'
  return {
    id: event.id,
    eventId: event.id,
    rank,
    title: event.canonicalTitle,
    summary: fact,
    keyFacts: [fact],
    whyItMatters: `这条信息可能影响${config.fallback.affectedParties.slice(0, 2).join('与')}，但仍需结合后续数据判断真实影响。`,
    background: config.fallback.background,
    impactChain: ['事件或政策信号出现', '相关主体调整资源与行为', '影响逐步传导至行业、市场或个人决策'],
    affectedParties: config.fallback.affectedParties,
    uncertainties: `当前只依据 RSS 标题与摘要整理；${sourceDescription} 未获来源明确确认的细节不作推断。`,
    glossary: [],
    trend: {
      nearTerm: '未来 24–72 小时关注官方补充信息和其他可靠来源的交叉验证。',
      mediumTerm: config.fallback.outlook,
      signalsToWatch: ['官方文件或数据', '相关参与方行动', '行业与市场的持续反应'],
    },
    url: candidate.url,
    source: { name: candidate.source.name, type: candidate.source.type, reliability: candidate.source.reliability },
    sources: event.articles.map((article) => ({
      name: article.source.name,
      type: article.source.type,
      reliability: article.source.reliability,
    })).filter((source, index, sources) => sources.findIndex((item) => item.name === source.name) === index),
    evidenceSources: event.articles.map((article) => ({
      name: article.source.name,
      type: article.source.type,
      reliability: article.source.reliability,
      title: article.title,
      publishedAt: article.publishedAt,
      url: article.url,
      discoveryMethod: article.discoveryMethod,
      materialLevel: article.materialLevel,
    })),
    factSources: [{ factIndex: 0, urls: [candidate.url] }],
    publishedAt: event.publishedAt,
    evidence: event.evidence,
    tags: event.topicTags,
  }
}

export type CollectionResult = {
  domain: DomainId
  candidates: Candidate[]
  fetched: number
  sourceCount: number
  rssCandidates?: number
  searchCandidates?: number
  searchCalls?: number
  previousTitles?: string[]
  warnings: string[]
}

export async function collectCandidates(
  domain: DomainId,
  now = new Date(),
  options: { searchRuntime?: SearchRuntime; previousEntities?: string[]; previousTitles?: string[] } = {},
): Promise<CollectionResult> {
  const config = DOMAIN_CONFIGS[domain]
  const results = await Promise.allSettled(config.sources.map((source) => fetchSource(config, source, now)))
  const warnings: string[] = []
  const candidates: Candidate[] = []
  let sourceCount = 0
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value)
      if (result.value.length) sourceCount += 1
    } else {
      warnings.push(`${config.sources[index].name} 暂时无法获取`)
    }
  })
  const rssCandidates = candidates.length
  const searchCallsBefore = options.searchRuntime?.stats.calls ?? 0
  const searched = options.searchRuntime
    ? await collectSearchCandidates(domain, options.searchRuntime, now, options.previousEntities)
    : []
  const searchCandidates = searched.length
  candidates.push(...searched)
  if (options.searchRuntime && !options.searchRuntime.enabled) warnings.push('未配置 Tavily，已自动使用 RSS-only 模式')
  else if (options.searchRuntime?.stats.failures) warnings.push('部分动态搜索失败，已保留 RSS 候选')
  const uniqueSourceIds = new Set(candidates.map((candidate) => candidate.source.id))
  return {
    domain,
    candidates,
    fetched: candidates.length,
    sourceCount: uniqueSourceIds.size || sourceCount,
    rssCandidates,
    searchCandidates,
    searchCalls: (options.searchRuntime?.stats.calls ?? 0) - searchCallsBefore,
    previousTitles: options.previousTitles ?? [],
    warnings,
  }
}

export function buildRulesBriefing(collection: CollectionResult, now = new Date(), preferredIds: string[] = []): DailyBriefing {
  const config = DOMAIN_CONFIGS[collection.domain]
  const { deduped, events } = buildEventLayer(collection)
  const preferred = preferredIds.map((id) => events.find((event) => event.id === id)).filter((event): event is NewsEvent => Boolean(event))
  const selected = [...preferred]
  for (const event of selectDiverseEvents(events)) {
    if (selected.length >= 5) break
    if (!selected.some((item) => item.id === event.id)) selected.push(event)
  }
  if (selected.length < 5) throw new Error(`${config.title}可用事件不足 5 条（当前 ${selected.length} 条），已停止生成，避免用旧内容补位。`)
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
  const stories = selected.map((event, index) => ruleAnalysis(config, event, index + 1))
  const verifiedCount = stories.filter((story) => story.evidence.level === 'confirmed' || story.evidence.level === 'corroborated').length
  return {
    schemaVersion: 2,
    id: `${date}-${config.id}`,
    domain: config.id,
    domainTitle: config.title,
    domainCode: config.code,
    date,
    generatedAt: now.toISOString(),
    sourceWindow: {
      from: new Date(now.getTime() - config.sourceWindowDays * 86_400_000).toISOString(),
      to: now.toISOString(),
    },
    mode: 'rules',
    overview: `从 ${collection.sourceCount} 个有效来源获取 ${collection.fetched} 条候选，文章去重后保留 ${deduped.length} 条，聚合为 ${events.length} 个事件，并选出 5 条重点。`,
    keyTakeaway: stories[0].whyItMatters,
    logic: `事件聚类综合标题、摘要、实体、动作和时间接近度；排序继续沿用来源级别、发布时间、影响关键词与信息完整度，并限制单一主来源最多 2 条。本期有 ${verifiedCount} 个事件达到多源确认或印证。`,
    newKnowledge: config.fallback.knowledge,
    outlook: config.fallback.outlook,
    trendRadar: [
      { theme: stories[0].tags[0], direction: '↑', reason: '近期相关信息密度上升，需继续用后续数据验证。' },
      { theme: stories[1].tags[0], direction: '→', reason: '方向仍在形成，暂不把单日变化视为确定趋势。' },
    ],
    watchNext: ['官方后续材料', '可量化的数据变化', '其他可靠来源的交叉验证'],
    stories,
    pipeline: {
      fetched: collection.fetched,
      afterDedup: deduped.length,
      afterClustering: events.length,
      sourceCount: collection.sourceCount,
      rssCandidates: collection.rssCandidates ?? collection.fetched,
      searchCandidates: collection.searchCandidates ?? 0,
      searchCalls: collection.searchCalls ?? 0,
      confirmedCount: stories.filter((story) => story.evidence.level === 'confirmed').length,
      corroboratedCount: stories.filter((story) => story.evidence.level === 'corroborated').length,
      singleSourceCount: stories.filter((story) => story.evidence.level === 'single-source').length,
      unverifiedCount: stories.filter((story) => story.evidence.level === 'unverified').length,
      primarySourceCount: stories.filter((story) => story.evidence.primarySourcePresent).length,
      maxSourceConcentration: Math.max(...[...new Set(stories.map((story) => story.source.name))].map((name) => stories.filter((story) => story.source.name === name).length)),
      qualityStatus: 'degraded',
      warnings: collection.warnings,
    },
  }
}
