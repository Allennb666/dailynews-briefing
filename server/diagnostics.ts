import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DailyBriefing, DomainId, EventEvidence } from '../shared/briefing.js'
import {
  cleanUrl,
  clusterCandidates,
  compareCandidates,
  crossDomainEventMatch,
  deduplicateCandidates,
  diagnoseSyndication,
  eventDomainFit,
  extractActions,
  extractEntities,
  extractKeyNumbers,
  titleSimilarity,
  type Candidate,
  type CandidateDecision,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'
import type { DateRecoveryRecord } from './material.js'
import { normalizedHostname, type SearchRuntime, type SearchTrace } from './search.js'
import { DOMAIN_ORDER } from './sources.js'

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const

export type DiagnosticCandidate = {
  id: string
  domain: DomainId
  title: string
  url: string
  source: { id: string; name: string; type: 'official' | 'media'; reliability: string }
  publishedAt: string | null
  dateConfidence: 'reliable' | 'unknown'
  score: number
  relevanceScore: number | null
  discoveryStage: 'rss' | 'base-search' | 'dynamic-search' | 'verification-search'
  discoveryMethod: Candidate['discoveryMethod']
  query: string | null
  titleFingerprint: string
  snippetFingerprint: string
}

export type DiagnosticEvent = {
  id: string
  domain: DomainId
  canonicalTitle: string
  articleIds: string[]
  articleUrls: string[]
  entities: string[]
  actions: string[]
  keyNumbers: string[]
  publishedAt: string
  latestUpdateAt: string
  evidence: EventEvidence
  dateConflict: NewsEvent['dateConflict'] | null
  syndication: ReturnType<typeof diagnoseSyndication>['findings']
  suspectedFalseMergeReasons: string[]
}

export type DomainOwnershipDiagnostic = {
  eventId: string
  memberEventIds: string[]
  originalDomains: DomainId[]
  assignedDomain: DomainId | null
  domainFits: Array<{ domain: DomainId; score: number }>
  confidenceMargin: number
  lowConfidence: boolean
}

export type RunDiagnostics = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  runId: string
  startedAt: string
  completedAt: string
  status: 'succeeded' | 'held' | 'failed'
  published: boolean
  error: string | null
  search: {
    calls: number
    cacheHits: number
    failures: number
    exhausted: boolean
    traces: SearchTrace[]
  }
  candidateDecisions: CandidateDecision[]
  candidateDispositions: Array<{
    domain: DomainId
    candidateId: string
    eventId: string | null
    outcome: 'selected' | 'retained' | 'eliminated'
    reason: 'final-selected' | 'preselected-not-final' | 'not-preselected' | 'unknown-date-no-event' | 'date-recovery-rejected'
  }>
  candidatesBeforeDateRecovery: DiagnosticCandidate[]
  candidatesAfterDateRecovery: DiagnosticCandidate[]
  dateRecovery: DateRecoveryRecord[]
  clusters: DiagnosticEvent[]
  suspectedMissedMerges: Array<{ leftEventId: string; rightEventId: string; reasons: string[] }>
  preselected: Array<{ domain: DomainId; eventIds: string[] }>
  ownership: DomainOwnershipDiagnostic[]
  verification: Array<{
    domain: DomainId
    eventId: string
    evidenceBefore: EventEvidence
    evidenceAfter: EventEvidence
    addedArticleIds: string[]
    eventAfter: DiagnosticEvent
  }>
  finalSelection: Array<{ domain: DomainId; eventId: string; rank: number; primarySourceId: string | null }>
  qualityWarnings: string[]
}

