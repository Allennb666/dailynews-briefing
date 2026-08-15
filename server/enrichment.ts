import { DOMAIN_CONFIGS } from './sources.js'
import { DOMAIN_ORDER } from './sources.js'
import {
  assessSearchHit,
  createEvent,
  eventMatch,
  extractActions,
  extractKeyNumbers,
  keyNumberQueryLabel,
  type CandidateDecision,
  type NewsEvent,
} from './pipeline.js'
import { searchOptionsForDomain, type SearchRuntime } from './search.js'

export function buildVerificationQuery(event: NewsEvent) {
  const text = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const entities = event.entities.slice(0, 3)
  const actions = [...extractActions(text)].slice(0, 2)
  const numbers = extractKeyNumbers(text).slice(0, 3).map(keyNumberQueryLabel)
  const date = Number.isFinite(new Date(event.publishedAt).getTime()) ? event.publishedAt.slice(0, 10) : ''
  return [...entities, ...actions, ...numbers, date, 'official Reuters AP independent verification']
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

export async function searchSecondSource(
  event: NewsEvent,
  runtime: SearchRuntime,
  now = new Date(),
  onDecision?: (decision: CandidateDecision) => void,
) {
  if (!runtime.enabled || !runtime.reserveSecondSourceEvent(event.domain)) return event
  const query = buildVerificationQuery(event)
  const hits = await runtime.search(
    query,
    8,
    searchOptionsForDomain(event.domain, now, query),
    { domain: event.domain, phase: 'verification' },
  )
  const additions = hits.flatMap((hit) => {
    const assessment = assessSearchHit(DOMAIN_CONFIGS[event.domain], hit, query, now, 'verification')
    const candidate = assessment.candidate
    if (!candidate) {
      onDecision?.(assessment.decision)
      return []
    }
    const duplicateUrl = event.articles.some((article) => article.url === candidate.url)
    const accepted = !duplicateUrl && eventMatch(event.primaryArticle, candidate)
    onDecision?.({
      ...assessment.decision,
      accepted,
      reason: accepted ? 'accepted' : duplicateUrl ? 'duplicate-url' : 'event-mismatch',
    })
    if (!candidate || event.articles.some((article) => article.url === candidate.url)) return []
    return eventMatch(event.primaryArticle, candidate) ? [candidate] : []
  })
  if (!additions.length) return event
  const enriched = createEvent(event.domain, [...event.articles, ...additions])
  enriched.id = event.id
  return enriched
}

export async function enrichImportantEvents(
  events: NewsEvent[],
  runtime: SearchRuntime,
  now = new Date(),
  onDecision?: (decision: CandidateDecision) => void,
) {
  const enriched: NewsEvent[] = []
  const evidencePriority = { confirmed: 20, corroborated: 15, 'single-source': 3, unverified: -12 }
  for (const domain of DOMAIN_ORDER) {
    const selected = events
      .filter((event) => event.domain === domain)
      .sort((a, b) => (b.primaryArticle.score + evidencePriority[b.evidence.level])
        - (a.primaryArticle.score + evidencePriority[a.evidence.level]) || a.id.localeCompare(b.id))
      .slice(0, 2)
    for (const event of selected) enriched.push(await searchSecondSource(event, runtime, now, onDecision))
  }
  return enriched
}
