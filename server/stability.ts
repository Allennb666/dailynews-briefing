import type { DailyBriefing, DomainId } from '../shared/briefing.js'
import { findCrossDomainDuplicates, validateCrossDomainUniqueness } from './editorial.js'
import { stabilizeBriefingWithBackups, type BriefingReplacement } from './model.js'
import type { CollectionResult, NewsEvent } from './pipeline.js'

export type CrossDomainStabilityResult = {
  briefings: DailyBriefing[]
  replacements: BriefingReplacement[]
  errors: string[]
}

export function resolveCrossDomainDuplicatesWithBackups(
  briefings: DailyBriefing[],
  collections: CollectionResult[],
  selections: Array<{ domain: DomainId; events: NewsEvent[] }>,
  now = new Date(),
): CrossDomainStabilityResult {
  let current = [...briefings]
  const replacements: BriefingReplacement[] = []
  const failedPairs = new Set<string>()

  for (let attempt = 0; attempt < briefings.length * 5; attempt += 1) {
    const conflict = findCrossDomainDuplicates(current, selections).find((item) => {
      const key = `${item.winner.domain}:${item.winner.story.id}|${item.loser.domain}:${item.loser.story.id}`
      return !failedPairs.has(key)
    })
    if (!conflict) break
    const key = `${conflict.winner.domain}:${conflict.winner.story.id}|${conflict.loser.domain}:${conflict.loser.story.id}`
    const loserBriefing = current.find((briefing) => briefing.domain === conflict.loser.domain)
    const collection = collections.find((item) => item.domain === conflict.loser.domain)
    const selection = selections.find((item) => item.domain === conflict.loser.domain)
    if (!loserBriefing || !collection || !selection) {
      failedPairs.add(key)
      continue
    }
    const stabilized = stabilizeBriefingWithBackups(
      collection,
      loserBriefing,
      selection.events,
      now,
      [conflict.loser.story.id],
    )
    if (stabilized.unresolvedRejectIds.length || stabilized.errors.length || !stabilized.replacements.length) {
      failedPairs.add(key)
      continue
    }
    current = current.map((briefing) => briefing.domain === loserBriefing.domain ? stabilized.briefing : briefing)
    replacements.push(...stabilized.replacements)
  }

  return {
    briefings: current,
    replacements,
    errors: validateCrossDomainUniqueness(current, selections),
  }
}
