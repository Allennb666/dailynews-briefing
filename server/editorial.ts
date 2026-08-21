import type { BriefingStory, DailyBriefing, DailyDigest, DomainId } from '../shared/briefing.js'
import {
  cleanUrl,
  createEvent,
  crossDomainEventConfidence,
  crossDomainEventMatch,
  eventDomainFit,
  titleSimilarity,
  type NewsEvent,
} from './pipeline.js'
import { DOMAIN_ORDER } from './sources.js'

function evidenceBoost(event: NewsEvent) {
  return event.evidence.level === 'confirmed' ? 18
    : event.evidence.level === 'corroborated' ? 14
      : event.evidence.level === 'single-source' ? 3
        : -16
}

export function deduplicateAcrossDomains(
  selections: Array<{ domain: DomainId; events: NewsEvent[] }>,
) {
  const result = DOMAIN_ORDER.flatMap((domain) => {
    const selection = selections.find((item) => item.domain === domain)
    return selection ? [{ ...selection, events: [...selection.events] }] : []
  })
  const references = result.flatMap((selection) => selection.events.map((event) => ({ domain: selection.domain, event })))
  const groups: Array<typeof references> = []
  for (const reference of references) {
    const group = groups.find((members) => members.some((member) =>
      member.domain !== reference.domain && crossDomainEventMatch(member.event, reference.event)))
    if (group) group.push(reference)
    else groups.push([reference])
  }

  for (const group of groups.filter((members) => new Set(members.map((member) => member.domain)).size > 1)) {
    const ranked = [...group].sort((left, right) => {
      const fit = eventDomainFit(right.event, right.domain) - eventDomainFit(left.event, left.domain)
      if (fit) return fit
      const priority = right.event.primaryArticle.score + evidenceBoost(right.event)
        - left.event.primaryArticle.score - evidenceBoost(left.event)
      if (priority) return priority
      return DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain)
        || left.event.id.localeCompare(right.event.id)
    })
    const winner = ranked[0]
    const articlesByUrl = new Map<string, NewsEvent['articles'][number]>()
    for (const item of ranked) {
      for (const article of item.event.articles) {
        const url = cleanUrl(article.url)
        if (!articlesByUrl.has(url)) articlesByUrl.set(url, { ...article, domain: winner.domain })
      }
    }
    const uniqueArticles = [...articlesByUrl.values()]
    const merged = createEvent(winner.domain, uniqueArticles)
    merged.id = winner.event.id
    const winnerSelection = result.find((selection) => selection.domain === winner.domain)!
    winnerSelection.events = winnerSelection.events.map((event) => event.id === winner.event.id ? merged : event)
    for (const loser of ranked.slice(1)) {
      const selection = result.find((item) => item.domain === loser.domain)!
      selection.events = selection.events.filter((event) => event.id !== loser.event.id)
    }
  }
  return result
}

export type CrossDomainDuplicate = {
  winner: { domain: DomainId; story: BriefingStory; event?: NewsEvent }
  loser: { domain: DomainId; story: BriefingStory; event?: NewsEvent }
}

function editorialAnglesAreDistinct(left: BriefingStory, right: BriefingStory) {
  const title = titleSimilarity(left.title, right.title)
  const summary = titleSimilarity(left.summary, right.summary)
  const facts = titleSimilarity(left.keyFacts.join(' '), right.keyFacts.join(' '))
  return title < 0.5 && summary < 0.42 && facts < 0.42
}

export function findCrossDomainDuplicates(
  briefings: DailyBriefing[],
  selections: Array<{ domain: DomainId; events: NewsEvent[] }> = [],
) {
  const eventByDomainAndId = new Map(selections.flatMap((selection) => selection.events.map((event) => [`${selection.domain}:${event.id}`, event] as const)))
  const conflicts: CrossDomainDuplicate[] = []
  const stories = briefings.flatMap((briefing) => briefing.stories.map((story) => ({ domain: briefing.domain, story })))
  for (let index = 0; index < stories.length; index += 1) {
    for (let other = index + 1; other < stories.length; other += 1) {
      if (stories[index].domain === stories[other].domain) continue
      const left = { ...stories[index], event: eventByDomainAndId.get(`${stories[index].domain}:${stories[index].story.id}`) }
      const right = { ...stories[other], event: eventByDomainAndId.get(`${stories[other].domain}:${stories[other].story.id}`) }
      const sameEvent = left.event && right.event
        ? crossDomainEventConfidence(left.event, right.event) === 'high'
        : titleSimilarity(left.story.title, right.story.title) >= 0.98
      if (!sameEvent) continue
      if (sameEvent && editorialAnglesAreDistinct(left.story, right.story)) continue
      const ranked = [left, right].sort((a, b) => {
        const fit = (b.event ? eventDomainFit(b.event, b.domain) : 0) - (a.event ? eventDomainFit(a.event, a.domain) : 0)
        if (fit) return fit
        const priority = (b.event?.primaryArticle.score ?? 0) + (b.event ? evidenceBoost(b.event) : 0)
          - (a.event?.primaryArticle.score ?? 0) - (a.event ? evidenceBoost(a.event) : 0)
        if (priority) return priority
        return DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain) || a.story.rank - b.story.rank
      })
      conflicts.push({ winner: ranked[0], loser: ranked[1] })
    }
  }
  return conflicts
}

