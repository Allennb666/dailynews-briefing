import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DailyBriefing, DomainId, SourceReliability } from '../shared/briefing.js'
import { findCrossDomainDuplicates, validateCrossDomainUniqueness } from './editorial.js'
import { stabilizeBriefingWithBackups, validateBriefing, validateBriefingStory } from './model.js'
import {
  assessEventForPreselection,
  assessSearchHit,
  buildCandidatePool,
  buildRuleStory,
  buildRulesBriefing,
  clusterCandidates,
  createEvent,
  crossDomainEventConfidence,
  extractActions,
  extractEventObjects,
  hasConcreteActorAndAction,
  type Candidate,
  type CollectionResult,
  type NewsEvent,
} from './pipeline.js'
import { DOMAIN_CONFIGS } from './sources.js'

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/stability-2026-08-18.json')

type ArtifactFixture = {
  source: { runId: number; diagnosticArtifactId: number; status: string; published: boolean; searchCalls: number }
  replay: {
    runId: number
    diagnosticArtifactId: number
    searchCalls: number
    qualityStatus: Record<DomainId, string>
    marketRejected: { title: string; source: string }
    marketBackup: { title: string; source: string }
    marketGateFailures: Array<{ title: string; source: string }>
    aiBackups: Array<{ title: string; source: string; description?: string }>
    latestGateFailures: {
      aiPolicy: { title: string; description: string }
      agentWorkflow: { title: string }
      executiveAppointment: { title: string; unrelatedTitle: string }
      talibanThreat: { title: string }
      humanitarianAccess: { title: string; description: string }
      franceRanking: { title: string }
    }
    publishedFalsePasses: {
      aiFactory: string
      archiveTitle: string
      archiveUrl: string
      courseTitle: string
      classroomTitle: string
      testModeratorTitle: string
      truncatedMarketSummary: string
      brokenEducationSummary: string
    }
    learningSecurity: { title: string; source: string }
    publishedGateMisses: Array<{ domain: DomainId; title: string; source: string; url?: string; expected: 'reject' | 'publishable' | 'insufficient-material' }>
    learningBackups: Array<{ title: string; description: string }>
  }
  cases: {
    irrelevantMarket: { id: string; title: string; source: string; url: string }
    falseMergedWorld: { oldEventId: string; articles: Array<{ title: string; source: string; url: string; publishedAt: string }> }
    falseCrossDomainDuplicate: { left: RealItem; right: RealItem }
    actionSynonym: { id: string; title: string; source: string; publishedAt: string }
  }
  expected: { storyCount: number; productionSearchBudget: number; tavilyCallsDuringOfflineReplay: number }
}

type RealItem = { id: string; domain: DomainId; title: string; source: string; url: string; publishedAt: string }

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as ArtifactFixture
}

function source(id: string, reliability: SourceReliability = 'tier-1') {
  return {
    id,
    name: id,
    url: `https://${id}`,
    type: reliability === 'primary' ? 'official' as const : 'media' as const,
    reliability,
    weight: reliability === 'primary' ? 42 : 34,
    focused: true,
  }
}