function fingerprint(value: string) {
  const normalized = value.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

function discoveryStage(candidate: Candidate): DiagnosticCandidate['discoveryStage'] {
  if (candidate.discoveryMethod === 'rss') return 'rss'
  if (candidate.searchPhase === 'verification') return 'verification-search'
  if (candidate.searchPhase === 'dynamic') return 'dynamic-search'
  return 'base-search'
}

export function diagnosticCandidate(candidate: Candidate): DiagnosticCandidate {
  return {
    id: candidate.id,
    domain: candidate.domain,
    title: candidate.title,
    url: cleanUrl(candidate.url),
    source: {
      id: candidate.source.id,
      name: candidate.source.name,
      type: candidate.source.type,
      reliability: candidate.source.reliability,
    },
    publishedAt: candidate.dateConfidence === 'unknown' || !candidate.publishedAt ? null : candidate.publishedAt,
    dateConfidence: candidate.dateConfidence ?? 'reliable',
    score: Math.round(candidate.score * 100) / 100,
    relevanceScore: candidate.relevanceScore == null ? null : Math.round(candidate.relevanceScore * 100) / 100,
    discoveryStage: discoveryStage(candidate),
    discoveryMethod: candidate.discoveryMethod,
    query: candidate.query ?? null,
    titleFingerprint: fingerprint(candidate.title),
    snippetFingerprint: fingerprint(candidate.description),
  }
}

function eventText(event: NewsEvent) {
  return event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
}

function falseMergeReasons(event: NewsEvent) {
  const reasons: string[] = []
  for (let index = 0; index < event.articles.length; index += 1) {
    for (let other = index + 1; other < event.articles.length; other += 1) {
      const left = event.articles[index]
      const right = event.articles[other]
      const leftActions = extractActions(`${left.title} ${left.description}`)
      const rightActions = extractActions(`${right.title} ${right.description}`)
      const leftNumbers = new Set(extractKeyNumbers(`${left.title} ${left.description}`))
      const rightNumbers = new Set(extractKeyNumbers(`${right.title} ${right.description}`))
      if (leftActions.size && rightActions.size && ![...leftActions].some((action) => rightActions.has(action))) reasons.push('conflicting-actions')
      if (leftNumbers.size && rightNumbers.size && ![...leftNumbers].some((number) => rightNumbers.has(number))) reasons.push('conflicting-key-numbers')
    }
  }
  if (event.dateConflict) reasons.push('published-time-conflict')
  return [...new Set(reasons)].sort()
}

export function diagnosticEvent(event: NewsEvent): DiagnosticEvent {
  const text = eventText(event)
  const syndication = diagnoseSyndication(event.articles)
  return {
    id: event.id,
    domain: event.domain,
    canonicalTitle: event.canonicalTitle,
    articleIds: event.articles.map((article) => article.id).sort(),
    articleUrls: event.articles.map((article) => cleanUrl(article.url)).sort(),
    entities: extractEntities(text).sort(),
    actions: [...extractActions(text)].sort(),
    keyNumbers: extractKeyNumbers(text).sort(),
    publishedAt: event.publishedAt,
    latestUpdateAt: event.latestUpdateAt,
    evidence: { ...event.evidence },
    dateConflict: event.dateConflict ?? null,
    syndication: syndication.findings,
    suspectedFalseMergeReasons: falseMergeReasons(event),
  }
}

function suspectedMissedMerges(events: NewsEvent[]) {
  const warnings: RunDiagnostics['suspectedMissedMerges'] = []
  for (let index = 0; index < events.length; index += 1) {
    for (let other = index + 1; other < events.length; other += 1) {
      const left = events[index]
      const right = events[other]
      if (left.domain !== right.domain) continue
      const entityOverlap = left.entities.some((entity) => right.entities.includes(entity))
      const leftActions = extractActions(eventText(left))
      const rightActions = extractActions(eventText(right))
      const actionOverlap = [...leftActions].some((action) => rightActions.has(action))
      const titleScore = titleSimilarity(left.canonicalTitle, right.canonicalTitle)
      const timeDistance = Math.abs(new Date(left.publishedAt).getTime() - new Date(right.publishedAt).getTime()) / 3_600_000
      if (entityOverlap && actionOverlap && titleScore >= 0.32 && timeDistance <= 72) {
        warnings.push({
          leftEventId: left.id,
          rightEventId: right.id,
          reasons: ['shared-entity', 'shared-action', 'similar-title', 'close-date'],
        })
      }
    }
  }
  return warnings.sort((left, right) => left.leftEventId.localeCompare(right.leftEventId) || left.rightEventId.localeCompare(right.rightEventId))
}

function redactSecrets(value: string) {
  let result = value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:tvly|sk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) || !secret || secret.length < 6) continue
    result = result.split(secret).join('[REDACTED]')
  }
  return result
}

function redact(value: string) {
  return redactSecrets(value).slice(0, 1_000)
}

function uniqueCandidates(collections: CollectionResult[]) {
  const byKey = new Map<string, Candidate>()
  for (const candidate of collections.flatMap((collection) => collection.candidates).sort(compareCandidates)) {
    byKey.set(`${candidate.domain}:${candidate.id}`, candidate)
  }
  return [...byKey.values()].map(diagnosticCandidate)
    .sort((left, right) => left.domain.localeCompare(right.domain) || left.id.localeCompare(right.id))
}

function allClusters(collections: CollectionResult[]) {
  return collections.flatMap((collection) => clusterCandidates(deduplicateCandidates(collection.candidates)))
    .sort((left, right) => left.domain.localeCompare(right.domain) || left.id.localeCompare(right.id))
}

