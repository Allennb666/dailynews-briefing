import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DomainId, EvidenceConfidence, SourceReliability } from '../shared/briefing.js'
import { titleSimilarity } from './pipeline.js'
import type { DiagnosticCandidate, DiagnosticEvent, RunDiagnostics } from './diagnostics.js'

export type BenchmarkV1 = {
  schemaVersion: 1
  id: string
  description: string
  events: Array<{
    eventId: string
    titleAliases: string[]
    entities: string[]
    actions: string[]
    keyNumbers: string[]
    date: string
    correctDomain: DomainId
    correctCluster: string
    expectedSourceTypes: Array<'official' | 'independent-media' | 'wire-copy'>
    articles: Array<{
      id: string
      title: string
      summary: string
      url: string
      publishedAt: string
      sourceType: 'official' | 'media'
      reliability: SourceReliability
    }>
  }>
}

export type OfflineEvaluation = {
  schemaVersion: 1
  runId: string
  generatedAt: string
  labels: {
    unlabelledMetrics: 'incremental-output-suspected-errors-low-confidence-only'
    benchmarkAvailable: boolean
  }
  search: {
    totalCalls: number
    queryCountByStage: Record<string, number>
    resultCountByStage: Record<string, number>
  }
  incrementalContribution: Record<string, {
    newValidEvents: number
    finalSelectedEvents: number
    supportingFinalEvents: number
  }>
  dates: {
    candidates: number
    missing: number
    missingRatio: number
    recovered: number
    recoveredRatioAmongMissing: number
    expired: number
    futureDated: number
    unresolved: number
    conflictEvents: number
    conflictRatio: number
  }
  evidence: {
    finalEvents: number
    officialEventRatio: number
    levels: Record<EvidenceConfidence, { count: number; ratio: number }>
    verificationAttempts: number
    verificationUpgrades: number
    verificationUpgradeRatio: number
  }
  diversity: {
    maxPrimarySourceConcentration: number
    primarySourceCounts: Record<string, number>
  }
  warnings: {
    lowConfidenceOwnership: number
    suspectedFalseMerges: number
    suspectedMissedMerges: number
    highConfidenceSyndicationPairs: number
    mediumConfidenceSyndicationWarnings: number
    duplicateUrlRatio: number
    duplicateContentRatio: number
  }
  contentQuality: {
    repeatedSummaryCount: number
    noNewFactSummaryCount: number
    titleSummaryMismatchCount: number
    crossEventSourceCount: number
    htmlArtifactCount: number
    englishFragmentCount: number
  }
  benchmarkMetrics?: {
    benchmarkId: string
    candidateRecall: number
    finalRecall: number
    clusteringPrecision: number
    clusteringRecall: number
    domainAssignmentAccuracy: number
    expectedSourceTypeCoverage: number
  }
}

const STAGES = ['rss', 'base-search', 'dynamic-search', 'verification-search'] as const
const EVIDENCE_ORDER: EvidenceConfidence[] = ['unverified', 'single-source', 'corroborated', 'confirmed']

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function stageForDecision(stage: string) {
  return stage === 'rss' ? 'rss' : `${stage}-search`
}

function eventLookup(diagnostics: RunDiagnostics) {
  const events = new Map(diagnostics.clusters.map((event) => [event.id, event]))
  for (const verification of diagnostics.verification) events.set(verification.eventId, verification.eventAfter)
  return events
}

function candidateStageMap(diagnostics: RunDiagnostics) {
  const map = new Map<string, string>(diagnostics.candidatesAfterDateRecovery.map((candidate) => [candidate.id, candidate.discoveryStage]))
  for (const decision of diagnostics.candidateDecisions) {
    if (decision.accepted && decision.candidateId) map.set(decision.candidateId, stageForDecision(decision.stage))
  }
  return map
}

