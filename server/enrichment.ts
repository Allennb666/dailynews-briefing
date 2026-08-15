import { DOMAIN_CONFIGS } from './sources.js'
import { DOMAIN_ORDER } from './sources.js'
import {
  assessSearchHit,
  assessEventMatch,
  createEvent,
  extractActions,
  extractEntities,
  extractEventObjects,
  extractKeyNumbers,
  keyNumberQueryLabel,
  type CandidateDecision,
  type NewsEvent,
} from './pipeline.js'
import { normalizedHostname, searchOptionsForDomain, type SearchRuntime } from './search.js'

const INDEPENDENT_MEDIA_DOMAINS = ['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'bloomberg.com', 'ft.com', 'cnbc.com', 'theguardian.com']
const OFFICIAL_VERIFICATION_DOMAINS: Record<NewsEvent['domain'], string[]> = {
  'ai-tech': ['openai.com', 'anthropic.com', 'nvidia.com', 'amd.com', 'intel.com', 'tsmc.com', 'microsoft.com', 'google.com'],
  markets: ['federalreserve.gov', 'bls.gov', 'bea.gov', 'sec.gov', 'eia.gov', 'treasury.gov'],
  world: ['un.org', 'nato.int', 'consilium.europa.eu', 'ec.europa.eu', 'whitehouse.gov'],
  learning: ['ibo.org', 'oecd.org', 'unesco.org', 'worldbank.org'],
}

const ENTITY_OFFICIAL_DOMAINS: Record<string, string[]> = {
  openai: ['openai.com'], nvidia: ['nvidia.com'], amd: ['amd.com'], intel: ['intel.com'], tsmc: ['tsmc.com'],
  google: ['google.com'], microsoft: ['microsoft.com'], 'federal-reserve': ['federalreserve.gov'], sec: ['sec.gov'],
  oecd: ['oecd.org'], unesco: ['unesco.org'], 'international-baccalaureate': ['ibo.org'], 'united-nations': ['un.org'],
}

export function verificationDomainsForEvent(event: NewsEvent) {
  if (event.evidence.primarySourcePresent) return INDEPENDENT_MEDIA_DOMAINS
  const text = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const entityDomains = extractEntities(text).flatMap((entity) => ENTITY_OFFICIAL_DOMAINS[entity] ?? [])
  return [...new Set([...entityDomains, ...OFFICIAL_VERIFICATION_DOMAINS[event.domain]])].slice(0, 8)
}

export function buildVerificationQuery(event: NewsEvent) {
  const text = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const entities = extractEntities(text).filter((entity) => !/archive|news|latest|report/i.test(entity)).slice(0, 3)
  const actions = [...extractActions(text)].slice(0, 2)
  const objects = [...extractEventObjects(text)].slice(0, 2)
  const numbers = extractKeyNumbers(text).slice(0, 3).map(keyNumberQueryLabel)
  const date = Number.isFinite(new Date(event.publishedAt).getTime()) ? event.publishedAt.slice(0, 10) : ''
  return [...entities, ...actions, ...objects, ...numbers, date]
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
  const includeDomains = verificationDomainsForEvent(event)
  const hits = await runtime.search(
    query,
    8,
    { ...searchOptionsForDomain(event.domain, now, query), includeDomains },
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
    const hostname = normalizedHostname(candidate.url)
    const sourceTargeted = includeDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    const compatibility = assessEventMatch(event.primaryArticle, candidate, true)
    const accepted = !duplicateUrl && sourceTargeted && compatibility.matched
    onDecision?.({
      ...assessment.decision,
      accepted,
      reason: accepted ? 'accepted' : duplicateUrl ? 'duplicate-url' : !sourceTargeted ? 'source-target-mismatch' : compatibility.reason,
    })
    return accepted ? [candidate] : []
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
  const evidencePriority = { confirmed: -20, corroborated: -12, 'single-source': 24, unverified: 16 }
  for (const domain of DOMAIN_ORDER) {
    const ranked = events
      .filter((event) => event.domain === domain)
      .sort((a, b) => (b.primaryArticle.score + evidencePriority[b.evidence.level])
        - (a.primaryArticle.score + evidencePriority[a.evidence.level]) || a.id.localeCompare(b.id))
    const unresolved = ranked.filter((event) => event.evidence.level === 'single-source' || event.evidence.level === 'unverified')
    const selected = [...unresolved, ...ranked.filter((event) => !unresolved.includes(event))].slice(0, 2)
    for (const event of selected) enriched.push(await searchSecondSource(event, runtime, now, onDecision))
  }
  return enriched
}