export function findCrossDomainSimilarityWarnings(
  briefings: DailyBriefing[],
  selections: Array<{ domain: DomainId; events: NewsEvent[] }> = [],
) {
  const eventByDomainAndId = new Map(selections.flatMap((selection) => selection.events.map((event) => [`${selection.domain}:${event.id}`, event] as const)))
  const stories = briefings.flatMap((briefing) => briefing.stories.map((story) => ({ domain: briefing.domain, story })))
  const warnings: string[] = []
  for (let index = 0; index < stories.length; index += 1) {
    for (let other = index + 1; other < stories.length; other += 1) {
      if (stories[index].domain === stories[other].domain) continue
      const left = eventByDomainAndId.get(`${stories[index].domain}:${stories[index].story.id}`)
      const right = eventByDomainAndId.get(`${stories[other].domain}:${stories[other].story.id}`)
      if (left && right && crossDomainEventConfidence(left, right) === 'medium') {
        warnings.push(`${stories[index].story.id} 与 ${stories[other].story.id} 仅为低置信主题相似，已记录但不阻止发布`)
      }
    }
  }
  return warnings
}

export function validateCrossDomainUniqueness(
  briefings: DailyBriefing[],
  selections: Array<{ domain: DomainId; events: NewsEvent[] }> = [],
) {
  return findCrossDomainDuplicates(briefings, selections).map((conflict) =>
    `${conflict.winner.story.id} 与 ${conflict.loser.story.id} 跨领域重复`)
}

export function buildDailyDigest(
  briefings: DailyBriefing[],
  eventSelections: Array<{ domain: DomainId; events: NewsEvent[] }>,
  generatedAt: Date,
): DailyDigest {
  const eventById = new Map(eventSelections.flatMap((selection) => selection.events.map((event) => [event.id, event] as const)))
  const ranked = briefings.flatMap((briefing) => briefing.stories.map((story) => {
    const event = eventById.get(story.id)
    const structural = event?.primaryArticle.score ?? 0
    const crossDomain = (event?.topicTags.length ?? 0) >= 2 ? 4 : 0
    const diversity = briefing.domain === 'learning' ? 1 : 0
    return { domain: briefing.domain, storyId: story.id, score: structural + (event ? evidenceBoost(event) : 0) + crossDomain + diversity }
  }))
  const topStories: DailyDigest['topStories'] = []
  const companyCounts = new Map<string, number>()
  for (const item of ranked.sort((a, b) => b.score - a.score)) {
    const event = eventById.get(item.storyId)
    const entity = event?.entities[0] ?? item.storyId
    if ((companyCounts.get(entity) ?? 0) >= 1) continue
    topStories.push({ domain: item.domain, storyId: item.storyId })
    companyCounts.set(entity, 1)
    if (topStories.length === 3) break
  }
  const topLabels = topStories.flatMap((reference) => {
    const briefing = briefings.find((item) => item.domain === reference.domain)
    const story = briefing?.stories.find((item) => item.id === reference.storyId)
    return story ? [story.tags[0] ?? story.title] : []
  })
  return {
    schemaVersion: 2,
    date: briefings[0].date,
    generatedAt: generatedAt.toISOString(),
    briefings,
    topStories,
    mainline: topLabels.length
      ? `今日跨领域主线集中在${topLabels.join('、')}：需要同时观察政策动作、产业兑现和可验证数据，而非只依据单一标题判断。`
      : '今日主线仍需更多可靠材料确认。',
  }
}