function candidate(
  id: string,
  domain: DomainId,
  title: string,
  description: string,
  sourceId = `${id}.example`,
  score = 100,
  publishedAt = '2026-08-17T10:00:00.000Z',
): Candidate {
  return {
    id,
    domain,
    title,
    description,
    url: `https://${sourceId}/${id}`,
    publishedAt,
    dateConfidence: 'reliable',
    source: source(sourceId),
    score,
    tags: domain === 'markets' ? ['公司'] : domain === 'world' ? ['安全'] : domain === 'learning' ? ['学习科学'] : ['芯片'],
    discoveryMethod: 'news-search',
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${sourceId}`,
  }
}

function realCandidate(item: RealItem): Candidate {
  const result = candidate(item.id, item.domain, item.title, item.title, item.source, 90, item.publishedAt)
  result.url = item.url
  return result
}

function collection(domain: DomainId, events: NewsEvent[]): CollectionResult {
  return {
    domain,
    candidates: events.flatMap((event) => event.articles),
    fetched: events.length,
    sourceCount: new Set(events.map((event) => event.primaryArticle.source.id)).size,
    rssCandidates: events.length,
    searchCandidates: 0,
    searchCalls: 0,
    warnings: [],
  }
}

const domainStories: Record<DomainId, Array<[string, string]>> = {
  'ai-tech': [
    ['NVIDIA推出企业AI服务器', 'NVIDIA于2026年8月17日推出企业AI服务器，首批系统面向推理服务客户。'],
    ['AMD收购芯片设计公司', 'AMD于2026年8月17日收购芯片设计公司，以补充数据中心产品能力。'],
    ['SK海力士扩建HBM产能', 'SK海力士于2026年8月17日扩建HBM产能，新增产品面向AI服务器客户。'],
    ['英特尔启动先进封装产线', '英特尔于2026年8月17日启动先进封装产线，为数据中心芯片增加制造能力。'],
    ['OpenAI上线编程智能体', 'OpenAI于2026年8月17日上线编程智能体，首批功能用于代码审查和协作开发。'],
    ['微软扩建欧洲数据中心', '微软于2026年8月17日扩建欧洲数据中心，为企业人工智能应用增加算力。'],
    ['Anthropic发布模型安全工具', 'Anthropic于2026年8月17日发布模型安全工具，企业客户可用于内容治理。'],
  ],
  markets: [
    ['美联储维持基准利率不变', '美联储于2026年8月17日维持基准利率不变，并继续观察通胀和就业数据。'],
    ['美国劳工统计局公布生产者价格指数', '美国劳工统计局于2026年8月17日公布生产者价格指数，当月指标环比保持不变。'],
    ['能源署公布原油库存变化', '美国能源署于2026年8月17日公布原油库存变化，数据影响市场对供应的判断。'],
    ['伯克希尔增持Alphabet股份', '伯克希尔于2026年8月17日披露增持Alphabet股份，调整大型科技股持仓。'],
    ['美国证交会起诉投资骗局', '美国证交会于2026年8月17日起诉投资骗局，指控相关机构误导投资者。'],
    ['财政部公布国债收益率', '美国财政部于2026年8月17日公布国债收益率，为融资成本判断提供新数据。'],
    ['Anthropic公布年度营收', 'Anthropic于2026年8月17日公布年度营收，并更新企业业务经营指引。'],
  ],
  world: [
    ['韩国政府签署安全协议', '韩国政府于2026年8月17日签署安全协议，协议涉及地区防务合作。'],
    ['欧盟实施新一轮制裁', '欧盟于2026年8月17日实施新一轮制裁，措施覆盖贸易和技术出口。'],
    ['黎巴嫩推进停火谈判', '黎巴嫩于2026年8月17日推进停火谈判，联合国代表参与新一轮会谈。'],
    ['印度尼西亚发生地震', '印度尼西亚于2026年8月17日发生地震，救援人员继续搜寻受影响居民。'],
    ['俄罗斯反战政治人物被判刑', '俄罗斯法院于2026年8月17日判处反战政治人物十一年监禁。'],
    ['阿联酋油轮在霍尔木兹海峡遇袭', '两艘阿联酋油轮于2026年8月14日在霍尔木兹海峡遇袭，航运安全风险上升。'],
    ['俄罗斯袭击影响黑海粮食供应', '俄罗斯于2026年8月15日袭击黑海设施，乌克兰方面称埃及粮食供应受到威胁。'],
  ],
  learning: [
    ['OECD发布PISA评估框架', 'OECD于2026年8月17日发布PISA评估框架，新增能力指标供成员教育系统参考。'],
    ['IB更新课程评估标准', 'IB于2026年8月17日更新课程评估标准，新要求面向后续考试周期。'],
    ['UNESCO启动AI素养项目', 'UNESCO于2026年8月17日启动AI素养项目，为教师培训提供课程材料。'],
    ['研究团队公布学习科学实验', '研究团队于2026年8月17日公布学习科学实验，结果比较两种反馈方式。'],
    ['教育部门实施课程改革', '教育部门于2026年8月17日实施课程改革，新课程覆盖评估和数字素养。'],
    ['大学推出教师AI培训', '大学于2026年8月17日推出教师AI培训，课程聚焦课堂使用和学术诚信。'],
    ['OECD发布教育趋势报告', 'OECD于2026年8月17日发布教育趋势报告，材料比较成员国课程政策变化。'],
  ],
}

function eventsFor(domain: DomainId) {
  return domainStories[domain].map(([title, description], index) => createEvent(domain, [
    candidate(`${domain}-${index}`, domain, title, description, `${domain}-source-${index % 5}`, 100 - index),
  ]))
}

test('8月18日真实 artifact 元数据与生产预算被固定为回归输入', async () => {
  const data = await fixture()
  assert.equal(data.source.runId, 32082002807)
  assert.equal(data.source.diagnosticArtifactId, 9305532769)
  assert.equal(data.source.status, 'held')
  assert.equal(data.source.published, false)
  assert.equal(data.source.searchCalls, data.expected.productionSearchBudget)
  assert.equal(data.expected.tavilyCallsDuringOfflineReplay, 0)
})

test('真实候选：BBC休假自动回复在Qwen预选前被领域与新闻价值门禁拒绝', async () => {
  const data = await fixture()
  const item = data.cases.irrelevantMarket
  const hit = candidate(item.id, 'markets', item.title, 'Advice about workplace messages and holiday replies.', item.source)
  hit.url = item.url
  const event = createEvent('markets', [hit])
  assert.equal(assessEventForPreselection(event).accepted, false)
  assert.equal(buildCandidatePool(collection('markets', [event])).some((candidateEvent) => candidateEvent.id === event.id), false)
})

test('真实缓存回放：家庭生活故事退出市场池，美联储监管事件可作为备用', async () => {
  const data = await fixture()
  assert.equal(data.replay.runId, 32504825390)
  assert.equal(data.replay.diagnosticArtifactId, 9455018002)
  assert.equal(data.replay.searchCalls, 0)
  assert.equal(data.replay.qualityStatus.markets, 'degraded')
  assert.equal(data.replay.qualityStatus.learning, 'degraded')

  const rejected = createEvent('markets', [candidate(
    'replay-market-life',
    'markets',
    data.replay.marketRejected.title,
    'A parent describes child maintenance, food banks and family support.',
    data.replay.marketRejected.source,
  )])
  const backup = createEvent('markets', [candidate(
    'replay-market-fed',
    'markets',
    data.replay.marketBackup.title,
    'The Federal Reserve issued an enforcement action involving a former bank employee.',
    data.replay.marketBackup.source,
  )])
  backup.articles[0].source = source('fed', 'primary')
  assert.equal(assessEventForPreselection(rejected).accepted, false)
  assert.equal(assessEventForPreselection(backup).accepted, true)
})

test('最新真实回放：两宗 SEC 案件与美联储执法稿可生成不同的具体摘要', async () => {
  const data = await fixture()
  const stories = data.replay.marketGateFailures.map((item, index) => {
    const hit = candidate(`market-gate-${index}`, 'markets', item.title, item.title, item.source)
    hit.source = source(item.source, 'primary')
    const event = createEvent('markets', [hit])
    return { event, story: buildRuleStory(event) }
  })
  for (const { event, story } of stories) {
    assert.equal(validateBriefingStory(story, event).length, 0, `${story.title}: ${validateBriefingStory(story, event).join('；')}`)
  }
  assert.notEqual(stories[0].story.title, stories[1].story.title)
  assert.match(stories[0].story.summary, /散户投资者.*74 Million/)
  assert.match(stories[1].story.summary, /正统派犹太社区.*47 Million/)
  assert.match(stories[2].story.summary, /Regions Bank.*前员工/)
})

test('来源等级门禁以事件绑定来源为准，不受成稿中的陈旧来源元数据误伤', () => {
  const events = eventsFor('world').slice(0, 5)
  const briefing = buildRulesBriefing(collection('world', events), new Date('2026-08-18T00:00:00.000Z'), events.map((event) => event.id))
  const stale = {
    ...briefing,
    stories: briefing.stories.map((story, index) => index < 2
      ? { ...story, source: { ...story.source, reliability: 'other' as const } }
      : story),
  }
  assert.equal(validateBriefing(stale, events).some((error) => error.includes('other 来源')), false)
})

test('最新真实回放：AI、国际与教育备用事件均可成稿，重复链不再夹带另一公告', async () => {
  const data = await fixture()
  const latest = data.replay.latestGateFailures
  const cases: Array<{ domain: DomainId; title: string; description: string; sourceId: string; reliability: SourceReliability }> = [
    { domain: 'ai-tech', title: latest.aiPolicy.title, description: latest.aiPolicy.description, sourceId: 'openai.com', reliability: 'primary' },
    { domain: 'ai-tech', title: latest.agentWorkflow.title, description: latest.agentWorkflow.title, sourceId: 'huggingface.co', reliability: 'primary' },
    { domain: 'world', title: latest.talibanThreat.title, description: latest.talibanThreat.title, sourceId: 'theguardian.com', reliability: 'tier-1' },
    { domain: 'world', title: latest.humanitarianAccess.title, description: latest.humanitarianAccess.description, sourceId: 'news.un.org', reliability: 'primary' },
    { domain: 'learning', title: latest.franceRanking.title, description: latest.franceRanking.title, sourceId: 'lemonde.fr', reliability: 'tier-1' },
  ]
  for (const [index, item] of cases.entries()) {
    const hit = candidate(`latest-gate-${index}`, item.domain, item.title, item.description, item.sourceId)
    hit.source = source(item.sourceId, item.reliability)
    const event = createEvent(item.domain, [hit])
    const story = buildRuleStory(event)
    assert.equal(validateBriefingStory(story, event).length, 0, `${story.title}: ${validateBriefingStory(story, event).join('；')}`)
  }

  const appointment = candidate('appointment', 'ai-tech', latest.executiveAppointment.title, latest.executiveAppointment.title, 'openai.com')
  appointment.source = source('openai.com', 'primary')
  const daybreak = candidate('daybreak', 'ai-tech', latest.executiveAppointment.unrelatedTitle, latest.executiveAppointment.unrelatedTitle, 'openai.com')
  daybreak.source = source('openai.com', 'primary')
  appointment.duplicates = [daybreak]
  const event = createEvent('ai-tech', [appointment])
  assert.equal(event.articles.length, 1)
  assert.doesNotMatch(event.articles.map((article) => article.title).join(' '), /Daybreak/)

  const humanitarian = candidate('humanitarian-domain', 'world', latest.humanitarianAccess.title, latest.humanitarianAccess.description, 'news.un.org')
  humanitarian.source = source('news.un.org', 'primary')
  const humanitarianEvent = createEvent('world', [humanitarian])
  assert.equal(extractEventObjects(latest.humanitarianAccess.title).has('product-release'), false)
  assert.equal(assessEventForPreselection(humanitarianEvent, 'world').accepted, true)

  const ranking = candidate('ranking-domain', 'learning', latest.franceRanking.title, latest.franceRanking.title, 'lemonde.fr')
  ranking.source = source('lemonde.fr', 'tier-1')
  assert.equal(assessEventForPreselection(createEvent('learning', [ranking]), 'learning').accepted, true)
})

test('成功发布后的人工复核：归档页、残缺摘要和伪具体规则稿不再通过', async () => {
  const data = await fixture()
  const misses = data.replay.publishedFalsePasses

  const archive = candidate('published-archive', 'world', misses.archiveTitle, 'UN News page includes Iran, Ukraine and several unrelated latest stories.', 'news.un.org')
  archive.url = misses.archiveUrl
  archive.source = source('news.un.org', 'primary')
  assert.equal(assessEventForPreselection(createEvent('world', [archive]), 'world').accepted, false)

  const factory = candidate('published-factory', 'ai-tech', misses.aiFactory, misses.aiFactory, 'blogs.nvidia.com')
  factory.source = source('blogs.nvidia.com', 'primary')
  const factoryEvent = createEvent('ai-tech', [factory])
  const factoryStory = buildRuleStory(factoryEvent)
  assert.match(factoryStory.title, /Firebird.*发布.*亚美尼亚AI工厂/)
  assert.doesNotMatch(factoryStory.title, /NVIDIA接触产能建设/)

  const course = candidate('published-course', 'learning', misses.courseTitle, misses.courseTitle, 'blog.coursera.org')
  course.source = source('blog.coursera.org', 'primary')
  const courseEvent = createEvent('learning', [course])
  const courseStory = buildRuleStory(courseEvent)
  assert.match(courseStory.title, /^Google/)
  assert.notEqual(validateBriefingStory(courseStory, courseEvent).length, 0, '仅有标题的课程材料不能用泛化摘要凑数')

  const classroom = candidate('published-classroom', 'learning', misses.classroomTitle, misses.classroomTitle, 'edsurge.com')
  classroom.source = source('edsurge.com', 'tier-1')
  const classroomEvent = createEvent('learning', [classroom])
  assert.notEqual(validateBriefingStory(buildRuleStory(classroomEvent), classroomEvent).length, 0)

  const moderator = candidate('published-moderator', 'learning', misses.testModeratorTitle, misses.testModeratorTitle, 'newscientist.com')
  moderator.source = source('newscientist.com', 'other')
  const moderatorEvent = createEvent('learning', [moderator])
  assert.doesNotMatch(buildRuleStory(moderatorEvent).title, /^Test/)
  assert.notEqual(validateBriefingStory(buildRuleStory(moderatorEvent), moderatorEvent).length, 0)

  const valid = buildRuleStory(factoryEvent)
  assert.ok(validateBriefingStory({ ...valid, summary: misses.truncatedMarketSummary }, factoryEvent).some((error) => error.includes('摘要') || error.includes('HTML')))
  assert.ok(validateBriefingStory({ ...valid, summary: misses.brokenEducationSummary }, factoryEvent).some((error) => error.includes('残缺量词')))
})

test('真实缓存回放：教育英文事件均能生成具体中文备用稿并独立通过门禁', async () => {
  const data = await fixture()
  for (const [index, item] of data.replay.learningBackups.entries()) {
    const event = createEvent('learning', [candidate(
      `replay-learning-${index}`,
      'learning',
      item.title,
      item.description,
      `learning-replay-${index}.example`,
    )])
    const story = buildRuleStory(event)
    assert.match(story.title, /[\p{Script=Han}]/u, story.title)
    assert.equal(validateBriefingStory(story, event).length, 0, `${story.title}: ${validateBriefingStory(story, event).join('；')}`)
  }
})

test('第二次真实缓存回放：官方省略主体按材料充足度处理，教育与 Sentence Transformers 歧义均被通用处理', async () => {
  const data = await fixture()
  for (const [index, item] of data.replay.aiBackups.entries()) {
    const hit = candidate(`replay-ai-${index}`, 'ai-tech', item.title, item.description ?? item.title, item.source)
    hit.source = source(item.source, 'primary')
    const event = createEvent('ai-tech', [hit])
    const story = buildRuleStory(event)
    assert.equal(assessEventForPreselection(event).accepted, true)
    assert.match(story.title, /OpenAI/)
    assert.equal(validateBriefingStory(story, event).length, 0, validateBriefingStory(story, event).join('；'))
    if (index === 0) assert.match(story.summary, /14个独立项目/)
    else assert.match(story.summary, /CodeAI.*学生和从业者/)
  }

  const security = createEvent('learning', [candidate(
    'replay-learning-security',
    'learning',
    data.replay.learningSecurity.title,
    data.replay.learningSecurity.title,
    data.replay.learningSecurity.source,
  )])
  assert.equal(assessEventForPreselection(security).accepted, true)
  assert.equal(validateBriefingStory(buildRuleStory(security), security).length, 0)

  assert.equal(extractActions('Sentence Transformers multi-vector embedding models').has('sentence'), false)
  assert.equal(extractActions('A politician was sentenced to prison').has('sentence'), true)
})

test('成功回放人工复核发现的伪通过稿会被拒绝或重写为来源标题锚定的具体稿', async () => {
  const data = await fixture()
  for (const [index, item] of data.replay.publishedGateMisses.entries()) {
    const hit = candidate(`published-gate-${index}`, item.domain, item.title, item.title, item.source)
    if (item.url) hit.url = item.url
    if (/huggingface|nvidia/i.test(item.source)) hit.source = source(item.source, 'primary')
    const event = createEvent(item.domain, [hit])
    const assessment = assessEventForPreselection(event)
    if (item.expected === 'reject') {
      assert.equal(assessment.accepted, false, item.title)
      continue
    }
    assert.equal(assessment.accepted, true, `${item.title}: ${assessment.reason}`)
    const story = buildRuleStory(event)
    if (item.expected === 'insufficient-material') {
      assert.ok(validateBriefingStory(story, event).length > 0, item.title)
      continue
    }
    assert.equal(validateBriefingStory(story, event).length, 0, `${story.title}: ${validateBriefingStory(story, event).join('；')}`)
    assert.doesNotMatch(story.title, /联合国发动袭击|说明新产品|竞争力下滑航运安排|达成合作新产品/)
  }

  const event = eventsFor('learning')[0]
  const broken = { ...buildRuleStory(event), summary: '该项目预计今年秋季将减少 万人，并造成约 经济损失。' }
  assert.ok(validateBriefingStory(broken, event).some((error) => error.includes('残缺量词')))

  const future = assessSearchHit(DOMAIN_CONFIGS['ai-tech'], {
    title: 'ChatGPT Ads expands across Europe',
    url: 'https://openai.com/index/chatgpt-ads-expands-across-europe',
    snippet: 'ChatGPT Ads expands to additional European markets.',
    publishedAt: '2026-08-18T22:00:00.000Z',
    publisher: 'OpenAI',
  }, 'site:openai.com AI product announcement', new Date('2026-08-17T23:30:00.000Z'))
  assert.equal(future.candidate, null)
  assert.equal(future.decision.reason, 'future-dated')
})

test('真实误聚类：霍尔木兹油轮与黑海粮食供应拆成两个事件', async () => {
  const data = await fixture()
  const candidates = data.cases.falseMergedWorld.articles.map((item, index) => {
    const value = candidate(`world-real-${index}`, 'world', item.title, item.title, item.source, 95 - index, item.publishedAt)
    value.url = item.url
    return value
  })
  const events = clusterCandidates(candidates)
  assert.equal(events.length, 2)
  assert.ok(events.some((event) => /Hormuz/i.test(event.canonicalTitle)))
  assert.ok(events.some((event) => /Black Sea/i.test(event.canonicalTitle)))
})

test('真实跨领域误报：Groq 3.5亿美元融资与NVIDIA/OpenAI 1050亿美元融资不是硬重复', async () => {
  const data = await fixture()
  const left = createEvent('ai-tech', [realCandidate(data.cases.falseCrossDomainDuplicate.left)])
  const right = createEvent('markets', [realCandidate(data.cases.falseCrossDomainDuplicate.right)])
  assert.notEqual(crossDomainEventConfidence(left, right), 'high')
})

test('真实动作漏识别：jailed、sentenced、获刑和监禁属于明确判刑动作', async () => {
  const data = await fixture()
  for (const text of [data.cases.actionSynonym.title, 'Politician sentenced to prison', '政治人物获刑十一年', '法院判处其监禁']) {
    assert.equal(extractActions(text).has('sentence'), true, text)
  }
})

test('真实国际稿中的 warns/警告会被识别为明确事件动作', () => {
  assert.equal(extractActions('Zelenskyy warns Egypt of food supply threat caused by Russian strikes').has('warn'), true)
  assert.equal(extractActions('泽连斯基警告埃及俄罗斯袭击威胁粮食供应').has('warn'), true)
  const event = createEvent('world', [candidate(
    'zelensky-warning',
    'world',
    'Ukraine war briefing: Zelenskyy warns Egypt of food supply threat caused by Russian strikes in Black Sea',
    'Russian strikes in the Black Sea threaten grain supplies to Egypt.',
    'theguardian.com',
  )])
  assert.equal(hasConcreteActorAndAction('泽连斯基警告埃及：俄罗斯袭击威胁黑海粮食供应', event), true)
})

test('市场同时两条坏稿时整体组合一次换入两条备用事件', async () => {
  const good = eventsFor('markets')
  const data = await fixture()
  const irrelevant = createEvent('markets', [candidate('market-bbc-bad', 'markets', data.cases.irrelevantMarket.title, 'BBC offers tips for holiday replies.', 'bbc.co.uk', 110)])
  const lifestyle = createEvent('markets', [candidate('market-life-bad', 'markets', '职场生活技巧：如何设置自动回复', '这是一篇普通生活技巧文章，介绍休假期间如何设置自动回复。', 'lifestyle.example', 109)])
  const events = [good[0], good[1], good[2], irrelevant, lifestyle, good[3], good[4], good[5]]
  const input = collection('markets', events)
  const briefing = buildRulesBriefing(input, new Date('2026-08-18T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
  const stabilized = stabilizeBriefingWithBackups(input, briefing, events, new Date('2026-08-18T00:00:00Z'))
  assert.equal(stabilized.errors.length, 0, `${stabilized.errors.join('；')} | ${events.map((event) => `${event.id}:${event.canonicalTitle}:${assessEventForPreselection(event).reason}`).join('|')} | eligible=${stabilized.eligibleOptionIds.join(',')}`)
  assert.equal(stabilized.replacements.length, 2)
  assert.equal(stabilized.briefing.pipeline.qualityStatus, 'passed')
  assert.equal(stabilized.briefing.stories.some((story) => [irrelevant.id, lifestyle.id].includes(story.id)), false)
  assert.ok(stabilized.consideredCombinations > 1)
})

test('国际板块可同时处理拆分事件、判刑动作和多来源事实并选满五条', () => {
  const events = eventsFor('world')
  const input = collection('world', events)
  const briefing = buildRulesBriefing(input, new Date('2026-08-18T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
  const stabilized = stabilizeBriefingWithBackups(input, briefing, events, new Date('2026-08-18T00:00:00Z'))
  assert.equal(stabilized.errors.length, 0, `${stabilized.errors.join('；')} | ${briefing.stories.map((story) => `${story.id}:${story.title}`).join('|')} | eligible=${stabilized.eligibleOptionIds.join(',')}`)
  assert.equal(stabilized.briefing.stories.length, 5)
  assert.equal(stabilized.briefing.pipeline.qualityStatus, 'passed')
})

test('教育备用替换能力保留，四领域最终20条均通过且无硬重复', () => {
  const briefings: DailyBriefing[] = []
  const selections: Array<{ domain: DomainId; events: NewsEvent[] }> = []
  for (const domain of ['ai-tech', 'markets', 'world', 'learning'] as const) {
    const events = eventsFor(domain)
    const input = collection(domain, events)
    const briefing = buildRulesBriefing(input, new Date('2026-08-18T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
    const stabilized = stabilizeBriefingWithBackups(input, briefing, events, new Date('2026-08-18T00:00:00Z'))
    assert.equal(stabilized.errors.length, 0, `${domain}: ${stabilized.errors.join('；')}`)
    assert.equal(validateBriefing(stabilized.briefing, stabilized.selectedEvents).length, 0)
    briefings.push(stabilized.briefing)
    selections.push({ domain, events })
  }
  assert.equal(briefings.flatMap((briefing) => briefing.stories).length, 20)
  assert.equal(briefings.every((briefing) => briefing.pipeline.qualityStatus === 'passed'), true)
  assert.equal(validateCrossDomainUniqueness(briefings, selections).length, 0)
  assert.equal(findCrossDomainDuplicates(briefings, selections).length, 0)
})

test('组合选择不受备用事件输入顺序影响', () => {
  const good = eventsFor('markets')
  const bad = createEvent('markets', [candidate('order-bad', 'markets', '生活技巧：怎样写休假自动回复', '普通生活技巧介绍如何写休假自动回复。', 'tips.example', 120)])
  const events = [good[0], good[1], good[2], good[3], bad, good[4], good[5], good[6]]
  const input = collection('markets', events)
  const briefing = buildRulesBriefing(input, new Date('2026-08-18T00:00:00Z'), events.slice(0, 5).map((event) => event.id))
  const forward = stabilizeBriefingWithBackups(input, briefing, events, new Date('2026-08-18T00:00:00Z'))
  const reversed = stabilizeBriefingWithBackups(input, briefing, [...events].reverse(), new Date('2026-08-18T00:00:00Z'))
  assert.deepEqual(forward.briefing.stories.map((story) => story.id), reversed.briefing.stories.map((story) => story.id))
})
