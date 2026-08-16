import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DomainId, SourceReliability } from '../shared/briefing.js'
import type { EditorialModel, ModelBriefing } from './model.js'
import { contentQualityMetrics, finalizeBriefing, repairStoryContentFields, validateBriefing } from './model.js'
import {
  buildEventSpecificContent,
  buildRulesBriefing,
  cleanEventMaterial,
  createEvent,
  hasHtmlArtifact,
  hasMeaninglessEnglishFragment,
  isPlaceholderSummary,
  isPlaceholderTitle,
  summaryAddsNewInformation,
  type Candidate,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/content-quality-v1.json')
const replayFixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/content-replay-2026-08-16.json')

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
    createEvent('ai-tech', [candidate('openai', 'OpenAI launches a new enterprise coding agent', 'OpenAI launched an enterprise coding agent for software development teams and made it available to enterprise customers for collaborative development.', 'openai.com', 'ai-tech', 'primary')]),
  ]
}

class FixedModel implements EditorialModel {
  readonly mode = 'qwen' as const
  calls = 0
  constructor(private readonly value: ModelBriefing) {}
  async complete() { this.calls += 1; return this.value }
}

function modelBriefing(events: NewsEvent[], content: ContentFixture): ModelBriefing {
  const safe = events.map(buildEventSpecificContent)
  const titles = [
    safe[0].title,
    content.placeholderTitle,
    content.englishSource.title,
    'Anthropic公布Claude新水印机制细节',
    'OpenAI推出企业级编程智能体',
  ]
  const summaries = [
    'NVIDIA此次合作包括Apollo、BlackRock和Blackstone等机构，融资平台计划动员超过5000亿美元第三方资本。',
    content.placeholderSummary,
    content.placeholderNumeric,
    'Anthropic公布Claude新水印机制细节，用于识别模型生成材料，并说明后续识别方式与适用范围。',
    'OpenAI推出面向软件开发团队的企业级编程智能体，首批服务对象为需要协作开发的企业客户。',
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
        : safe[index].keyFacts,
      factSources: index === 0
        ? [
            { factIndex: 0, sourceIds: [`${event.id}-source-1`] },
            { factIndex: 1, sourceIds: [`${event.id}-source-1`] },
          ]
        : safe[index].keyFacts.map((_, factIndex) => ({ factIndex, sourceIds: [`${event.id}-source-1`] })),
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
  assert.match(nvidiaFallback.title, /NVIDIA.*AI算力基础设施融资平台/)
  assert.match(hynixFallback.title, /SK海力士.*AI内存产能/)
  assert.ok(nvidiaFallback.summary.length >= 18)
  assert.ok(hynixFallback.summary.length >= 18)
  assert.equal(isPlaceholderTitle(nvidiaFallback.title), false)
  assert.equal(isPlaceholderSummary(hynixFallback.summary), false)
  assert.equal(summaryAddsNewInformation(nvidiaFallback.title, nvidiaFallback.summary, nvidia), true)
  assert.equal(summaryAddsNewInformation(hynixFallback.title, hynixFallback.summary, hynix), true)
})

