import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DomainId, SourceReliability } from '../shared/briefing.js'
import type { EditorialModel, ModelBriefing } from './model.js'
import { finalizeBriefing, validateBriefing } from './model.js'
import {
  buildEventSpecificContent,
  buildRulesBriefing,
  createEvent,
  isPlaceholderSummary,
  isPlaceholderTitle,
  type Candidate,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/content-quality-v1.json')

type ContentFixture = {
  nvidiaFinancing: { title: string; description: string; secondaryTitle: string }
  skHynixExpansion: { title: string; description: string }
  englishSource: { title: string; description: string }
  placeholderTitle: string
  placeholderSummary: string
  placeholderNumeric: string
  unsupportedNumericFact: string
}

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as ContentFixture
}

function source(id: string, reliability: SourceReliability = 'tier-1') {
  return {
    id,
    name: id,
    url: `https://${id}`,
    type: reliability === 'primary' ? 'official' as const : 'media' as const,
    reliability,
    weight: 40,
    focused: true,
  }
}

function candidate(id: string, title: string, description: string, sourceId: string, domain: DomainId = 'ai-tech', reliability: SourceReliability = 'tier-1'): Candidate {
  return {
    id,
    domain,
    title,
    description,
    url: `https://${sourceId}/${id}`,
    publishedAt: '2026-08-15T08:00:00.000Z',
    dateConfidence: 'reliable',
    source: source(sourceId, reliability),
    score: 100,
    tags: ['AI基础设施'],
    discoveryMethod: reliability === 'primary' ? 'official-search' : 'rss',
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${sourceId}`,
  }
}

function collection(events: NewsEvent[]): CollectionResult {
  return {
    domain: 'ai-tech',
    candidates: events.flatMap((event) => event.articles),
    fetched: events.flatMap((event) => event.articles).length,
    sourceCount: new Set(events.flatMap((event) => event.articles.map((article) => article.source.id))).size,
    warnings: [],
  }
}

function auxiliaryEvents() {
  return [
    createEvent('ai-tech', [candidate('anthropic', 'Anthropic shares details about how Claude watermarks will work', 'Anthropic explains how the new Claude watermark mechanism will identify generated material.', 'techcrunch.com')]),
    createEvent('ai-tech', [candidate('openai', 'OpenAI launches a new enterprise coding agent', 'OpenAI launched an enterprise coding agent for software development teams.', 'openai.com', 'ai-tech', 'primary')]),
  ]
}

class FixedModel implements EditorialModel {
  readonly mode = 'qwen' as const
  calls = 0
  constructor(private readonly value: ModelBriefing) {}
  async complete() { this.calls += 1; return this.value }
}

function modelBriefing(events: NewsEvent[], content: ContentFixture): ModelBriefing {
  const titles = [
    'NVIDIA联合多家金融机构设立AI算力基础设施融资平台',
    content.placeholderTitle,
    content.englishSource.title,
    'Anthropic公布Claude新水印机制细节',
    'OpenAI推出企业级编程智能体',
  ]
  const summaries = [
    'NVIDIA已联合多家金融机构设立AI算力基础设施融资平台，计划为数据中心建设引入第三方资本。',
    content.placeholderSummary,
    content.placeholderNumeric,
    'Anthropic公布Claude新水印机制细节，用于识别模型生成的材料。',
    'OpenAI推出面向软件开发团队的企业级编程智能体，并开放给企业客户使用。',
  ]
  return {
    overview: '本期重点关注AI基础设施融资、内存扩产、机构持仓变化和模型产品治理。',
    keyTakeaway: '产业资本、算力供给和模型治理正在同步出现具体动作。',
    logic: '排序依据事件影响、来源质量和具体变化，并避免来源与主题过度集中。',
    newKnowledge: '同一事件的数字、动作和主体需要分别关联到可核验来源。',
    outlook: '如果投资与扩产计划继续执行，AI基础设施供给可能进一步增加。',
    trendRadar: [
      { theme: 'AI基础设施', direction: '↑', reason: '融资和扩产动作同时增加。' },
      { theme: '模型治理', direction: '→', reason: '水印机制仍需观察实际采用。' },
    ],
    watchNext: ['融资平台落地', '内存产能投放', '企业客户采用'],
    stories: events.map((event, index) => ({
      slot: index + 1,
      title: titles[index],
      summary: summaries[index],
      keyFacts: index === 0
        ? [content.unsupportedNumericFact, 'NVIDIA已联合多家金融机构设立AI算力基础设施融资平台。']
        : ['来源材料记录了该主体采取的具体行动。'],
      factSources: index === 0
        ? [
            { factIndex: 0, sourceIds: [`${event.id}-source-1`] },
            { factIndex: 1, sourceIds: [`${event.id}-source-1`] },
          ]
        : [{ factIndex: 0, sourceIds: [`${event.id}-source-1`] }],
      whyItMatters: '这一动作会影响算力供给、企业投入和相关产业链的资源配置。',
      background: 'AI基础设施建设正在从单一产品竞争扩展到资本、产能和企业采用的综合竞争。',
      impactChain: ['主体采取行动', '资源配置发生变化', '产业供给受到影响'],
      affectedParties: ['基础设施供应商', '企业客户'],
      uncertainties: '后续执行规模和实际效果仍需结合正式材料与独立来源确认。',
      glossary: [{ term: 'AI基础设施', definition: '支持模型训练和推理的算力、内存、网络及配套设施。' }],
      trend: {
        nearTerm: { condition: '如果项目按计划执行', outlook: '短期可能出现更多合作细节' },
        mediumTerm: { condition: '若资本和产能持续投入', outlook: '中期可能增加AI算力供给' },
        signalsToWatch: ['正式合同', '产能投放'],
      },
      tags: ['AI基础设施'],
    })),
  }
}

test('今日回归：NVIDIA融资与SK海力士扩产生成事件专属中文兜底', async () => {
  const content = await fixture()
  const nvidia = createEvent('ai-tech', [
    candidate('nvidia-official', content.nvidiaFinancing.title, content.nvidiaFinancing.description, 'investor.nvidia.com', 'ai-tech', 'primary'),
    candidate('nvidia-media', content.nvidiaFinancing.secondaryTitle, content.nvidiaFinancing.secondaryTitle, 'cnn.com'),
  ])
  const hynix = createEvent('ai-tech', [candidate('hynix', content.skHynixExpansion.title, content.skHynixExpansion.description, 'cnbc.com')])
  const nvidiaFallback = buildEventSpecificContent(nvidia)
  const hynixFallback = buildEventSpecificContent(hynix)
  assert.match(nvidiaFallback.title, /NVIDIA.*金融机构.*AI算力基础设施融资平台/)
  assert.match(hynixFallback.title, /SK海力士.*AI内存产能/)
  assert.ok(nvidiaFallback.summary.length >= 18)
  assert.ok(hynixFallback.summary.length >= 18)
  assert.equal(isPlaceholderTitle(nvidiaFallback.title), false)
  assert.equal(isPlaceholderSummary(hynixFallback.summary), false)
})

test('英文来源标题不会退化成来源发布相关更新模板', async () => {
  const content = await fixture()
  const event = createEvent('ai-tech', [candidate('berkshire', content.englishSource.title, content.englishSource.description, 'cnbc.com')])
  const fallback = buildEventSpecificContent(event)
  assert.equal(fallback.title, '伯克希尔增持Alphabet股份')
  assert.doesNotMatch(fallback.title, /来源|发布.*相关更新/)
  assert.match(fallback.summary, /伯克希尔.*增持/)
})

test('单个数字违规只删除对应数字，保留合格标题、摘要和其他事实', async () => {
  const content = await fixture()
  const events = [
    createEvent('ai-tech', [candidate('nvidia', content.nvidiaFinancing.description, content.nvidiaFinancing.description, 'nvidia.com', 'ai-tech', 'primary')]),
    createEvent('ai-tech', [candidate('hynix', content.skHynixExpansion.title, content.skHynixExpansion.description, 'cnbc.com')]),
    createEvent('ai-tech', [candidate('berkshire', content.englishSource.title, content.englishSource.description, 'reuters.com')]),
    ...auxiliaryEvents(),
  ]
  const value = modelBriefing(events, content)
  const expectedTitle = value.stories[0].title
  const expectedSummary = value.stories[0].summary
  const model = new FixedModel(value)
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-16T00:00:00.000Z'))
  assert.equal(model.calls, 1)
  assert.equal(briefing.pipeline.qualityStatus, 'passed', briefing.pipeline.warnings.join('；'))
  assert.equal(briefing.stories[0].title, expectedTitle)
  assert.equal(briefing.stories[0].summary, expectedSummary)
  assert.doesNotMatch(briefing.stories[0].keyFacts.join(' '), /999/)
  assert.match(briefing.stories[0].keyFacts.join(' '), /NVIDIA.*融资平台/)
  assert.ok(briefing.stories.every((story) => !isPlaceholderTitle(story.title) && !isPlaceholderSummary(story.summary)))
})

test('内容门禁拒绝两类占位文案、无主体动作和无信息摘要', async () => {
  const content = await fixture()
  const events = [
    createEvent('ai-tech', [candidate('nvidia', content.nvidiaFinancing.description, content.nvidiaFinancing.description, 'nvidia.com')]),
    createEvent('ai-tech', [candidate('hynix', content.skHynixExpansion.title, content.skHynixExpansion.description, 'cnbc.com')]),
    createEvent('ai-tech', [candidate('berkshire', content.englishSource.title, content.englishSource.description, 'reuters.com')]),
    ...auxiliaryEvents(),
  ]
  const briefing = buildRulesBriefing(collection(events), new Date('2026-08-16T00:00:00.000Z'), events.map((event) => event.id))
  briefing.stories[0] = { ...briefing.stories[0], title: content.placeholderTitle, summary: content.placeholderSummary }
  briefing.stories[1] = { ...briefing.stories[1], summary: content.placeholderNumeric }
  const errors = validateBriefing(briefing, events)
  assert.ok(errors.some((error) => error.includes('占位模板标题')))
  assert.ok(errors.filter((error) => error.includes('占位模板摘要')).length >= 2)
  assert.ok(errors.some((error) => error.includes('主体与动作')))
  assert.ok(errors.some((error) => error.includes('摘要没有')))
})
