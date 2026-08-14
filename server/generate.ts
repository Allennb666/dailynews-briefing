import 'dotenv/config'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DailyBriefing, DailyDigest, DomainId } from '../shared/briefing.js'
import { buildDailyDigest, deduplicateAcrossDomains, validateCrossDomainUniqueness } from './editorial.js'
import { enrichImportantEvents } from './enrichment.js'
import { ArticleReader, materializeEvents } from './material.js'
import { createEditorialModelFromEnvironment, finalizeBriefing, preselectEvents } from './model.js'
import { collectCandidates, type NewsEvent } from './pipeline.js'
import { createSearchRuntimeFromEnvironment } from './search.js'
import { DOMAIN_CONFIGS, DOMAIN_ORDER } from './sources.js'

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

function previousEntities(digest: DailyDigest | null, domain: DomainId) {
  const briefing = digest?.briefings.find((item) => item.domain === domain)
  return briefing?.stories.flatMap((story) => [story.tags[0], ...story.title.split(/[：:，,、\s]/).filter((token) => token.length >= 3).slice(0, 1)])
    .filter((value): value is string => Boolean(value))
    .slice(0, 4) ?? []
}

function previousTitles(digest: DailyDigest | null, domain: DomainId) {
  return digest?.briefings.find((item) => item.domain === domain)?.stories.map((story) => story.title) ?? []
}

function eventPriority(event: NewsEvent) {
  const evidence = event.evidence.level === 'confirmed' ? 22
    : event.evidence.level === 'corroborated' ? 17
      : event.evidence.level === 'single-source' ? 3
        : -18
  const official = event.evidence.primarySourcePresent ? 8 : 0
  return event.primaryArticle.score + evidence + official
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

function summaryLines(briefings: DailyBriefing[], searchCalls: number, articleReader: ArticleReader) {
  const stories = briefings.flatMap((briefing) => briefing.stories)
  const sourceCounts = new Map<string, number>()
  for (const story of stories) sourceCounts.set(story.source.name, (sourceCounts.get(story.source.name) ?? 0) + 1)
  const qwenRetries = briefings.reduce((sum, briefing) => sum + (briefing.pipeline.qwenRetries ?? 0), 0)
  return [
    `RSS 候选：${briefings.reduce((sum, item) => sum + (item.pipeline.rssCandidates ?? 0), 0)}`,
    `搜索候选：${briefings.reduce((sum, item) => sum + (item.pipeline.searchCandidates ?? 0), 0)}`,
    `搜索调用：${searchCalls}/32`,
    `全文读取：${articleReader.succeeded}/${articleReader.attempted}（上限 30）`,
    `confirmed：${stories.filter((story) => story.evidence.level === 'confirmed').length}`,
    `corroborated：${stories.filter((story) => story.evidence.level === 'corroborated').length}`,
    `single-source：${stories.filter((story) => story.evidence.level === 'single-source').length}`,
    `unverified：${stories.filter((story) => story.evidence.level === 'unverified').length}`,
    `含官方来源：${stories.filter((story) => story.evidence.primarySourcePresent).length}`,
    `最高单一主来源集中度：${Math.max(0, ...sourceCounts.values())}/${stories.length}`,
    `Qwen 修复重试：${qwenRetries}`,
    `质量状态：${briefings.map((item) => `${item.domain}=${item.pipeline.qualityStatus ?? 'unknown'}`).join(', ')}`,
  ]
}

async function writeActionsSummary(lines: string[], published: boolean) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  await appendFile(path, `## DailyNews generation\n\n- 发布：${published ? '是' : '否（保留上一期）'}\n${lines.map((line) => `- ${line}`).join('\n')}\n`, 'utf8')
}

async function main() {
  const startedAt = new Date()
  const previous = await loadPreviousDigest()
  const searchRuntime = createSearchRuntimeFromEnvironment()
  const model = createEditorialModelFromEnvironment()
  const articleReader = new ArticleReader()
  console.log(`[DailyNews] 开始动态新闻与编辑管线：${startedAt.toISOString()}`)
  console.log(`[DailyNews] 搜索：${searchRuntime.enabled ? 'Tavily Basic' : '未配置，RSS 回退'}；模型：${model ? 'qwen3.5-27b' : '规则降级'}`)

  const collections = await Promise.all(DOMAIN_ORDER.map(async (domain) => {
    const collection = await collectCandidates(domain, startedAt, {
      searchRuntime,
      previousEntities: previousEntities(previous, domain),
      previousTitles: previousTitles(previous, domain),
    })
    console.log(`[DailyNews] ${DOMAIN_CONFIGS[domain].title}：RSS ${collection.rssCandidates ?? 0} + 搜索 ${collection.searchCandidates ?? 0}，共 ${collection.fetched} 条`)
    return collection
  }))

  const preselected = []
  for (const collection of collections) {
    const result = await preselectEvents(collection, model)
    preselected.push({ domain: collection.domain, events: result.events, warnings: result.warnings })
    console.log(`[DailyNews] ${DOMAIN_CONFIGS[collection.domain].title}：预选 ${result.events.length} 个事件（${result.usedModel ? 'Qwen' : '规则'}）`)
  }

  let selections = deduplicateAcrossDomains(preselected.map(({ domain, events }) => ({ domain, events })))
  const topForVerification = selections.flatMap((selection) => selection.events)
    .sort((a, b) => eventPriority(b) - eventPriority(a))
    .slice(0, 8)
  const enriched = await enrichImportantEvents(topForVerification, searchRuntime, startedAt)
  selections = replaceEnrichedEvents(selections, enriched)

  const materialOrder = [
    ...enriched,
    ...selections.flatMap((selection) => selection.events).filter((event) => !enriched.some((item) => item.id === event.id)),
  ]
  await materializeEvents(materialOrder, articleReader)

  const briefings: DailyBriefing[] = []
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

  const crossDomainErrors = validateCrossDomainUniqueness(briefings)
  const degraded = briefings.some((briefing) => briefing.pipeline.qualityStatus !== 'passed')
  const lines = summaryLines(briefings, searchRuntime.stats.calls, articleReader)
  lines.forEach((line) => console.log(`[DailyNews] ${line}`))
  if (crossDomainErrors.length) console.error(`[DailyNews] 跨领域门禁失败：${crossDomainErrors.join('；')}`)
  if (degraded || crossDomainErrors.length) {
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
  await writeActionsSummary(lines, true)
  console.log(`[DailyNews] 已发布 ${date}：${resolve(projectRoot, 'public/data/briefings/daily-latest.json')}`)
}

main().catch((error) => {
  console.error(`[DailyNews] 生成失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
