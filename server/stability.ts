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

  for (let attempt = 0; attempt < briefings.length; attempt += 1) {
    const conflicts = findCrossDomainDuplicates(current, selections)
    if (!conflicts.length) break
    const rejectByDomain = new Map<DomainId, Set<string>>()
    for (const conflict of conflicts) {
      const rejected = rejectByDomain.get(conflict.loser.domain) ?? new Set<string>()
      rejected.add(conflict.loser.story.id)
      rejectByDomain.set(conflict.loser.domain, rejected)
    }
    let progressed = false
    for (const [domain, rejectIds] of [...rejectByDomain].sort(([left], [right]) => left.localeCompare(right))) {
      const loserBriefing = current.find((briefing) => briefing.domain === domain)
      const collection = collections.find((item) => item.domain === domain)
      const selection = selections.find((item) => item.domain === domain)
      if (!loserBriefing || !collection || !selection) continue
      const stabilized = stabilizeBriefingWithBackups(collection, loserBriefing, selection.events, now, [...rejectIds].sort())
      if (stabilized.unresolvedRejectIds.length || stabilized.errors.length) continue
      current = current.map((briefing) => briefing.domain === domain ? stabilized.briefing : briefing)
      replacements.push(...stabilized.replacements)
      progressed = true
    }
    if (!progressed) break
  }

  return {
    briefings: current,
    replacements,
    errors: validateCrossDomainUniqueness(current, selections),
  }
}
