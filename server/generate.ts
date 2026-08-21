import 'dotenv/config'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DailyBriefing, DailyDigest, DomainId } from '../shared/briefing.js'
import { DiagnosticRecorder, type RunDiagnostics } from './diagnostics.js'
import { buildDailyDigest, deduplicateAcrossDomains, findCrossDomainSimilarityWarnings, validateCrossDomainUniqueness } from './editorial.js'
import { enrichImportantEvents } from './enrichment.js'
import { ArticleReader, materializeEvents, recoverMissingCandidateDates } from './material.js'
import { createEditorialModelFromEnvironment, finalizeBriefing, preselectEvents } from './model.js'
import { collectCandidates, type NewsEvent } from './pipeline.js'
import { createSearchRuntimeFromEnvironment, type SearchRuntime } from './search.js'
import { DOMAIN_CONFIGS, DOMAIN_ORDER } from './sources.js'
import { resolveCrossDomainDuplicatesWithBackups } from './stability.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function loadPreviousDigest() {
  try {
    return JSON.parse(await readFile(resolve(projectRoot, 'public/data/briefings/daily-latest.json'), 'utf8')) as DailyDigest
  } catch {
    return null
  }
}

function previousSignals(digest: DailyDigest | null, domain: DomainId) {
  const briefing = digest?.briefings.find((item) => item.domain === domain)
  if (!briefing) return []
  return [
    ...briefing.stories.flatMap((story) => [
      story.title,
      story.summary,
      ...story.keyFacts,
      ...story.trend.signalsToWatch,
    ]),
    ...briefing.watchNext,
  ].filter(Boolean)
}

function previousTitles(digest: DailyDigest | null, domain: DomainId) {
  return digest?.briefings.find((item) => item.domain === domain)?.stories.map((story) => story.title) ?? []
}

function replaceEnrichedEvents(
  selections: Array<{ domain: DomainId; events: NewsEvent[] }>,
  enriched: NewsEvent[],
) {
  const byId = new Map(enriched.map((event) => [event.id, event]))
  return selections.map((selection) => ({
    ...selection,
    events: selection.events.map((event) => byId.get(event.id) ?? event),
  }))
}

function summaryLines(briefings: DailyBriefing[], searchRuntime: SearchRuntime, articleReader: ArticleReader) {
  const stories = briefings.flatMap((briefing) => briefing.stories)
  const sourceCounts = new Map<string, number>()
  for (const story of stories) sourceCounts.set(story.source.name, (sourceCounts.get(story.source.name) ?? 0) + 1)
  const qwenRetries = briefings.reduce((sum, briefing) => sum + (briefing.pipeline.qwenRetries ?? 0), 0)
  const contentQuality = briefings.reduce((total, briefing) => {
    const current = briefing.pipeline.contentQuality
    if (!current) return total
    total.repeated += current.repeatedSummaryCount
    total.noNewFact += current.noNewFactSummaryCount
    total.mismatch += current.titleSummaryMismatchCount
    total.crossSource += current.crossEventSourceCount
    total.html += current.htmlArtifactCount
    total.english += current.englishFragmentCount
    return total
  }, { repeated: 0, noNewFact: 0, mismatch: 0, crossSource: 0, html: 0, english: 0 })
  return [
    `RSS 候选：${briefings.reduce((sum, item) => sum + (item.pipeline.rssCandidates ?? 0), 0)}`,
    `搜索候选：${briefings.reduce((sum, item) => sum + (item.pipeline.searchCandidates ?? 0), 0)}`,
    `搜索调用：${searchRuntime.stats.calls}/32`,
    `搜索分配：${DOMAIN_ORDER.map((domain) => `${domain}=${searchRuntime.callsFor(domain, 'base')}+${searchRuntime.callsFor(domain, 'dynamic')}+${searchRuntime.callsFor(domain, 'verification')}`).join(', ')}`,
    `搜索缓存命中：${searchRuntime.stats.cacheHits}`,
    `全文读取：${articleReader.succeeded}/${articleReader.attempted}（上限 30）`,
    `缺失日期恢复：${articleReader.metadataRecovered}（最多尝试 8 条高价值候选）`,
    `confirmed：${stories.filter((story) => story.evidence.level === 'confirmed').length}`,
    `corroborated：${stories.filter((story) => story.evidence.level === 'corroborated').length}`,
    `single-source：${stories.filter((story) => story.evidence.level === 'single-source').length}`,
    `unverified：${stories.filter((story) => story.evidence.level === 'unverified').length}`,
    `含官方来源：${stories.filter((story) => story.evidence.primarySourcePresent).length}`,
    `最高单一主来源集中度：${Math.max(0, ...sourceCounts.values())}/${stories.length}`,
    `Qwen 修复重试：${qwenRetries}`,
    `内容门禁：重复摘要=${contentQuality.repeated}，无新增事实=${contentQuality.noNewFact}，错配=${contentQuality.mismatch}，跨事件来源=${contentQuality.crossSource}，HTML=${contentQuality.html}，英文残句=${contentQuality.english}`,
    `质量状态：${briefings.map((item) => `${item.domain}=${item.pipeline.qualityStatus ?? 'unknown'}`).join(', ')}`,
  ]
}

