import { createHash } from 'node:crypto'
import Parser from 'rss-parser'
import type { BriefingStory, DailyBriefing, DomainId } from '../shared/briefing.js'
import { DOMAIN_CONFIGS, type DomainConfig, type FeedSource } from './sources.js'

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
}

const parser = new Parser({
  timeout: 12_000,
  headers: {
    'User-Agent': 'DailyNews/0.2 (+personal RSS reader)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  },
})

function stripHtml(value = '') {
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

function cleanUrl(rawUrl = '') {
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
    }]
  })
}

export function deduplicateCandidates(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const accepted: Candidate[] = []
  for (const candidate of sorted) {
    const duplicate = accepted.some((item) =>
      cleanUrl(item.url) === cleanUrl(candidate.url)
      || normalizeTitle(item.title) === normalizeTitle(candidate.title)
      || titleSimilarity(item.title, candidate.title) >= 0.64,
    )
    if (!duplicate) accepted.push(candidate)
  }
  return accepted
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

export function buildCandidatePool(collection: CollectionResult, limit = 15) {
  return selectDiverseStories(deduplicateCandidates(collection.candidates), limit)
}

function shorten(text: string, max = 180) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text
}

function ruleAnalysis(config: DomainConfig, candidate: Candidate, rank: number): BriefingStory {
  const fact = shorten(candidate.description) || `来自 ${candidate.source.name} 的最新更新，完整事实需查看原文。`
  return {
    id: candidate.id,
    rank,
    title: candidate.title,
    summary: fact,
    keyFacts: [fact],
    whyItMatters: `这条信息可能影响${config.fallback.affectedParties.slice(0, 2).join('与')}，但仍需结合后续数据判断真实影响。`,
    background: config.fallback.background,
    impactChain: ['事件或政策信号出现', '相关主体调整资源与行为', '影响逐步传导至行业、市场或个人决策'],
    affectedParties: config.fallback.affectedParties,
    uncertainties: '当前只依据 RSS 标题与摘要整理；未获来源明确确认的细节不作推断。',
    glossary: [],
    trend: {
      nearTerm: '未来 24–72 小时关注官方补充信息和其他可靠来源的交叉验证。',
      mediumTerm: config.fallback.outlook,
      signalsToWatch: ['官方文件或数据', '相关参与方行动', '行业与市场的持续反应'],
    },
    url: candidate.url,
    source: { name: candidate.source.name, type: candidate.source.type },
    publishedAt: candidate.publishedAt,
    confidence: candidate.source.type === 'official' ? '高' : '中',
    tags: candidate.tags,
  }
}

export type CollectionResult = {
  domain: DomainId
  candidates: Candidate[]
  fetched: number
  sourceCount: number
  warnings: string[]
}

export async function collectCandidates(domain: DomainId, now = new Date()): Promise<CollectionResult> {
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
  return { domain, candidates, fetched: candidates.length, sourceCount, warnings }
}

export function buildRulesBriefing(collection: CollectionResult, now = new Date(), preferredIds: string[] = []): DailyBriefing {
  const config = DOMAIN_CONFIGS[collection.domain]
  const deduped = deduplicateCandidates(collection.candidates)
  const preferred = preferredIds.map((id) => deduped.find((candidate) => candidate.id === id)).filter((candidate): candidate is Candidate => Boolean(candidate))
  const selected = [...preferred]
  for (const candidate of selectDiverseStories(deduped)) {
    if (selected.length >= 5) break
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate)
  }
  if (selected.length < 5) throw new Error(`${config.title}可用新闻不足 5 条（当前 ${selected.length} 条），已停止生成，避免用旧内容补位。`)
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
  const stories = selected.map((candidate, index) => ruleAnalysis(config, candidate, index + 1))
  const officialCount = stories.filter((story) => story.source.type === 'official').length
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
    overview: `从 ${collection.sourceCount} 个有效来源获取 ${collection.fetched} 条候选，去重后保留 ${deduped.length} 条，并选出 5 条重点。`,
    keyTakeaway: stories[0].whyItMatters,
    logic: `排序优先考虑来源级别、发布时间、影响关键词和信息完整度，并限制单一来源最多 2 条；本期包含 ${officialCount} 条官方源。`,
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
      sourceCount: collection.sourceCount,
      warnings: collection.warnings,
    },
  }
}
