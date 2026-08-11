import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DailyDigest } from '../shared/briefing.js'
import { buildBriefing } from './model.js'
import { collectCandidates } from './pipeline.js'
import { DOMAIN_CONFIGS, DOMAIN_ORDER } from './sources.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const startedAt = new Date()
  console.log(`[DailyNews] 开始生成四领域简报：${startedAt.toISOString()}`)

  const collections = await Promise.all(DOMAIN_ORDER.map(async (domain) => {
    const collection = await collectCandidates(domain, startedAt)
    console.log(`[DailyNews] ${DOMAIN_CONFIGS[domain].title}：${collection.fetched} 条候选，${collection.sourceCount} 个有效来源`)
    return collection
  }))

  const briefings = []
  for (const collection of collections) {
    const title = DOMAIN_CONFIGS[collection.domain].title
    console.log(`[DailyNews] 正在整理：${title}`)
    const briefing = await buildBriefing(collection, startedAt)
    briefings.push(briefing)
    console.log(`[DailyNews] 已完成：${title}，模式 ${briefing.mode}`)
  }

  const date = briefings[0].date
  const digest: DailyDigest = {
    schemaVersion: 2,
    date,
    generatedAt: startedAt.toISOString(),
    briefings,
    topStories: briefings.slice(0, 3).map((briefing) => ({ domain: briefing.domain, storyId: briefing.stories[0].id })),
  }

  await Promise.all([
    writeJson(resolve(projectRoot, 'public/data/briefings/daily-latest.json'), digest),
    writeJson(resolve(projectRoot, `data/briefings/${date}-daily.json`), digest),
    ...briefings.flatMap((briefing) => [
      writeJson(resolve(projectRoot, `public/data/briefings/${briefing.domain}-latest.json`), briefing),
      writeJson(resolve(projectRoot, `data/briefings/${date}-${briefing.domain}.json`), briefing),
    ]),
  ])

  const fetched = briefings.reduce((total, briefing) => total + briefing.pipeline.fetched, 0)
  const warnings = briefings.flatMap((briefing) => briefing.pipeline.warnings.map((warning) => `${briefing.domainTitle}：${warning}`))
  console.log(`[DailyNews] 四领域共生成 ${briefings.length * 5} 条重点，处理 ${fetched} 条候选`)
  console.log(`[DailyNews] 网页数据：${resolve(projectRoot, 'public/data/briefings/daily-latest.json')}`)
  if (warnings.length) console.warn(`[DailyNews] 提醒：${warnings.join('；')}`)
}

main().catch((error) => {
  console.error(`[DailyNews] 生成失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