async function writeActionsSummary(lines: string[], published: boolean) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  await appendFile(path, `## DailyNews generation\n\n- 发布：${published ? '是' : '否（保留上一期）'}\n${lines.map((line) => `- ${line}`).join('\n')}\n`, 'utf8')
}

async function main() {
  const replayDate = process.env.BRIEFING_REPLAY_DATE?.trim() ?? ''
  const startedAt = /^20\d{2}-\d{2}-\d{2}$/.test(replayDate)
    ? new Date(`${replayDate}T07:30:00+08:00`)
    : new Date()
  const diagnostics = new DiagnosticRecorder(startedAt)
  const searchRuntime = createSearchRuntimeFromEnvironment(fetch, startedAt)
  const articleReader = new ArticleReader()
  let diagnosticStatus: RunDiagnostics['status'] = 'failed'
  let published = false
  let diagnosticError: unknown = null
  try {
    const previous = await loadPreviousDigest()
    await searchRuntime.prepare()
    const model = createEditorialModelFromEnvironment()
    console.log(`[DailyNews] 开始动态新闻与编辑管线：${startedAt.toISOString()}`)
    console.log(`[DailyNews] 搜索：${searchRuntime.cacheReplay ? '复用当日搜索缓存（不调用 Tavily）' : searchRuntime.enabled ? 'Tavily Basic' : '未配置，RSS 回退'}；模型：${model ? 'qwen3.5-27b' : '规则降级'}`)

    const collections = await Promise.all(DOMAIN_ORDER.map(async (domain) => {
      return collectCandidates(domain, startedAt, {
        searchRuntime,
        previousSignals: previousSignals(previous, domain),
        previousTitles: previousTitles(previous, domain),
        onCandidateDecision: diagnostics.recordDecision,
      })
    }))
    diagnostics.captureBeforeDateRecovery(collections)
    const retainedAfterDateRecovery = await recoverMissingCandidateDates(
      collections.flatMap((collection) => collection.candidates),
      articleReader,
      startedAt,
    )
    const retainedCandidateIds = new Set(retainedAfterDateRecovery.map((candidate) => `${candidate.domain}:${candidate.id}`))
    for (const collection of collections) {
      collection.candidates = collection.candidates.filter((candidate) => retainedCandidateIds.has(`${candidate.domain}:${candidate.id}`))
      collection.fetched = collection.candidates.length
      collection.searchCandidates = collection.candidates.filter((candidate) => candidate.discoveryMethod !== 'rss').length
      collection.sourceCount = new Set(collection.candidates.map((candidate) => candidate.source.id)).size
    }
    diagnostics.captureAfterDateRecovery(collections)
    for (const collection of collections) {
      const domain = collection.domain
      console.log(`[DailyNews] ${DOMAIN_CONFIGS[domain].title}：RSS ${collection.rssCandidates ?? 0} + 搜索 ${collection.searchCandidates ?? 0}，共 ${collection.fetched} 条`)
    }

    const preselected = []
    for (const collection of collections) {
      const result = await preselectEvents(collection, model)
      preselected.push({ domain: collection.domain, events: result.events, warnings: result.warnings })
      console.log(`[DailyNews] ${DOMAIN_CONFIGS[collection.domain].title}：预选 ${result.events.length} 个事件（${result.usedModel ? 'Qwen' : '规则'}）`)
    }
    const beforeOwnership = preselected.map(({ domain, events }) => ({ domain, events }))
    diagnostics.capturePreselected(beforeOwnership)
    let selections = deduplicateAcrossDomains(beforeOwnership)
    diagnostics.captureOwnership(beforeOwnership, selections)
    const beforeVerification = selections.flatMap((selection) => selection.events)
    const enriched = await enrichImportantEvents(beforeVerification, searchRuntime, startedAt, diagnostics.recordDecision)
    diagnostics.captureVerification(beforeVerification, enriched)
    await searchRuntime.markCacheComplete()
    selections = replaceEnrichedEvents(selections, enriched)

    const materialOrder = [
      ...enriched,
      ...selections.flatMap((selection) => selection.events).filter((event) => !enriched.some((item) => item.id === event.id)),
    ]
    await materializeEvents(materialOrder, articleReader)

    let briefings: DailyBriefing[] = []
    for (const collection of collections) {
      const selection = selections.find((item) => item.domain === collection.domain)!
      console.log(`[DailyNews] 正在最终编辑：${DOMAIN_CONFIGS[collection.domain].title}`)
      const briefing = await finalizeBriefing(collection, selection.events, model, startedAt)
      const preselectionWarnings = preselected.find((item) => item.domain === collection.domain)?.warnings ?? []
      briefings.push({
        ...briefing,
        pipeline: {
          ...briefing.pipeline,
          searchCalls: collection.searchCalls ?? 0,
          articleFetchSuccess: articleReader.succeeded,
          warnings: [...briefing.pipeline.warnings, ...preselectionWarnings],
        },
      })
      const latest = briefings.at(-1)!
      if (latest.pipeline.warnings.length) console.warn(`[DailyNews] ${latest.domainTitle} 提醒：${latest.pipeline.warnings.join('；')}`)
    }

    const stabilized = resolveCrossDomainDuplicatesWithBackups(briefings, collections, selections, startedAt)
    briefings = stabilized.briefings
    if (stabilized.replacements.length) {
      console.warn(`[DailyNews] 跨领域重复已自动换入 ${stabilized.replacements.length} 个备用事件：${stabilized.replacements.map((item) => `${item.removedEventId}→${item.addedEventId}`).join('，')}`)
    }
    const crossDomainErrors = validateCrossDomainUniqueness(briefings, selections)
    const crossDomainWarnings = findCrossDomainSimilarityWarnings(briefings, selections)
    const degraded = briefings.some((briefing) => briefing.pipeline.qualityStatus !== 'passed')
    const lines = summaryLines(briefings, searchRuntime, articleReader)
    diagnostics.captureFinal(briefings, [
      ...briefings.flatMap((briefing) => briefing.pipeline.warnings),
      ...crossDomainWarnings,
      ...crossDomainErrors,
    ])
    lines.forEach((line) => console.log(`[DailyNews] ${line}`))
    if (crossDomainErrors.length) console.error(`[DailyNews] 跨领域门禁失败：${crossDomainErrors.join('；')}`)
    if (crossDomainWarnings.length) console.warn(`[DailyNews] 跨领域低置信相似：${crossDomainWarnings.join('；')}`)
    if (degraded || crossDomainErrors.length) {
      diagnosticStatus = 'held'
      console.error('[DailyNews] 严重质量门禁未通过；保留上一期 latest 和历史文件，不发布降级稿。')
      await writeActionsSummary([...lines, ...crossDomainErrors], false)
      process.exitCode = 2
      return
    }

    const digest = buildDailyDigest(briefings, selections, startedAt)
    const date = digest.date
    await Promise.all([
      writeJson(resolve(projectRoot, 'public/data/briefings/daily-latest.json'), digest),
      writeJson(resolve(projectRoot, `data/briefings/${date}-daily.json`), digest),
      ...briefings.flatMap((briefing) => [
        writeJson(resolve(projectRoot, `public/data/briefings/${briefing.domain}-latest.json`), briefing),
        writeJson(resolve(projectRoot, `data/briefings/${date}-${briefing.domain}.json`), briefing),
      ]),
    ])
    published = true
    diagnosticStatus = 'succeeded'
    await writeActionsSummary(lines, true)
    console.log(`[DailyNews] 已发布 ${date}：${resolve(projectRoot, 'public/data/briefings/daily-latest.json')}`)
  } catch (error) {
    diagnosticError = error
    throw error
  } finally {
    const directory = process.env.DIAGNOSTICS_DIR?.trim() || resolve(projectRoot, '.diagnostics')
    const snapshot = diagnostics.build(
      searchRuntime,
      articleReader.dateRecoveryRecords,
      diagnosticStatus,
      published,
      diagnosticError,
    )
    await diagnostics.write(directory, snapshot)
    console.log(`[DailyNews] 非公开诊断已写入 ${resolve(directory, 'latest.json')}`)
  }
}

main().catch((error) => {
  console.error(`[DailyNews] 生成失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