test('英文来源标题不会退化成来源发布相关更新模板', async () => {
  const content = await fixture()
  const event = createEvent('ai-tech', [candidate('berkshire', content.englishSource.title, content.englishSource.description, 'cnbc.com')])
  const fallback = buildEventSpecificContent(event)
  assert.equal(fallback.title, '伯克希尔增持Alphabet股份')
  assert.doesNotMatch(fallback.title, /来源|发布.*相关更新/)
  assert.match(fallback.summary, /Alphabet.*17 billion/)
  assert.equal(summaryAddsNewInformation(fallback.title, fallback.summary, event), true)
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
  const model = new FixedModel(value)
  const briefing = await finalizeBriefing(collection(events), events, model, new Date('2026-08-16T00:00:00.000Z'))
  assert.equal(model.calls, 1)
  assert.equal(briefing.pipeline.qualityStatus, 'passed', briefing.pipeline.warnings.join('；'))
  assert.equal(briefing.stories[0].title, expectedTitle)
  assert.equal(summaryAddsNewInformation(briefing.stories[0].title, briefing.stories[0].summary, events[0]), true)
  assert.match(briefing.stories[0].summary, /500|Apollo/)
  assert.doesNotMatch(briefing.stories[0].keyFacts.join(' '), /999/)
  assert.match(briefing.stories[0].keyFacts.join(' '), /NVIDIA.*融资平台/)
  assert.ok(briefing.stories.every((story) => !isPlaceholderTitle(story.title) && !isPlaceholderSummary(story.summary)))

  const baseline = buildRulesBriefing(collection(events), new Date('2026-08-16T00:00:00.000Z'), events.map((event) => event.id))
  const baselineStory = baseline.stories.find((story) => story.id === events[0].id)!
  const directDraft = {
    ...baselineStory,
    title: expectedTitle,
    summary: value.stories[0].summary,
    whyItMatters: value.stories[0].whyItMatters,
    keyFacts: [content.unsupportedNumericFact],
    factSources: [{ factIndex: 0, urls: [events[0].primaryArticle.url] }],
  }
  const directlyRepaired = repairStoryContentFields(directDraft, baselineStory, events[0])
  assert.equal(directlyRepaired.title, directDraft.title)
  assert.equal(directlyRepaired.summary, directDraft.summary)
  assert.equal(directlyRepaired.whyItMatters, directDraft.whyItMatters)
  assert.doesNotMatch(directlyRepaired.keyFacts.join(' '), /999/)
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

test('通用原文清洗解码实体并删除 HTML、导航、版权和残缺英文片段', () => {
  const title = 'Acme launches a new AI assessment platform'
  const dirty = '<script>steal()</script><nav>Home Menu</nav><p>Acme launched the platform for schools &amp; teachers on 2026-08-15.</p><p>Copyright all rights reserved</p><p>Fri, 08/15/2026 - broken fragment</p>'
  const cleaned = cleanEventMaterial(title, dirty, 'learning')
  assert.match(cleaned, /Acme launched.*schools & teachers/)
  assert.doesNotMatch(cleaned, /<script|Home Menu|Copyright|broken fragment/i)
  assert.equal(hasHtmlArtifact(cleaned), false)
  assert.equal(hasMeaninglessEnglishFragment('这是完整中文事实，保留 OpenAI、Claude 和 HBM 等必要术语。'), false)
  assert.equal(hasMeaninglessEnglishFragment('Fri, 08/15/2026 - this is a broken navigation fragment with no useful event context'), true)
})

test('霍尔木兹材料中的疫苗内容会在候选分段被移除，不能进入标题摘要或事实', () => {
  const title = '伊朗与阿曼推进霍尔木兹海峡通航谈判'
  const mixed = '伊朗与阿曼推进霍尔木兹海峡通航谈判，方案涉及船只许可和分阶段恢复通行。 某疫苗研究讨论自闭症与新冠接种，属于另一则健康内容。'
  const cleaned = cleanEventMaterial(title, mixed, 'world')
  assert.match(cleaned, /船只许可.*恢复通行/)
  assert.doesNotMatch(cleaned, /疫苗|自闭症|新冠/)
  const event = createEvent('world', [candidate('hormuz', title, cleaned, 'example.com', 'world')])
  const fillers = [
    createEvent('world', [candidate('world-1', '联合国启动粮食安全援助计划', '联合国启动粮食安全援助计划，首批物资于2026年8月15日运往受影响地区。', 'un.org', 'world', 'primary')]),
    createEvent('world', [candidate('world-2', '欧盟实施新的出口管制规则', '欧盟实施新的出口管制规则，执行日期为2026年8月15日，覆盖关键技术产品。', 'eu.example', 'world')]),
    createEvent('world', [candidate('world-3', '印度尼西亚开展地震救援', '印度尼西亚开展地震救援，救援队于2026年8月15日抵达受灾地区搜寻幸存者。', 'rescue.example', 'world')]),
    createEvent('world', [candidate('world-4', '韩国推进与朝鲜的停火谈判', '韩国推进与朝鲜的停火谈判，会谈安排于2026年8月15日公布并涉及边境机制。', 'talks.example', 'world')]),
  ]
  const allEvents = [event, ...fillers]
  const baseline = buildRulesBriefing({ ...collection(allEvents), domain: 'world' }, new Date('2026-08-16T00:00:00Z'), allEvents.map((item) => item.id))
  const baselineStory = baseline.stories.find((item) => item.id === event.id)!
  const story = {
    ...baselineStory,
    summary: '疫苗研究讨论自闭症与新冠接种，研究团队计划继续跟踪受试者。',
    keyFacts: ['疫苗研究讨论自闭症与新冠接种。'],
    factSources: [{ factIndex: 0, urls: [event.primaryArticle.url] }],
  }
  const repaired = repairStoryContentFields(story, baselineStory, event)
  assert.doesNotMatch(`${repaired.title} ${repaired.summary} ${repaired.keyFacts.join(' ')}`, /疫苗|自闭症|新冠/)
  assert.equal(summaryAddsNewInformation(repaired.title, repaired.summary, event), true)
})

test('官方来源标题过于笼统时，使用通用实体动作对象指纹生成具体稿', () => {
  const event = createEvent('markets', [candidate(
    'official-generic',
    'Press Release Details',
    'Acme Semiconductor announced a $12 billion factory expansion in Singapore on 2026-08-15 to increase advanced packaging capacity.',
    'acme.example',
    'markets',
    'primary',
  )])
  const content = buildEventSpecificContent(event)
  assert.match(content.title, /Acme Semiconductor.*扩建.*产能建设/)
  assert.match(content.summary, /12 billion|2026-08-15/)
  assert.equal(summaryAddsNewInformation(content.title, content.summary, event), true)
})

test('门禁统计标题复述、无新增事实、跨事件来源、HTML 与英文残句', () => {
  const events = [
    createEvent('ai-tech', [candidate('metric-a', 'Acme launches AI chip platform', 'Acme launched the AI chip platform for enterprise inference on 2026-08-15.', 'a.example')]),
    createEvent('ai-tech', [candidate('metric-b', 'Beta expands HBM memory capacity', 'Beta expanded HBM memory capacity for data-center customers on 2026-08-15.', 'b.example')]),
    ...auxiliaryEvents(),
    createEvent('ai-tech', [candidate('metric-c', 'Gamma launches AI security tool', 'Gamma launched an AI security tool for enterprise teams on 2026-08-15.', 'c.example')]),
  ]
  const briefing = buildRulesBriefing(collection(events), new Date('2026-08-16T00:00:00Z'), events.map((event) => event.id))
  briefing.stories[0] = {
    ...briefing.stories[0],
    summary: `${briefing.stories[0].title}；现有来源材料明确记录了这一具体动作。`,
    keyFacts: ['疫苗研究讨论自闭症。'],
    factSources: [{ factIndex: 0, urls: [events[0].primaryArticle.url] }],
  }
  briefing.stories[1] = { ...briefing.stories[1], summary: '<p>Beta expands memory</p> this is a broken english sentence with no useful context at all' }
  const metrics = contentQualityMetrics(briefing, events)
  assert.ok(metrics.repeatedSummaryCount >= 1)
  assert.ok(metrics.noNewFactSummaryCount >= 1)
  assert.ok(metrics.crossEventSourceCount >= 1)
  assert.ok(metrics.htmlArtifactCount >= 1)
  assert.ok(metrics.englishFragmentCount >= 1)
})

test('8月16日缓存离线回放产出20条具体标题摘要，且六项内容问题均为零', async () => {
  const replay = JSON.parse(await readFile(replayFixturePath, 'utf8')) as {
    stories: Array<{ id: string; title: string; summary: string; keyFacts: string[] }>
  }
  assert.equal(replay.stories.length, 20)
  assert.equal(new Set(replay.stories.map((story) => story.id)).size, 20)
  for (const story of replay.stories) {
    const material = `${story.summary} ${story.keyFacts.join(' ')}`
    assert.equal(isPlaceholderTitle(story.title), false, story.id)
    assert.equal(isPlaceholderSummary(story.summary), false, story.id)
    assert.equal(hasHtmlArtifact(material), false, story.id)
    assert.equal(hasMeaninglessEnglishFragment(material), false, story.id)
    const normalizedTitle = story.title.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
    const normalizedSummary = story.summary.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
    assert.equal(normalizedSummary.includes(normalizedTitle), false, story.id)
    assert.ok(story.summary.length >= 40 && story.summary.length <= 160, story.id)
    assert.ok(story.keyFacts.length >= 1 && story.keyFacts.every((fact) => fact.length >= 12), story.id)
  }
})
