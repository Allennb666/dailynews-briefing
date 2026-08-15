import { DOMAIN_CONFIGS } from './sources.js'
import { candidateFromSearchHit, createEvent, eventMatch, type NewsEvent } from './pipeline.js'
import { searchOptionsForDomain, type SearchRuntime } from './search.js'

export async function searchSecondSource(event: NewsEvent, runtime: SearchRuntime, now = new Date()) {
  if (!runtime.enabled || !runtime.reserveSecondSourceEvent()) return event
  const query = `"${event.canonicalTitle}" ${event.entities.slice(0, 3).join(' ')} official statement Reuters AP BBC independent verification`
  const hits = await runtime.search(query, 8, searchOptionsForDomain(event.domain, now, query))
  const additions = hits.flatMap((hit) => {
    const candidate = candidateFromSearchHit(DOMAIN_CONFIGS[event.domain], hit, query, now)
    if (!candidate || event.articles.some((article) => article.url === candidate.url)) return []
    return eventMatch(event.primaryArticle, candidate) ? [candidate] : []
  })
  return additions.length ? createEvent(event.domain, [...event.articles, ...additions]) : event
}

export async function enrichImportantEvents(
  events: NewsEvent[],
  runtime: SearchRuntime,
  now = new Date(),
) {
  const enriched: NewsEvent[] = []
  for (const event of events) enriched.push(await searchSecondSource(event, runtime, now))
  return enriched
}
