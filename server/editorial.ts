import type { DailyBriefing, DailyDigest, DomainId } from '../shared/briefing.js'
import { normalizeTitle, titleSimilarity, type NewsEvent } from './pipeline.js'

function evidenceBoost(event: NewsEvent) {
  return event.evidence.level === 'confirmed' ? 18
    : event.evidence.level === 'corroborated' ? 14
      : event.evidence.level === 'single-source' ? 3
        : -16
}

function crossDomainMatch(left: NewsEvent, right: NewsEvent) {
  const timeDistance = Math.abs(new Date(left.latestUpdateAt).getTime() - new Date(right.latestUpdateAt).getTime()) / 3_600_000
  if (!Number.isFinite(timeDistance) || timeDistance > 72) return false
  if (normalizeTitle(left.canonicalTitle) === normalizeTitle(right.canonicalTitle)) return true
  const sharedEntities = left.entities.filter((entity) => right.entities.includes(entity))
  const titleScore = titleSimilarity(left.canonicalTitle, right.canonicalTitle)
  return titleScore >= 0.62 || (sharedEntities.length >= 1 && titleScore >= 0.38)
}

export function deduplicateAcrossDomains(
  selections: Array<{ domain: DomainId; events: NewsEvent[] }>,
) {
  const result = selections.map((selection) => ({ ...selection, events: [...selection.events] }))
  for (let leftIndex = 0; leftIndex < result.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < result.length; rightIndex += 1) {
      const left = result[leftIndex]
      const right = result[rightIndex]
      for (const leftEvent of [...left.events]) {
        const rightEvent = right.events.find((event) => crossDomainMatch(leftEvent, event))
        if (!rightEvent) continue
        const leftScore = leftEvent.primaryArticle.score + evidenceBoost(leftEvent)
        const rightScore = rightEvent.primaryArticle.score + evidenceBoost(rightEvent)
        const removeFrom = leftScore >= rightScore ? right : left
        const removeEvent = leftScore >= rightScore ? rightEvent : leftEvent
        if (removeFrom.events.length > 5) removeFrom.events = removeFrom.events.filter((event) => event.id !== removeEvent.id)
      }
    }
  }
  return result
}

export function validateCrossDomainUniqueness(briefings: DailyBriefing[]) {
  const errors: string[] = []
  const stories = briefings.flatMap((briefing) => briefing.stories.map((story) => ({ domain: briefing.domain, story })))
  for (let index = 0; index < stories.length; index += 1) {
    for (let other = index + 1; other < stories.length; other += 1) {
      if (stories[index].domain === stories[other].domain) continue
      if (titleSimilarity(stories[index].story.title, stories[other].story.title) >= 0.7) {
        errors.push(`${stories[index].story.id} 与 ${stories[other].story.id} 跨领域重复`)
      }
    }
  }
  return errors
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