function primaryContributionStage(event: DiagnosticEvent, stages: Map<string, string>) {
  const present = new Set(event.articleIds.map((id) => stages.get(id)).filter(Boolean))
  return STAGES.find((stage) => present.has(stage)) ?? 'verification-search'
}

function finalEvidence(diagnostics: RunDiagnostics, eventId: string) {
  return diagnostics.verification.find((item) => item.eventId === eventId)?.evidenceAfter
    ?? diagnostics.clusters.find((event) => event.id === eventId)?.evidence
    ?? null
}

function pairRatio(items: DiagnosticCandidate[], key: (item: DiagnosticCandidate) => string) {
  const groups = new Map<string, number>()
  for (const item of items) groups.set(key(item), (groups.get(key(item)) ?? 0) + 1)
  const duplicateItems = [...groups.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0)
  return ratio(duplicateItems, items.length)
}

function matchingEvents(diagnostics: RunDiagnostics, benchmark: BenchmarkV1) {
  const events = [...eventLookup(diagnostics).values()]
  const candidates = diagnostics.candidatesAfterDateRecovery
  return new Map(benchmark.events.map((expected) => {
    const urls = new Set(expected.articles.map((article) => article.url.replace(/\/$/, '')))
    const candidate = candidates.find((item) => urls.has(item.url.replace(/\/$/, ''))
      || expected.titleAliases.some((alias) => titleSimilarity(alias, item.title) >= 0.64))
    const event = events.find((item) => item.articleUrls.some((url) => urls.has(url.replace(/\/$/, '')))
      || expected.titleAliases.some((alias) => titleSimilarity(alias, item.canonicalTitle) >= 0.64))
    return [expected.eventId, { candidate, event }] as const
  }))
}

function benchmarkMetrics(diagnostics: RunDiagnostics, benchmark: BenchmarkV1) {
  const matches = matchingEvents(diagnostics, benchmark)
  const candidateFound = benchmark.events.filter((event) => matches.get(event.eventId)?.candidate).length
  const finalIds = new Set(diagnostics.finalSelection.map((item) => item.eventId))
  const finalFound = benchmark.events.filter((event) => {
    const matched = matches.get(event.eventId)?.event
    return matched && finalIds.has(matched.id)
  }).length

  const articleCluster = new Map<string, string>()
  for (const event of eventLookup(diagnostics).values()) {
    for (const url of event.articleUrls) articleCluster.set(url.replace(/\/$/, ''), event.id)
  }
  const labelled = benchmark.events.flatMap((event) => event.articles.map((article) => ({
    url: article.url.replace(/\/$/, ''),
    cluster: event.correctCluster,
  }))).filter((article) => articleCluster.has(article.url))
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  for (let index = 0; index < labelled.length; index += 1) {
    for (let other = index + 1; other < labelled.length; other += 1) {
      const expectedSame = labelled[index].cluster === labelled[other].cluster
      const predictedSame = articleCluster.get(labelled[index].url) === articleCluster.get(labelled[other].url)
      if (expectedSame && predictedSame) truePositive += 1
      else if (!expectedSame && predictedSame) falsePositive += 1
      else if (expectedSame && !predictedSame) falseNegative += 1
    }
  }

  const assignedByEvent = new Map(diagnostics.ownership.map((item) => [item.eventId, item.assignedDomain]))
  const domainCases = benchmark.events.flatMap((expected) => {
    const matched = matches.get(expected.eventId)?.event
    return matched ? [{ expected, actual: assignedByEvent.get(matched.id) ?? matched.domain }] : []
  })
  const expectedTypes = benchmark.events.reduce((sum, event) => sum + event.expectedSourceTypes.length, 0)
  const coveredTypes = benchmark.events.reduce((sum, expected) => {
    const matched = matches.get(expected.eventId)?.event
    if (!matched) return sum
    const types = new Set<string>()
    if (matched.evidence.primarySourcePresent) types.add('official')
    if (matched.evidence.independentSourceCount > 0) types.add('independent-media')
    if (matched.syndication.some((item) => item.confidence === 'high')) types.add('wire-copy')
    return sum + expected.expectedSourceTypes.filter((type) => types.has(type)).length
  }, 0)
  return {
    benchmarkId: benchmark.id,
    candidateRecall: ratio(candidateFound, benchmark.events.length),
    finalRecall: ratio(finalFound, benchmark.events.length),
    clusteringPrecision: ratio(truePositive, truePositive + falsePositive),
    clusteringRecall: ratio(truePositive, truePositive + falseNegative),
    domainAssignmentAccuracy: ratio(domainCases.filter(({ expected, actual }) => expected.correctDomain === actual).length, domainCases.length),
    expectedSourceTypeCoverage: ratio(coveredTypes, expectedTypes),
  }
}