function eventUrls(event: NewsEvent) {
  return new Set(event.articles.map((article) => cleanUrl(article.url)))
}

export class DiagnosticRecorder {
  readonly runId: string
  readonly startedAt: string
  private decisions: CandidateDecision[] = []
  private candidatesBefore: DiagnosticCandidate[] = []
  private candidatesAfter: DiagnosticCandidate[] = []
  private clusters: NewsEvent[] = []
  private preselected: RunDiagnostics['preselected'] = []
  private ownership: DomainOwnershipDiagnostic[] = []
  private verification: RunDiagnostics['verification'] = []
  private finalSelection: RunDiagnostics['finalSelection'] = []
  private qualityWarnings: string[] = []

  constructor(startedAt = new Date()) {
    this.startedAt = startedAt.toISOString()
    this.runId = `${this.startedAt.replace(/[:.]/g, '-')}-${process.env.GITHUB_RUN_ID ?? 'local'}`
  }

  recordDecision = (decision: CandidateDecision) => {
    this.decisions.push({ ...decision })
  }

  captureBeforeDateRecovery(collections: CollectionResult[]) {
    this.candidatesBefore = uniqueCandidates(collections)
  }

  captureAfterDateRecovery(collections: CollectionResult[]) {
    this.candidatesAfter = uniqueCandidates(collections)
    this.clusters = allClusters(collections)
  }