export function evaluateDiagnostics(
  diagnostics: RunDiagnostics,
  benchmark?: BenchmarkV1,
  generatedAt = new Date(),
): OfflineEvaluation {
  if (benchmark && benchmark.schemaVersion !== 1) throw new Error(`不支持 benchmark schemaVersion ${String(benchmark.schemaVersion)}`)
  const candidates = uniqueBy(diagnostics.candidatesBeforeDateRecovery, (candidate) => `${candidate.domain}:${candidate.id}`)
  const afterCandidates = uniqueBy(diagnostics.candidatesAfterDateRecovery, (candidate) => `${candidate.domain}:${candidate.id}`)
  const stages = candidateStageMap(diagnostics)
  const events = [...eventLookup(diagnostics).values()]
  const finalIds = new Set(diagnostics.finalSelection.map((item) => item.eventId))
  const contribution = Object.fromEntries(STAGES.map((stage) => [stage, {
    newValidEvents: events.filter((event) => primaryContributionStage(event, stages) === stage).length,
    finalSelectedEvents: events.filter((event) => finalIds.has(event.id) && primaryContributionStage(event, stages) === stage).length,
    supportingFinalEvents: events.filter((event) => finalIds.has(event.id) && event.articleIds.some((id) => stages.get(id) === stage)).length,
  }]))

  const missing = candidates.filter((candidate) => candidate.dateConfidence === 'unknown').length
  const recovered = diagnostics.dateRecovery.filter((item) => item.status === 'recovered').length
  const expired = diagnostics.candidateDecisions.filter((item) => item.reason === 'expired').length
    + diagnostics.dateRecovery.filter((item) => item.status === 'expired').length
  const futureDated = diagnostics.candidateDecisions.filter((item) => item.reason === 'future-dated').length
    + diagnostics.dateRecovery.filter((item) => item.status === 'future-dated').length
  const conflictEvents = events.filter((event) => event.dateConflict).length

  const evidenceCounts = Object.fromEntries(EVIDENCE_ORDER.map((level) => {
    const count = diagnostics.finalSelection.filter((item) => finalEvidence(diagnostics, item.eventId)?.level === level).length
    return [level, { count, ratio: ratio(count, diagnostics.finalSelection.length) }]
  })) as OfflineEvaluation['evidence']['levels']
  const upgrades = diagnostics.verification.filter((item) =>
    EVIDENCE_ORDER.indexOf(item.evidenceAfter.level) > EVIDENCE_ORDER.indexOf(item.evidenceBefore.level)).length

  const sourceCounts = new Map<string, number>()
  for (const item of diagnostics.finalSelection) {
    const source = item.primarySourceId ?? 'unknown-source'
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
  }
  const syndication = events.flatMap((event) => event.syndication)
  const evaluation: OfflineEvaluation = {
    schemaVersion: 1,
    runId: diagnostics.runId,
    generatedAt: generatedAt.toISOString(),
    labels: {
      unlabelledMetrics: 'incremental-output-suspected-errors-low-confidence-only',
      benchmarkAvailable: Boolean(benchmark),
    },
    search: {
      totalCalls: diagnostics.search.calls,
      queryCountByStage: Object.fromEntries(STAGES.map((stage) => [stage, diagnostics.search.traces.filter((trace) =>
        stageForDecision(trace.phase ?? '') === stage && ['completed', 'cache-hit'].includes(trace.outcome)).length])),
      resultCountByStage: Object.fromEntries(STAGES.map((stage) => [stage, diagnostics.search.traces.filter((trace) =>
        stageForDecision(trace.phase ?? '') === stage).reduce((sum, trace) => sum + trace.resultCount, 0)])),
    },
    incrementalContribution: contribution,
    dates: {
      candidates: candidates.length,
      missing,
      missingRatio: ratio(missing, candidates.length),
      recovered,
      recoveredRatioAmongMissing: ratio(recovered, missing),
      expired,
      futureDated,
      unresolved: afterCandidates.filter((candidate) => candidate.dateConfidence === 'unknown').length,
      conflictEvents,
      conflictRatio: ratio(conflictEvents, events.length),
    },
    evidence: {
      finalEvents: diagnostics.finalSelection.length,
      officialEventRatio: ratio(diagnostics.finalSelection.filter((item) => finalEvidence(diagnostics, item.eventId)?.primarySourcePresent).length, diagnostics.finalSelection.length),
      levels: evidenceCounts,
      verificationAttempts: diagnostics.verification.length,
      verificationUpgrades: upgrades,
      verificationUpgradeRatio: ratio(upgrades, diagnostics.verification.length),
    },
    diversity: {
      maxPrimarySourceConcentration: ratio(Math.max(0, ...sourceCounts.values()), diagnostics.finalSelection.length),
      primarySourceCounts: Object.fromEntries([...sourceCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    warnings: {
      lowConfidenceOwnership: diagnostics.ownership.filter((item) => item.lowConfidence).length,
      suspectedFalseMerges: events.filter((event) => event.suspectedFalseMergeReasons.length).length,
      suspectedMissedMerges: diagnostics.suspectedMissedMerges.length,
      highConfidenceSyndicationPairs: syndication.filter((item) => item.confidence === 'high').length,
      mediumConfidenceSyndicationWarnings: syndication.filter((item) => item.confidence === 'medium').length,
      duplicateUrlRatio: pairRatio(afterCandidates, (candidate) => candidate.url),
      duplicateContentRatio: pairRatio(afterCandidates, (candidate) => `${candidate.titleFingerprint}:${candidate.snippetFingerprint}`),
    },
    contentQuality: diagnostics.contentQuality ?? {
      repeatedSummaryCount: 0,
      noNewFactSummaryCount: 0,
      titleSummaryMismatchCount: 0,
      crossEventSourceCount: 0,
      htmlArtifactCount: 0,
      englishFragmentCount: 0,
    },
    ...(benchmark ? { benchmarkMetrics: benchmarkMetrics(diagnostics, benchmark) } : {}),
  }
  return evaluation
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

export function renderEvaluationMarkdown(evaluation: OfflineEvaluation) {
  const lines = [
    '# DailyNews 离线诊断',
    '',
    `- 运行：${evaluation.runId}`,
    `- 搜索调用：${evaluation.search.totalCalls}/32`,
    `- 日期缺失：${evaluation.dates.missing}/${evaluation.dates.candidates}（${percent(evaluation.dates.missingRatio)}）`,
    `- 日期恢复：${evaluation.dates.recovered}，过期：${evaluation.dates.expired}，冲突事件：${evaluation.dates.conflictEvents}`,
    `- 最终事件含官方来源：${percent(evaluation.evidence.officialEventRatio)}`,
    `- 验证升级：${evaluation.evidence.verificationUpgrades}/${evaluation.evidence.verificationAttempts}（${percent(evaluation.evidence.verificationUpgradeRatio)}）`,
    `- 最高主来源集中度：${percent(evaluation.diversity.maxPrimarySourceConcentration)}`,
    `- 摘要重复标题 / 无新增事实：${evaluation.contentQuality.repeatedSummaryCount} / ${evaluation.contentQuality.noNewFactSummaryCount}`,
    `- 标题摘要错配 / 跨事件来源：${evaluation.contentQuality.titleSummaryMismatchCount} / ${evaluation.contentQuality.crossEventSourceCount}`,
    `- HTML 残片 / 英文残句：${evaluation.contentQuality.htmlArtifactCount} / ${evaluation.contentQuality.englishFragmentCount}`,
    '',
    '## 各阶段增量产出',
    '',
    '| 阶段 | 新增有效事件 | 最终入选贡献 | 为最终事件补充材料 |',
    '| --- | ---: | ---: | ---: |',
    ...STAGES.map((stage) => {
      const item = evaluation.incrementalContribution[stage]
      return `| ${stage} | ${item.newValidEvents} | ${item.finalSelectedEvents} | ${item.supportingFinalEvents} |`
    }),
    '',
    '## 疑似问题与低置信度',
    '',
    `- 跨领域低置信归属：${evaluation.warnings.lowConfidenceOwnership}`,
    `- 疑似误合并：${evaluation.warnings.suspectedFalseMerges}`,
    `- 疑似漏合并：${evaluation.warnings.suspectedMissedMerges}`,
    `- 高置信同源转载对：${evaluation.warnings.highConfidenceSyndicationPairs}`,
    `- 中等置信转载警告：${evaluation.warnings.mediumConfidenceSyndicationWarnings}`,
    `- 规范 URL 重复比例：${percent(evaluation.warnings.duplicateUrlRatio)}`,
    `- 内容指纹重复比例：${percent(evaluation.warnings.duplicateContentRatio)}`,
  ]
  if (evaluation.benchmarkMetrics) {
    lines.push(
      '',
      `## Benchmark：${evaluation.benchmarkMetrics.benchmarkId}`,
      '',
      `- 候选召回率：${percent(evaluation.benchmarkMetrics.candidateRecall)}`,
      `- 最终召回率：${percent(evaluation.benchmarkMetrics.finalRecall)}`,
      `- 聚类 Precision / Recall：${percent(evaluation.benchmarkMetrics.clusteringPrecision)} / ${percent(evaluation.benchmarkMetrics.clusteringRecall)}`,
      `- 领域归属准确率：${percent(evaluation.benchmarkMetrics.domainAssignmentAccuracy)}`,
      `- 期望来源类型覆盖：${percent(evaluation.benchmarkMetrics.expectedSourceTypeCoverage)}`,
    )
  } else {
    lines.push('', '> 本报告没有标注 benchmark，只报告增量产出、疑似错误和低置信度，不计算召回率或准确率。')
  }
  return `${lines.join('\n')}\n`
}

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const input = resolve(option('--input') ?? '.diagnostics/latest.json')
  const output = resolve(option('--output') ?? '.diagnostics/reports')
  const benchmarkPath = option('--benchmark')
  const diagnostics = JSON.parse(await readFile(input, 'utf8')) as RunDiagnostics
  const benchmark = benchmarkPath ? JSON.parse(await readFile(resolve(benchmarkPath), 'utf8')) as BenchmarkV1 : undefined
  const evaluation = evaluateDiagnostics(diagnostics, benchmark)
  const markdown = renderEvaluationMarkdown(evaluation)
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(resolve(output, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8'),
    writeFile(resolve(output, 'evaluation.md'), markdown, 'utf8'),
  ])
  if (process.argv.includes('--summary') && process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`, 'utf8')
  }
  console.log(`[DailyNews] 离线诊断已写入 ${output}`)
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (direct) main().catch((error) => {
  console.error(`[DailyNews] 离线诊断失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