  capturePreselected(selections: Array<{ domain: DomainId; events: NewsEvent[] }>) {
    this.preselected = selections.map((selection) => ({
      domain: selection.domain,
      eventIds: selection.events.map((event) => event.id).sort(),
    })).sort((left, right) => DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain))
  }

  captureOwnership(
    before: Array<{ domain: DomainId; events: NewsEvent[] }>,
    after: Array<{ domain: DomainId; events: NewsEvent[] }>,
  ) {
    const beforeEvents = before.flatMap((selection) => selection.events.map((event) => ({ domain: selection.domain, event })))
    const afterEvents = after.flatMap((selection) => selection.events.map((event) => ({ domain: selection.domain, event })))
    const groups: Array<typeof beforeEvents> = []
    for (const reference of beforeEvents) {
      const group = groups.find((members) => members.some((member) =>
        member.domain !== reference.domain && crossDomainEventMatch(member.event, reference.event)))
      if (group) group.push(reference)
      else groups.push([reference])
    }
    this.ownership = groups.map((group) => {
      const urls = new Set(group.flatMap((item) => [...eventUrls(item.event)]))
      const assigned = afterEvents.find((item) => [...eventUrls(item.event)].some((url) => urls.has(url))) ?? null
      const representative = assigned?.event ?? group[0].event
      const domainFits = DOMAIN_ORDER.map((domain) => ({ domain, score: Math.round(eventDomainFit(representative, domain) * 100) / 100 }))
        .sort((left, right) => right.score - left.score || DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain))
      const confidenceMargin = Math.round(((domainFits[0]?.score ?? 0) - (domainFits[1]?.score ?? 0)) * 100) / 100
      return {
        eventId: assigned?.event.id ?? group[0].event.id,
        memberEventIds: group.map((item) => item.event.id).sort(),
        originalDomains: [...new Set(group.map((item) => item.domain))].sort((left, right) => DOMAIN_ORDER.indexOf(left) - DOMAIN_ORDER.indexOf(right)),
        assignedDomain: assigned?.domain ?? null,
        domainFits,
        confidenceMargin,
        lowConfidence: confidenceMargin < 5,
      }
    }).sort((left, right) => left.eventId.localeCompare(right.eventId))
  }

  captureVerification(before: NewsEvent[], after: NewsEvent[]) {
    const beforeById = new Map(before.map((event) => [event.id, event]))
    this.verification = after.map((event) => {
      const previous = beforeById.get(event.id) ?? event
      const previousIds = new Set(previous.articles.map((article) => article.id))
      return {
        domain: event.domain,
        eventId: event.id,
        evidenceBefore: { ...previous.evidence },
        evidenceAfter: { ...event.evidence },
        addedArticleIds: event.articles.map((article) => article.id).filter((id) => !previousIds.has(id)).sort(),
        eventAfter: diagnosticEvent(event),
      }
    }).sort((left, right) => DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain) || left.eventId.localeCompare(right.eventId))
  }

  captureFinal(briefings: DailyBriefing[], warnings: string[] = []) {
    this.finalSelection = briefings.flatMap((briefing) => briefing.stories.map((story) => ({
      domain: briefing.domain,
      eventId: story.eventId,
      rank: story.rank,
      primarySourceId: story.url ? normalizedHostname(story.url) : null,
    }))).sort((left, right) => DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain) || left.rank - right.rank)
    this.qualityWarnings = warnings.map(redact).sort()
  }

  build(
    runtime: SearchRuntime,
    recovery: DateRecoveryRecord[],
    status: RunDiagnostics['status'],
    published: boolean,
    error: unknown = null,
    completedAt = new Date(),
  ): RunDiagnostics {
    const afterIds = new Set<string>(this.candidatesAfter.map((candidate) => `${candidate.domain}:${candidate.id}`))
    const finalIds = new Set(this.finalSelection.map((item) => item.eventId))
    const preselectedIds = new Set(this.preselected.flatMap((item) => item.eventIds))
    const ownershipByMember = new Map(this.ownership.flatMap((item) => item.memberEventIds.map((id) => [id, item.eventId] as const)))
    const eventByCandidate = new Map<string, string>(this.clusters.flatMap((event) => event.articles.map((article) => [
      `${article.domain}:${article.id}`,
      event.id,
    ] as const)))
    const candidateDispositions = this.candidatesBefore.map((candidate) => {
      const key = `${candidate.domain}:${candidate.id}`
      const originalEventId = eventByCandidate.get(key) ?? null
      const eventId = originalEventId ? ownershipByMember.get(originalEventId) ?? originalEventId : null
      if (!afterIds.has(key)) return {
        domain: candidate.domain,
        candidateId: candidate.id,
        eventId,
        outcome: 'eliminated' as const,
        reason: 'date-recovery-rejected' as const,
      }
      if (!eventId) return {
        domain: candidate.domain,
        candidateId: candidate.id,
        eventId: null,
        outcome: 'eliminated' as const,
        reason: 'unknown-date-no-event' as const,
      }
      if (finalIds.has(eventId)) return {
        domain: candidate.domain,
        candidateId: candidate.id,
        eventId,
        outcome: 'selected' as const,
        reason: 'final-selected' as const,
      }
      if (preselectedIds.has(originalEventId ?? eventId)) return {
        domain: candidate.domain,
        candidateId: candidate.id,
        eventId,
        outcome: 'retained' as const,
        reason: 'preselected-not-final' as const,
      }
      return {
        domain: candidate.domain,
        candidateId: candidate.id,
        eventId,
        outcome: 'eliminated' as const,
        reason: 'not-preselected' as const,
      }
    }).sort((left, right) => left.domain.localeCompare(right.domain) || left.candidateId.localeCompare(right.candidateId))
    return {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      runId: this.runId,
      startedAt: this.startedAt,
      completedAt: completedAt.toISOString(),
      status,
      published,
      error: error == null ? null : redact(error instanceof Error ? error.message : String(error)),
      search: {
        calls: runtime.stats.calls,
        cacheHits: runtime.stats.cacheHits,
        failures: runtime.stats.failures,
        exhausted: runtime.stats.exhausted,
        traces: [...runtime.traces].sort((left, right) =>
          (left.domain ?? '').localeCompare(right.domain ?? '')
          || (left.phase ?? '').localeCompare(right.phase ?? '')
          || left.query.localeCompare(right.query)),
      },
      candidateDecisions: [...this.decisions].sort((left, right) =>
        left.domain.localeCompare(right.domain) || left.stage.localeCompare(right.stage)
        || left.url.localeCompare(right.url) || left.title.localeCompare(right.title)),
      candidateDispositions,
      candidatesBeforeDateRecovery: this.candidatesBefore,
      candidatesAfterDateRecovery: this.candidatesAfter,
      dateRecovery: [...recovery].sort((left, right) => left.url.localeCompare(right.url) || left.domain.localeCompare(right.domain)),
      clusters: this.clusters.map(diagnosticEvent),
      suspectedMissedMerges: suspectedMissedMerges(this.clusters),
      preselected: this.preselected,
      ownership: this.ownership,
      verification: this.verification,
      finalSelection: this.finalSelection,
      qualityWarnings: this.qualityWarnings,
    }
  }

  async write(directory: string, diagnostics: RunDiagnostics) {
    const runsDirectory = resolve(directory, 'runs')
    await mkdir(runsDirectory, { recursive: true })
    const json = `${redactSecrets(JSON.stringify(diagnostics, null, 2))}\n`
    await Promise.all([
      writeFile(resolve(runsDirectory, `${this.runId}.json`), json, 'utf8'),
      writeFile(resolve(directory, 'latest.json'), json, 'utf8'),
    ])
  }
}
