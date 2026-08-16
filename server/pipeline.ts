import { createHash } from 'node:crypto'
import Parser from 'rss-parser'
import type { BriefingStory, DailyBriefing, DiscoveryMethod, DomainId, EventEvidence, MaterialLevel } from '../shared/briefing.js'
import { DOMAIN_CONFIGS, type DomainConfig, type FeedSource } from './sources.js'
import {
  buildDiscoveryQueries,
  discoveryMethodForQuery,
  searchOptionsForDomain,
  type SearchHit,
  type SearchPhase,
  type SearchRuntime,
  sourceForSearchResult,
} from './search.js'

export type Candidate = {
  id: string
  domain: DomainId
  title: string
  description: string
  url: string
  publishedAt: string
  dateConfidence?: 'reliable' | 'unknown'
  source: FeedSource
  score: number
  tags: string[]
  discoveryMethod: DiscoveryMethod
  materialLevel: MaterialLevel
  fullText?: string
  independenceKey?: string
  query?: string
  relevanceScore?: number
  searchPhase?: SearchPhase
  duplicates?: Candidate[]
}

export type CandidateDecision = {
  domain: DomainId
  stage: 'rss' | SearchPhase
  accepted: boolean
  reason: 'accepted' | 'missing-title-or-url' | 'non-article-page' | 'irrelevant' | 'expired' | 'future-dated'
    | 'duplicate-url' | 'event-mismatch' | 'entity-mismatch' | 'action-mismatch' | 'object-mismatch'
    | 'indicator-mismatch' | 'number-mismatch' | 'source-target-mismatch'
  candidateId?: string
  title: string
  url: string
  sourceId: string
  sourceName: string
  publishedAt: string
  dateConfidence: Candidate['dateConfidence']
  score?: number
  query?: string
}

export type SyndicationFinding = {
  leftId: string
  rightId: string
  confidence: 'high' | 'medium'
  wireKey: string | null
  reasons: string[]
}

export type EventDateConflict = {
  earliestPublishedAt: string
  latestPublishedAt: string
  spreadHours: number
  articleIds: string[]
}

export type NewsEvent = {
  id: string
  domain: DomainId
  canonicalTitle: string
  articles: Candidate[]
  primaryArticle: Candidate
  entities: string[]
  topicTags: string[]
  publishedAt: string
  latestUpdateAt: string
  sourceCount: number
  evidence: EventEvidence
  dateConflict?: EventDateConflict
  syndicationWarnings?: SyndicationFinding[]
}

const parser = new Parser({
  timeout: 12_000,
  headers: {
    'User-Agent': 'DailyNews/0.2 (+personal RSS reader)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  },
})

export function stripHtml(value = '') {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:nav|header|footer|aside|form|svg|noscript)\b[\s\S]*?<\/(?:nav|header|footer|aside|form|svg|noscript)>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:nbsp|ensp|emsp);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&(?:hellip|mldr);/gi, '…')
    .replace(/&(?:ldquo|rdquo);/gi, '“')
    .replace(/&(?:lsquo|rsquo);/gi, '’')
    .replace(/&(?:mdash|ndash);/gi, '—')
    .replace(/&[a-z][a-z0-9]+;/gi, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\uFFFD]+/g, ' ')
    .replace(/(["'“”‘’])\1{1,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['ref', 'source', 'rss'].includes(key)) url.searchParams.delete(key)
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return rawUrl.trim()
  }
}

export function normalizeTitle(title: string) {
  return title.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '')
}

function titleTokens(title: string) {
  const normalized = title.toLocaleLowerCase().normalize('NFKC')
  const latin = normalized.match(/[a-z0-9]+/g) ?? []
  const cjk = (normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) => {
    if (part.length < 2) return [part]
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
  })
  return new Set([...latin, ...cjk])
}

export function titleSimilarity(a: string, b: string) {
  const left = titleTokens(a)
  const right = titleTokens(b)
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / new Set([...left, ...right]).size
}

const ENTITY_ALIASES: Array<[string, RegExp]> = [
  ['openai', /\bopenai\b/i],
  ['nvidia', /\bnvidia\b|英伟达/i],
  ['google', /\bgoogle\b|谷歌/i],
  ['anthropic', /\banthropic\b/i],
  ['microsoft', /\bmicrosoft\b|微软/i],
  ['meta', /\bmeta\b|元宇宙平台/i],
  ['apple', /\bapple\b|苹果公司/i],
  ['amazon', /\bamazon\b|亚马逊/i],
  ['amd', /\bamd\b/i],
  ['intel', /\bintel\b|英特尔/i],
  ['tsmc', /\btsmc\b|台积电/i],
  ['federal-reserve', /\bfederal reserve\b|\bthe fed\b|美联储/i],
  ['sec', /\bu\.?s\.? sec\b|\bsecurities and exchange commission\b|美国证监会/i],
  ['united-nations', /\bunited nations\b|\bun\b|联合国/i],
  ['china', /\bchina\b|中国/i],
  ['united-states', /\bunited states\b|\bu\.?s\.?\b|美国/i],
  ['european-union', /\beuropean union\b|\beu\b|欧盟/i],
  ['oecd', /\boecd\b|经济合作与发展组织/i],
  ['unesco', /\bunesco\b|联合国教科文组织/i],
  ['international-baccalaureate', /\binternational baccalaureate\b|\bIB\b|国际文凭/i],
  ['world-bank', /\bworld bank\b|世界银行/i],
  ['imf', /\bIMF\b|international monetary fund|国际货币基金组织/i],
  ['sk-hynix', /\bsk\s+hynix\b|sk海力士/i],
  ['berkshire-hathaway', /\bberkshire(?:\s+hathaway)?\b|伯克希尔/i],
  ['alphabet', /\balphabet\b/i],
  ['bls', /\bbureau of labor statistics\b|\bbls\b|美国劳工统计局/i],
  ['grok', /\bgrok\b/i],
  ['mit-sloan', /\bmit\s+sloan\b|MIT斯隆/i],
  ['israel', /\bisrael(?:i)?\b|以色列/i],
  ['iran', /\biran(?:ian)?\b|伊朗/i],
  ['oman', /\boman\b|阿曼/i],
  ['indonesia', /\bindonesia(?:n)?\b|印度尼西亚|印尼/i],
  ['south-korea', /\bsouth korea(?:n)?\b|韩国/i],
  ['north-korea', /\bnorth korea(?:n)?\b|朝鲜/i],
  ['uae', /\bUAE\b|united arab emirates|阿联酋/i],
]

const GENERIC_ENTITY_WORDS = new Set([
  'a', 'an', 'the', 'new', 'ai', 'us', 'u', 's', 'ceo', 'government', 'company', 'market', 'report',
  'unique', 'story', 'model', 'press release details', 'press release', 'exclusive', 'details', 'results',
])
const GENERIC_NAMED_ENTITY_TERMS = /\b(?:establish|infrastructure|financing|platforms?|mobilize|over|billion|million|capital|launch|release|report|results?|details?|exclusive|new|latest)\b/i

const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'new', 'of', 'on',
  'or', 'says', 'that', 'the', 'to', 'with', 'after', 'amid', 'about', 'into', 'its', 'their', 'this', 'will',
  'ai', 'news', 'report', 'reports', 'update', 'latest', 'major', 'today', 'company', 'market', 'industry',
  'archive', 'archives', 'index', 'category', 'categories', 'tag', 'tags', 'page', 'homepage',
])

const ACTION_GROUPS: Array<[string, RegExp]> = [
  ['launch', /\blaunch(?:es|ed|ing)?\b|\breleas(?:e|es|ed|ing)\b|\bunveil(?:s|ed|ing)?\b|\bintroduc(?:e|es|ed|ing)\b|\bannounc(?:e|es|ed|ing)\b|发布|推出|亮相|上线|公布|宣布/i],
  ['acquire', /\bacquir(?:e|es|ed|ing)\b|\bmerg(?:e|es|ed|ing)\b|\bbuy(?:s|ing)?\b|收购|并购|合并/i],
  ['funding', /\bfund(?:ing|ed)?\b|\bfinanc(?:e|es|ed|ing)\b|\bfinancing\b|\brais(?:e|es|ed|ing)\b|\binvest(?:s|ed|ing|ment)\b|融资|募资|投资/i],
  ['earnings', /\bearnings?\b|\brevenue\b|\bprofit\b|\bguidance\b|财报|营收|利润|业绩|指引/i],
  ['appoint', /\bappoint(?:s|ed|ing)?\b|\bresign(?:s|ed|ing)?\b|\bsteps? down\b|任命|辞职|离任/i],
  ['investigate', /\binvestigat(?:e|es|ed|ing|ion)\b|\blawsuit\b|\bsues?\b|\bprobe\b|调查|起诉|诉讼|审查/i],
  ['security', /\bhack(?:s|ed|ing)?\b|\bbreach\b|\bcyberattack\b|\bvulnerability\b|黑客|泄露|网络攻击|漏洞/i],
  ['rates', /\brate (?:cut|hike)\b|\bcuts? rates?\b|\braises? rates?\b|降息|加息|利率决定/i],
  ['agreement', /\bagreement\b|\bdeal\b|\bpartner(?:s|ed|ship)?\b|\bceasefire\b|协议|合作|联合|停火/i],
  ['restriction', /\bban(?:s|ned|ning)?\b|\bsanction(?:s|ed)?\b|\bexport control\b|禁令|制裁|出口管制/i],
  ['attack', /\battack(?:s|ed|ing)?\b|\bstrike(?:s)?\b|\binvad(?:e|es|ed|ing)\b|袭击|空袭|入侵/i],
  ['policy', /\bregulat(?:e|es|ed|ing|ion)\b|\bpolicy\b|\brule\b|监管|政策|新规/i],
  ['build', /\bbuild(?:s|ing)?\b|\bopen(?:s|ed|ing)?\b|\bexpan(?:d(?:s|ed|ing)?|sion)\b|建设|开设|设立|建立|扩建|扩张/i],
  ['stake-change', /\badds?\b.{0,36}\bstake\b|\bincreases?\b.{0,24}\bstake\b|增持|减持/i],
  ['reduce', /\bcuts?\b|\breduc(?:e|es|ed|ing)\b|\blower(?:s|ed|ing)?\b|下调|削减|降低/i],
  ['support', /\bsupport(?:s|ed|ing)?\b|\bhelp(?:s|ed|ing)?\b|支持|帮助/i],
  ['negotiate', /\bnegotiat(?:e|es|ed|ing|ion|ions)\b|\btalks?\b|谈判|会谈|和谈/i],
  ['death', /\bfound dead\b|\bdies?\b|\bdeath\b|去世|死亡|身亡/i],
  ['rank-change', /\brankings?\b|\brises?\b|\badvances?\b|排名|上升|前进/i],
  ['misuse', /\bmisus(?:e|es|ed|ing)\b|\btransform(?:s|ed|ing)?\b.{0,48}\bexplicit\b|滥用|露骨图像/i],
  ['explain', /\bdetails?\b|\bexplain(?:s|ed|ing)?\b|说明|介绍|详解/i],
  ['rescue', /\brescu(?:e|es|ed|ing)\b|\bsearch(?:es|ed|ing)? for survivors\b|救援|搜寻幸存者/i],
  ['implement', /\bimplement(?:s|ed|ing|ation)?\b|\brolls? out\b|实施|推进|启动/i],
  ['fraud-charge', /\bcharges?\b.{0,80}\bfraud|\bdefraud(?:s|ed|ing)?\b|指控.{0,40}欺诈|诈骗/i],
]

const EVENT_OBJECT_GROUPS: Array<[string, RegExp]> = [
  ['cpi', /\bcpi\b|consumer price index|消费者价格指数|居民消费价格/i],
  ['ppi', /\bppi\b|producer price index|生产者价格指数|工业生产者价格/i],
  ['pce', /\bpce\b|personal consumption expenditures|个人消费支出/i],
  ['interest-rate', /interest rates?|rate cut|rate hike|policy rate|利率|降息|加息/i],
  ['bond-yield', /treasury yields?|bond yields?|国债收益率|债券收益率/i],
  ['earnings-results', /earnings|quarterly results|financial results|revenue|profit|guidance|财报|季报|营收|利润|业绩|指引/i],
  ['product-release', /product|platform|model|chip|gpu|processor|software|app|产品|平台|模型|芯片|处理器|软件|应用/i],
  ['acquisition-target', /acquisition|acquire|merger|收购|并购|合并/i],
  ['funding-round', /funding round|financing|investment|raise[ds]?|融资|募资|投资/i],
  ['factory-capacity', /factory|fab|capacity|production line|产能|工厂|晶圆厂|生产线/i],
  ['data-center', /data cent(?:er|re)|ai factory|算力中心|数据中心/i],
  ['ai-center', /ai (?:technology )?cent(?:er|re)|人工智能中心/i],
  ['course-curriculum', /course|curriculum|syllabus|课程|课程改革|教学大纲/i],
  ['assessment', /assessment|test standards?|exam|pisa|评估|测评|考试/i],
  ['ai-literacy', /ai literacy|artificial intelligence literacy|人工智能素养|ai 素养/i],
  ['education-policy', /education policy|school policy|education reform|教育政策|教育改革/i],
  ['sanctions-controls', /sanctions?|export controls?|制裁|出口管制/i],
  ['military-strike', /airstrikes?|missile|drone attack|袭击|空袭|导弹|无人机/i],
  ['ceasefire-talks', /ceasefire|peace talks?|negotiations?|停火|和谈|谈判/i],
  ['shipping-route', /shipping|vessels?|strait|canal|航运|船只|海峡|运河/i],
  ['oil-price', /oil prices?|brent|wti|原油|油价|布兰特/i],
  ['earthquake', /earthquake|magnitude|地震|震级/i],
  ['memory-capacity', /\b(?:hbm|ai)\s+memory\b|memory capacity|内存产能|存储产能|HBM/i],
  ['equity-stake', /\b(?:equity|shareholding|stake)\b|股份|持股/i],
  ['ev-target', /electric vehicle sales targets?|\bEV\b.{0,20}targets?|电动车销售目标/i],
  ['fraud-case', /fraud|scam|boiler room|欺诈|骗局|诈骗/i],
  ['university-ranking', /university rankings?|shanghai rankings?|大学排名/i],
  ['image-abuse', /explicit imagery|explicit image|childhood photo|露骨图像|儿童照片|童年照片/i],
  ['watermark', /watermarks?|水印/i],
  ['student-support', /student parents?|caregivers?|childcare|学生父母|学生家长|托儿/i],
  ['mba-program', /evening mba|mba program|晚间MBA|MBA课程/i],
  ['creative-program', /digital creativity lab|digital arts|数字创意实验室|数字艺术/i],
  ['executive-governance', /executive departures?|talent exodus|ipo governance|高管离职|上市治理/i],
  ['vaccine-health', /vaccines?|autism|covid-?19|疫苗|自闭症|新冠/i],
]

const INDICATOR_OBJECTS = new Set(['cpi', 'ppi', 'pce', 'interest-rate', 'bond-yield', 'earnings-results', 'oil-price'])

const RUMOR_PATTERN = /\brumou?r(?:s|ed)?\b|\breportedly\b|\bsources? (?:say|said)\b|\bpeople familiar with\b|消息人士|知情人士|传闻|据悉|或将|据称/i

function textTokens(value: string) {
  const normalized = value.toLocaleLowerCase().normalize('NFKC')
  const latin = (normalized.match(/[a-z0-9][a-z0-9.-]*/g) ?? []).filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token))
  const cjk = (normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) => {
    if (part.length < 2) return [part]
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
  })
  return new Set([...latin, ...cjk])
}

function setSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / new Set([...left, ...right]).size
}

function overlapCoefficient(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  const intersection = [...left].filter((token) => right.has(token)).length
  return intersection / Math.min(left.size, right.size)
}

export function extractEntities(text: string) {
  const entities = new Set(ENTITY_ALIASES.filter(([, pattern]) => pattern.test(text)).map(([entity]) => entity))
  const named = text.match(/\b(?:[A-Z][A-Za-z0-9.-]{2,}|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9.-]{2,}|[A-Z]{2,})){0,2}\b/g) ?? []
  for (const value of named) {
    const normalized = value.toLocaleLowerCase().replace(/[.]/g, '').trim()
    const aliasesKnownEntity = ENTITY_ALIASES.some(([, pattern]) => pattern.test(value))
    const containsVerbOrConnector = /\b(?:with|partners?|adds?|launch(?:es|ed)?|reports?|announces?|exclusive|details?)\b/i.test(value)
    if (!aliasesKnownEntity && !containsVerbOrConnector && !GENERIC_NAMED_ENTITY_TERMS.test(value) && !GENERIC_ENTITY_WORDS.has(normalized)) entities.add(normalized)
  }
  return [...entities]
}

export function extractActions(text: string) {
  return new Set(ACTION_GROUPS.filter(([, pattern]) => pattern.test(text)).map(([action]) => action))
}

export function extractEventObjects(text: string) {
  return new Set(EVENT_OBJECT_GROUPS.filter(([, pattern]) => pattern.test(text)).map(([object]) => object))
}

function hasSpecificEventInformation(title: string, description = '') {
  const text = `${title} ${description}`
  return extractEntities(text).length > 0
    && (extractActions(text).size > 0 || extractEventObjects(text).size > 0)
}

export function isNonArticlePage(title: string, rawUrl: string, description = '') {
  let pathname = ''
  try {
    pathname = new URL(rawUrl).pathname.toLocaleLowerCase().replace(/\/+$/, '') || '/'
  } catch {
    pathname = rawUrl.toLocaleLowerCase()
  }
  const normalizedTitle = title.toLocaleLowerCase().normalize('NFKC').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const newsArchiveTitle = /^(?:news\s+)?archives?$|新闻归档/i.test(normalizedTitle)
  const genericTitle = /^(?:news|latest news|press releases?|index|category|tag|blog)$|新闻中心|资讯中心|文章列表/i.test(normalizedTitle)
  const listingPath = /(?:^|\/)(?:archive|archives|index|category|categories|tag|tags)(?:\/|$)/i.test(pathname)
    || /\/(?:news|press-releases?|blog)$/i.test(pathname)
  return newsArchiveTitle || ((genericTitle || listingPath) && !hasSpecificEventInformation(title, description))
}

export function extractKeyNumbers(text: string) {
  const matches = text.match(/(?:[$€£¥￥]\s?\d[\d,.]*(?:\s?(?:trillion|billion|million|tn|bn|mn))?|\d+(?:\.\d+)?\s?(?:%|percent|percentage points?|basis points?|bps|trillion|billion|million|亿元|亿美元|万亿元|万亿|万吨|gw|mw))/gi) ?? []
  return [...new Set(matches.map((value) => {
    const normalized = value.toLocaleLowerCase().replace(/\s+/g, ' ').replace(/,/g, '').trim()
    const usdHundredMillion = normalized.match(/^(\d+(?:\.\d+)?)亿美元$/)
    if (usdHundredMillion) return `usd:${Number(usdHundredMillion[1]) / 10}b`
    const usd = normalized.match(/^\$\s?(\d+(?:\.\d+)?)\s?(trillion|billion|million|tn|bn|mn)?$/)
    if (usd) {
      const unit = usd[2]?.startsWith('t') ? 't' : usd[2]?.startsWith('m') ? 'm' : usd[2] ? 'b' : ''
      return `usd:${Number(usd[1])}${unit}`
    }
    return normalized.replace(/percent/, '%').replace(/basis points?/, 'bps')
  }))]
}

export function keyNumberQueryLabel(value: string) {
  const usd = value.match(/^usd:(\d+(?:\.\d+)?)([btm]?)$/)
  if (!usd) return value
  const unit = usd[2] === 't' ? 'trillion' : usd[2] === 'b' ? 'billion' : usd[2] === 'm' ? 'million' : ''
  return `$${usd[1]}${unit ? ` ${unit}` : ''}`
}

type ComparableNumber = { kind: 'currency' | 'percent' | 'ratio' | 'quantity'; value: number }

function comparableNumber(value: string): ComparableNumber | null {
  const normalized = value.toLocaleLowerCase().replace(/,/g, '').trim()
  const usd = normalized.match(/^usd:(\d+(?:\.\d+)?)([btm]?)$/)
  if (usd) {
    const multiplier = usd[2] === 't' ? 1_000_000_000_000 : usd[2] === 'b' ? 1_000_000_000 : usd[2] === 'm' ? 1_000_000 : 1
    return { kind: 'currency', value: Number(usd[1]) * multiplier }
  }
  const percent = normalized.match(/^(\d+(?:\.\d+)?)\s?%$/)
  if (percent) return { kind: 'percent', value: Number(percent[1]) }
  const bps = normalized.match(/^(\d+(?:\.\d+)?)\s?bps$/)
  if (bps) return { kind: 'percent', value: Number(bps[1]) / 100 }
  const quantity = normalized.match(/^(\d+(?:\.\d+)?)\s?(trillion|billion|million|万亿元|万亿|亿元|gw|mw)$/)
  if (quantity) {
    const unit = quantity[2]
    const multiplier = unit === 'trillion' || unit === '万亿' || unit === '万亿元' ? 1_000_000_000_000
      : unit === 'billion' ? 1_000_000_000
        : unit === '亿元' ? 100_000_000
          : unit === 'million' ? 1_000_000
            : unit === 'gw' ? 1_000
              : 1
    return { kind: 'quantity', value: Number(quantity[1]) * multiplier }
  }
  return null
}

function closeEnough(left: ComparableNumber, right: ComparableNumber) {
  if (left.kind !== right.kind) return false
  const scale = Math.max(Math.abs(left.value), Math.abs(right.value), 1)
  const tolerance = left.kind === 'percent' ? Math.max(0.05, scale * 0.015) : scale * 0.015
  return Math.abs(left.value - right.value) <= tolerance
}

export function keyNumbersCompatible(leftValues: string[], rightValues: string[]) {
  if (!leftValues.length || !rightValues.length) return true
  return leftValues.some((left) => {
    const comparableLeft = comparableNumber(left)
    return rightValues.some((right) => {
      const comparableRight = comparableNumber(right)
      if (comparableLeft && comparableRight) return closeEnough(comparableLeft, comparableRight)
      return left === right
    })
  })
}

export function extractDates(text: string) {
  const iso = text.match(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g) ?? []
  const english = text.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?/gi) ?? []
  const chinese = text.match(/(?:20\d{2}年)?\d{1,2}月\d{1,2}日/g) ?? []
  return [...new Set([...iso, ...english, ...chinese].map((value) => value.toLocaleLowerCase().trim()))]
}

const LOCATION_ALIASES: Array<[string, RegExp]> = [
  ['china', /\bchina\b|中国/i], ['united-states', /\bunited states\b|\bU\.?S\.?\b|美国/i],
  ['europe', /\beurope\b|欧洲/i], ['middle-east', /\bmiddle east\b|中东/i],
  ['indonesia', /\bindonesia\b|印度尼西亚|印尼/i], ['south-korea', /\bsouth korea\b|韩国/i],
  ['north-korea', /\bnorth korea\b|朝鲜/i], ['israel', /\bisrael\b|以色列/i],
  ['lebanon', /\blebanon\b|黎巴嫩/i], ['iran', /\biran\b|伊朗/i], ['oman', /\boman\b|阿曼/i],
  ['pakistan', /\bpakistan\b|巴基斯坦/i], ['united-kingdom', /\bunited kingdom\b|\bUK\b|英国/i],
]

export type EventFingerprint = {
  domain: DomainId
  entities: string[]
  actions: string[]
  objects: string[]
  dates: string[]
  locations: string[]
  numbers: string[]
}

export function extractLocations(text: string) {
  return LOCATION_ALIASES.filter(([, pattern]) => pattern.test(text)).map(([location]) => location)
}

export function fingerprintText(text: string, domain: DomainId): EventFingerprint {
  const clean = stripHtml(text)
  return {
    domain,
    entities: extractEntities(clean),
    actions: [...fingerprintActions(clean, extractEventObjects(clean))],
    objects: [...extractEventObjects(clean)],
    dates: extractDates(clean),
    locations: extractLocations(clean),
    numbers: extractKeyNumbers(clean),
  }
}

export function eventFingerprint(event: NewsEvent): EventFingerprint {
  // Titles are the stable event anchor. Search snippets and page bodies may contain
  // recommendation widgets or unrelated posts, so they cannot define identity.
  return fingerprintText(event.articles.map((article) => {
    const genericTitle = /^(?:press release(?: details)?|news|article|homepage|untitled|exclusive)$/i.test(stripHtml(article.title))
    return genericTitle ? `${article.title} ${cleanEventMaterial(article.title, article.description, article.domain)}` : article.title
  }).join(' '), event.domain)
}

function overlaps(left: string[], right: string[]) {
  return left.some((value) => right.includes(value))
}

export function fingerprintMatches(reference: EventFingerprint, claim: EventFingerprint) {
  if (reference.domain !== claim.domain) return false
  const conflictingObject = reference.objects.length > 0 && claim.objects.length > 0
    && !overlaps(reference.objects, claim.objects)
  const conflictingAction = reference.actions.length > 0 && claim.actions.length > 0
    && !overlaps(reference.actions, claim.actions)
  const conflictingIndicator = reference.objects.some((object) => INDICATOR_OBJECTS.has(object))
    && claim.objects.some((object) => INDICATOR_OBJECTS.has(object))
    && !overlaps(reference.objects.filter((object) => INDICATOR_OBJECTS.has(object)), claim.objects.filter((object) => INDICATOR_OBJECTS.has(object)))
  if (conflictingIndicator || (conflictingObject && conflictingAction)) return false
  return overlaps(reference.entities, claim.entities)
    || overlaps(reference.objects, claim.objects)
    || (overlaps(reference.actions, claim.actions) && overlaps(reference.locations, claim.locations))
}

export function fingerprintConflicts(reference: EventFingerprint, claim: EventFingerprint) {
  if (reference.domain !== claim.domain) return true
  const indicatorConflict = reference.objects.some((object) => INDICATOR_OBJECTS.has(object))
    && claim.objects.some((object) => INDICATOR_OBJECTS.has(object))
    && !overlaps(reference.objects, claim.objects)
  const objectConflict = reference.objects.length > 0 && claim.objects.length > 0 && !overlaps(reference.objects, claim.objects)
  const actionConflict = reference.actions.length > 0 && claim.actions.length > 0 && !overlaps(reference.actions, claim.actions)
  const unrelatedEntities = reference.entities.length > 0 && claim.entities.length > 0 && !overlaps(reference.entities, claim.entities)
  return indicatorConflict || (objectConflict && (actionConflict || unrelatedEntities))
}

function materialSentences(value: string) {
  return stripHtml(value)
    .replace(/\b(?:copyright|all rights reserved|privacy policy|terms of use)\b[^。！？!?]*/gi, ' ')
    .replace(/(?:版权所有|保留所有权利|隐私政策|使用条款)[^。！？!?]*/g, ' ')
    .split(/(?<=[。！？!?])\s+|[\r\n]+|(?<=\.)\s+(?=[A-Z\p{Script=Han}])/u)
    .map((sentence) => sentence.replace(/^[\s|>\-–—•·]+|[\s|>\-–—•·]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 12 && !/^(?:home|menu|search|sign in|subscribe|read more|share|related|advertisement)\b/i.test(sentence))
}

export function cleanEventMaterial(title: string, value: string, domain: DomainId) {
  const cleanTitle = stripHtml(title)
  const reference = fingerprintText(cleanTitle, domain)
  const genericTitle = /^(?:press release(?: details)?|news|article|homepage|untitled|exclusive)$/i.test(cleanTitle)
  const titleTokens = textTokens(cleanTitle)
  const sentences = materialSentences(value)
  const retained = sentences.filter((sentence) => {
    const claim = fingerprintText(sentence, domain)
    const objectConflict = reference.objects.length > 0 && claim.objects.length > 0 && !overlaps(reference.objects, claim.objects)
    const indicatorConflict = reference.objects.some((object) => INDICATOR_OBJECTS.has(object))
      && claim.objects.some((object) => INDICATOR_OBJECTS.has(object))
      && !overlaps(reference.objects, claim.objects)
    if (objectConflict || indicatorConflict) return false
    const tokenOverlap = [...textTokens(sentence)].filter((token) => titleTokens.has(token)).length
    const referenceHasSignals = !genericTitle && reference.entities.length + reference.actions.length + reference.objects.length > 0
    return !referenceHasSignals || fingerprintMatches(reference, claim)
      || overlaps(reference.actions, claim.actions) || tokenOverlap >= 2
  })
  return [...new Set(retained)].join(' ').trim()
}

export function hasHtmlArtifact(value: string) {
  return /<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);|\b(?:javascript:void|document\.cookie)\b/i.test(value)
}

export function hasMeaninglessEnglishFragment(value: string) {
  const text = stripHtml(value)
  return /(?:\b[a-z]{2,}\b[\s,;:'"()\-]*){7,}/.test(text)
    || /\b(?:fri|mon|tue|wed|thu|sat|sun),?\s+\d{1,2}\/\d{1,2}\/\d{4}\s+-/i.test(text)
}

function sharedDistinctiveTerms(a: Candidate, b: Candidate) {
  const left = textTokens(`${a.title} ${a.description}`)
  const right = textTokens(`${b.title} ${b.description}`)
  const entityTokens = new Set([...extractEntities(`${a.title} ${a.description}`), ...extractEntities(`${b.title} ${b.description}`)])
  return [...left].filter((token) => right.has(token) && !entityTokens.has(token) && token.length >= 3).length
}

function fingerprintActions(text: string, objects: Set<string>) {
  const actions = extractActions(text)
  if (actions.size) return actions
  if ([...objects].some((object) => ['cpi', 'ppi', 'pce', 'earnings-results'].includes(object))) actions.add('data-release')
  if (objects.has('earthquake')) actions.add('occur')
  if (objects.has('education-policy')) actions.add('policy')
  return actions
}

export function assessEventMatch(a: Candidate, b: Candidate, strictVerification = false): { matched: boolean; reason: CandidateDecision['reason'] } {
  if (a.domain !== b.domain) return { matched: false, reason: 'event-mismatch' }
  if (cleanUrl(a.url) === cleanUrl(b.url)) return { matched: true, reason: 'accepted' }
  const leftTime = new Date(a.publishedAt).getTime()
  const rightTime = new Date(b.publishedAt).getTime()
  const hasReliableTime = Number.isFinite(leftTime) && Number.isFinite(rightTime)
  const timeDistanceHours = hasReliableTime ? Math.abs(leftTime - rightTime) / 3_600_000 : Number.POSITIVE_INFINITY
  if (hasReliableTime && timeDistanceHours > 72) return { matched: false, reason: 'event-mismatch' }

  const titleScore = titleSimilarity(a.title, b.title)
  const descriptionScore = setSimilarity(textTokens(a.description), textTokens(b.description))
  const leftText = `${a.title} ${a.description}`
  const rightText = `${b.title} ${b.description}`
  const leftEntities = new Set(extractEntities(leftText))
  const rightEntities = new Set(extractEntities(rightText))
  const entityScore = overlapCoefficient(leftEntities, rightEntities)
  const leftObjects = extractEventObjects(leftText)
  const rightObjects = extractEventObjects(rightText)
  const leftIndicators = new Set([...leftObjects].filter((object) => INDICATOR_OBJECTS.has(object)))
  const rightIndicators = new Set([...rightObjects].filter((object) => INDICATOR_OBJECTS.has(object)))
  const objectScore = overlapCoefficient(leftObjects, rightObjects)
  if (leftIndicators.size && rightIndicators.size && overlapCoefficient(leftIndicators, rightIndicators) === 0) {
    return { matched: false, reason: 'indicator-mismatch' }
  }
  if (leftObjects.size && rightObjects.size && objectScore === 0) return { matched: false, reason: 'object-mismatch' }
  const leftActions = fingerprintActions(leftText, leftObjects)
  const rightActions = fingerprintActions(rightText, rightObjects)
  const actionScore = overlapCoefficient(leftActions, rightActions)
  if (leftActions.size && rightActions.size && actionScore === 0) return { matched: false, reason: 'action-mismatch' }
  const leftNumbers = extractKeyNumbers(leftText)
  const rightNumbers = extractKeyNumbers(rightText)
  if (!keyNumbersCompatible(leftNumbers, rightNumbers)) return { matched: false, reason: 'number-mismatch' }

  const tagScore = overlapCoefficient(new Set(a.tags), new Set(b.tags))
  const distinctiveTerms = sharedDistinctiveTerms(a, b)
  if (entityScore === 0 && titleScore < 0.86) return { matched: false, reason: 'entity-mismatch' }
  if (strictVerification && (!leftEntities.size || !rightEntities.size || entityScore === 0)) return { matched: false, reason: 'entity-mismatch' }
  if (strictVerification && (!leftActions.size || !rightActions.size || actionScore === 0)) return { matched: false, reason: 'action-mismatch' }
  if (strictVerification && (!leftObjects.size || !rightObjects.size || objectScore === 0)) return { matched: false, reason: 'object-mismatch' }
  const completeFingerprint = entityScore > 0 && actionScore > 0 && objectScore > 0 && hasReliableTime
  if (completeFingerprint && !strictVerification) return { matched: true, reason: 'accepted' }
  if (!leftObjects.size && !rightObjects.size && distinctiveTerms < 2 && titleScore < 0.88) {
    return { matched: false, reason: 'object-mismatch' }
  }
  if (!distinctiveTerms && titleScore < 0.58 && descriptionScore < 0.55) return { matched: false, reason: 'event-mismatch' }

  const timeBoost = hasReliableTime && timeDistanceHours <= 24 ? 0.08 : hasReliableTime && timeDistanceHours <= 48 ? 0.04 : 0
  const score = titleScore * 0.28
    + descriptionScore * 0.16
    + entityScore * 0.22
    + actionScore * 0.15
    + objectScore * 0.16
    + tagScore * 0.03
    + timeBoost
  if (strictVerification) return { matched: completeFingerprint, reason: completeFingerprint ? 'accepted' : 'event-mismatch' }
  const matched = (completeFingerprint && score >= 0.43)
    || (titleScore >= 0.9 && entityScore > 0 && (objectScore > 0 || actionScore > 0))
  return { matched, reason: matched ? 'accepted' : 'event-mismatch' }
}

export function eventMatch(a: Candidate, b: Candidate) {
  return assessEventMatch(a, b).matched
}

function detectTags(config: DomainConfig, text: string) {
  const tags = config.tagRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.tag)
  return tags.length ? tags.slice(0, 3) : [config.title.split(' · ')[0]]
}

const OFFICIAL_DOMAIN_AFFINITY: Record<DomainId, string[]> = {
  'ai-tech': ['openai.com', 'anthropic.com', 'nvidia.com', 'amd.com', 'intel.com', 'tsmc.com', 'microsoft.com', 'google.com'],
  markets: ['federalreserve.gov', 'bls.gov', 'bea.gov', 'sec.gov', 'eia.gov', 'treasury.gov', 'imf.org', 'worldbank.org'],
  world: ['un.org', 'nato.int', 'consilium.europa.eu', 'ec.europa.eu', 'whitehouse.gov'],
  learning: ['ibo.org', 'oecd.org', 'unesco.org', 'worldbank.org'],
}

const LEARNING_PRIORITY_PATTERN = /\bIB\b|international baccalaureate|\bOECD\b|\bPISA\b|\bUNESCO\b|AI literacy|artificial intelligence literacy|assessment|learning science|curriculum reform|education reform|national education policy|国际文凭|经合组织|联合国教科文组织|人工智能素养|AI 素养|评估|学习科学|课程改革|教育改革|国家教育政策/i
const LEARNING_LOCAL_PATTERN = /local school|school board|school district|campus event|campus police|principal appointed|superintendent|地方学校|学区|校园活动|校长任命|校园治安/i
const LEARNING_NATIONAL_IMPACT_PATTERN = /national|nationwide|federal|ministry|department of education|supreme court|constitutional|全国|国家级|联邦|教育部|最高法院|违宪/i

export function learningPersonalRelevance(text: string) {
  const priorityMatches = text.match(new RegExp(LEARNING_PRIORITY_PATTERN.source, 'gi'))?.length ?? 0
  const localOnly = LEARNING_LOCAL_PATTERN.test(text) && !LEARNING_NATIONAL_IMPACT_PATTERN.test(text)
  return { score: Math.min(24, priorityMatches * 8) - (localOnly ? 24 : 0), priorityMatches, localOnly }
}

export function domainMatchSignals(config: DomainConfig, text: string, query = '', source?: FeedSource) {
  const lower = text.toLocaleLowerCase()
  const topics = config.topicTerms.filter((term) => lower.includes(term)).length
  const impacts = config.impactTerms.filter((term) => lower.includes(term)).length
  const tags = config.tagRules.filter((rule) => rule.pattern.test(text)).length
  const queryTokens = textTokens(query)
  const candidateTokens = textTokens(text)
  const queryMatches = [...queryTokens].filter((token) => candidateTokens.has(token)).length
  const entities = extractEntities(text).length
  const actions = extractActions(text).size
  const officialAffinity = Boolean(source?.type === 'official'
    && OFFICIAL_DOMAIN_AFFINITY[config.id].some((host) => source.id === host || source.id.endsWith(`.${host}`)))
  const learningFit = config.id === 'learning' ? learningPersonalRelevance(text) : null
  const score = topics * 4 + impacts * 1.5 + tags * 2.5 + Math.min(queryMatches, 5) * 1.25
    + Math.min(entities, 3) + Math.min(actions, 2) * 1.5 + (officialAffinity ? 8 : 0) + (learningFit?.score ?? 0)
  const relevant = topics > 0
    || officialAffinity
    || (tags > 0 && (entities > 0 || actions > 0 || queryMatches > 0))
    || (queryMatches >= 2 && (entities > 0 || actions > 0))
  return { score, relevant, topics, impacts, tags, queryMatches, entities, actions, officialAffinity, learningFit }
}

export function domainRelevanceScore(config: DomainConfig, text: string, query = '', source?: FeedSource) {
  return domainMatchSignals(config, text, query, source).score
}

function isRelevant(config: DomainConfig, text: string, query = '', source?: FeedSource) {
  return domainMatchSignals(config, text, query, source).relevant
}

function scoreCandidate(
  config: DomainConfig,
  source: FeedSource,
  publishedAt: string,
  text: string,
  now: Date,
  dateConfidence: Candidate['dateConfidence'] = 'reliable',
) {
  const publishedTime = new Date(publishedAt).getTime()
  const ageHours = Number.isFinite(publishedTime)
    ? Math.max(0, (now.getTime() - publishedTime) / 3_600_000)
    : Number.POSITIVE_INFINITY
  const freshness = Number.isFinite(ageHours) ? Math.max(0, 36 - ageHours / 4) : 0
  const lower = text.toLocaleLowerCase()
  const impact = config.impactTerms.reduce((score, term) => score + (lower.includes(term) ? 2.5 : 0), 0)
  const detail = Math.min(8, text.length / 220)
  const uncertainDatePenalty = dateConfidence === 'unknown' ? 20 : 0
  const learningAdjustment = config.id === 'learning' ? learningPersonalRelevance(text).score : 0
  return source.weight + freshness + Math.min(impact, 18) + detail + learningAdjustment - uncertainDatePenalty
}

function explicitWireKey(candidate: Pick<Candidate, 'source' | 'title' | 'description'>) {
  const material = `${candidate.title} ${candidate.description}`
  if (/\breuters\b|路透(?:社)?/i.test(material) || candidate.source.id.includes('reuters')) return 'wire:reuters'
  if (/\bassociated press\b|\bAP News\b|美联社/i.test(material) || candidate.source.id.includes('apnews')) return 'wire:ap'
  if (/\bagence france-presse\b|\bAFP\b|法新社/i.test(material)) return 'wire:afp'
  if (/\bxinhua\b|新华社|新华网/i.test(material)) return 'wire:xinhua'
  if (/\bpr newswire\b|美通社/i.test(material)) return 'wire:pr-newswire'
  if (/\bbusiness wire\b/i.test(material)) return 'wire:business-wire'
  return null
}

export function sourceIndependenceKey(candidate: Pick<Candidate, 'source' | 'title' | 'description' | 'independenceKey'>) {
  const wire = explicitWireKey(candidate)
  if (wire) return wire
  if (candidate.independenceKey) return candidate.independenceKey
  return `publisher:${candidate.source.id}`
}

function contentSimilarity(left: Candidate, right: Candidate) {
  const title = titleSimilarity(left.title, right.title)
  const description = setSimilarity(textTokens(left.description), textTokens(right.description))
  const exactTitle = normalizeTitle(left.title) === normalizeTitle(right.title)
  const exactDescription = Boolean(left.description && normalizeTitle(left.description) === normalizeTitle(right.description))
  return { title, description, exactTitle, exactDescription }
}

export function diagnoseSyndication(articles: Candidate[]) {
  const effectiveKeys = new Map(articles.map((article) => [article.id, sourceIndependenceKey(article)]))
  const findings: SyndicationFinding[] = []
  for (let leftIndex = 0; leftIndex < articles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < articles.length; rightIndex += 1) {
      const left = articles[leftIndex]
      const right = articles[rightIndex]
      if (left.source.id === right.source.id) continue
      const leftWire = explicitWireKey(left)
      const rightWire = explicitWireKey(right)
      const similarity = contentSimilarity(left, right)
      const reasons: string[] = []
      const sameCanonicalUrl = cleanUrl(left.url) === cleanUrl(right.url)
      if (leftWire && rightWire && leftWire === rightWire) reasons.push('explicit-wire-attribution')
      if (sameCanonicalUrl) reasons.push('canonical-url')
      if (similarity.exactTitle) reasons.push('exact-title-fingerprint')
      if (similarity.exactDescription) reasons.push('exact-summary-fingerprint')
      if (similarity.title >= 0.9) reasons.push('strong-title-fingerprint')
      if (similarity.description >= 0.9) reasons.push('strong-summary-fingerprint')
      const wireKey = leftWire ?? rightWire
        ?? (sameCanonicalUrl ? `content:url:${createHash('sha1').update(cleanUrl(left.url)).digest('hex').slice(0, 12)}` : null)
        ?? (similarity.exactTitle && similarity.exactDescription
          ? `content:fingerprint:${createHash('sha1').update(`${normalizeTitle(left.title)}:${normalizeTitle(left.description)}`).digest('hex').slice(0, 12)}`
          : null)
      const high = Boolean(
        sameCanonicalUrl
        || (similarity.exactTitle && similarity.exactDescription)
        || (leftWire && rightWire && leftWire === rightWire)
        || (wireKey && (similarity.exactTitle || similarity.exactDescription || (similarity.title >= 0.9 && similarity.description >= 0.82))),
      )
      const medium = !high && Boolean(
        wireKey && (similarity.title >= 0.75 || similarity.description >= 0.72)
        || similarity.exactTitle
        || (similarity.title >= 0.84 && similarity.description >= 0.72),
      )
      if (!high && !medium) continue
      const confidence = high ? 'high' : 'medium'
      findings.push({ leftId: left.id, rightId: right.id, confidence, wireKey, reasons })
      if (high && wireKey) {
        effectiveKeys.set(left.id, wireKey)
        effectiveKeys.set(right.id, wireKey)
      }
    }
  }
  return {
    effectiveKeys,
    findings: findings.sort((left, right) => left.leftId.localeCompare(right.leftId) || left.rightId.localeCompare(right.rightId)),
  }
}

async function fetchSource(
  config: DomainConfig,
  source: FeedSource,
  now: Date,
  onDecision?: (decision: CandidateDecision) => void,
): Promise<Candidate[]> {
  const feed = await parser.parseURL(source.url)
  return feed.items.flatMap((item) => {
    const title = stripHtml(item.title ?? '')
    const description = cleanEventMaterial(title, item.content ?? item.contentSnippet ?? item.summary ?? '', config.id)
    const url = cleanUrl(item.link ?? item.guid ?? '')
    const rawDate = item.isoDate ?? item.pubDate ?? ''
    const parsedDate = rawDate ? new Date(rawDate) : now
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? now.toISOString() : parsedDate.toISOString()
    const ageDays = (now.getTime() - new Date(publishedAt).getTime()) / 86_400_000
    const text = `${title} ${description}`
    const rejectedReason = !title || !url ? 'missing-title-or-url'
      : isNonArticlePage(title, url, description) ? 'non-article-page'
        : ageDays > config.sourceWindowDays ? 'expired'
        : ageDays < -1 ? 'future-dated'
          : !source.focused && !isRelevant(config, text) ? 'irrelevant'
            : null
    if (rejectedReason) {
      onDecision?.({
        domain: config.id, stage: 'rss', accepted: false, reason: rejectedReason,
        title, url, sourceId: source.id, sourceName: source.name, publishedAt,
        dateConfidence: 'reliable',
      })
      return []
    }
    const candidate: Candidate = {
      id: createHash('sha1').update(`${config.id}:${source.id}:${url || title}`).digest('hex').slice(0, 12),
      domain: config.id,
      title,
      description,
      url,
      publishedAt,
      dateConfidence: 'reliable',
      source,
      score: scoreCandidate(config, source, publishedAt, text, now),
      tags: detectTags(config, text),
      discoveryMethod: 'rss',
      materialLevel: 'snippet-only',
      independenceKey: `publisher:${source.id}`,
    }
    onDecision?.({
      domain: config.id, stage: 'rss', accepted: true, reason: 'accepted', candidateId: candidate.id,
      title, url, sourceId: source.id, sourceName: source.name, publishedAt,
      dateConfidence: candidate.dateConfidence, score: candidate.score,
    })
    return [candidate]
  })
}

export function assessSearchHit(
  config: DomainConfig,
  hit: SearchHit,
  query: string,
  now: Date,
  phase: SearchPhase = 'base',
): { candidate: Candidate | null; decision: CandidateDecision } {
  const title = stripHtml(hit.title)
  const description = cleanEventMaterial(title, hit.snippet, config.id)
  const url = cleanUrl(hit.url)
  const text = `${title} ${description}`
  const source = sourceForSearchResult(url, hit.publisher)
  const baseDecision = {
    domain: config.id,
    stage: phase,
    title,
    url,
    sourceId: source.id,
    sourceName: source.name,
    publishedAt: '',
    dateConfidence: 'unknown' as Candidate['dateConfidence'],
    query,
  }
  if (!title || !url) return { candidate: null, decision: { ...baseDecision, accepted: false, reason: 'missing-title-or-url' } }
  if (isNonArticlePage(title, url, description)) return { candidate: null, decision: { ...baseDecision, accepted: false, reason: 'non-article-page' } }
  const match = domainMatchSignals(config, text, query, source)
  if (!match.relevant) return { candidate: null, decision: { ...baseDecision, accepted: false, reason: 'irrelevant' } }
  const parsedTime = hit.publishedAt?.trim() ? new Date(hit.publishedAt).getTime() : Number.NaN
  const dateConfidence: Candidate['dateConfidence'] = Number.isFinite(parsedTime) ? 'reliable' : 'unknown'
  const publishedAt = dateConfidence === 'reliable' ? new Date(parsedTime).toISOString() : ''
  if (dateConfidence === 'reliable') {
    const ageDays = (now.getTime() - parsedTime) / 86_400_000
    if (ageDays > config.sourceWindowDays) return {
      candidate: null,
      decision: { ...baseDecision, accepted: false, reason: 'expired', publishedAt, dateConfidence },
    }
    if (ageDays < -1) return {
      candidate: null,
      decision: { ...baseDecision, accepted: false, reason: 'future-dated', publishedAt, dateConfidence },
    }
  }
  const candidate: Candidate = {
    id: createHash('sha1').update(`${config.id}:search:${url}`).digest('hex').slice(0, 12),
    domain: config.id,
    title,
    description,
    url,
    publishedAt,
    dateConfidence,
    source,
    score: scoreCandidate(config, source, publishedAt, text, now, dateConfidence)
      + Math.min(12, match.score / 2)
      + Math.max(0, Math.min(6, (hit.score ?? 0) * 6)),
    tags: detectTags(config, text),
    discoveryMethod: discoveryMethodForQuery(query, source),
    materialLevel: 'snippet-only',
    independenceKey: `publisher:${source.id}`,
    query,
    relevanceScore: match.score,
    searchPhase: phase,
  }
  return {
    candidate,
    decision: {
      ...baseDecision,
      accepted: true,
      reason: 'accepted',
      candidateId: candidate.id,
      publishedAt,
      dateConfidence,
      score: candidate.score,
    },
  }
}

export function candidateFromSearchHit(
  config: DomainConfig,
  hit: SearchHit,
  query: string,
  now: Date,
  phase: SearchPhase = 'base',
): Candidate | null {
  return assessSearchHit(config, hit, query, now, phase).candidate
}

const ENTITY_QUERY_LABELS: Record<string, string> = {
  'federal-reserve': 'Federal Reserve 美联储',
  'united-nations': 'United Nations 联合国',
  'united-states': 'United States 美国',
  'european-union': 'European Union 欧盟',
  'international-baccalaureate': 'International Baccalaureate IB 国际文凭',
  'world-bank': 'World Bank 世界银行',
}

const EVENT_OBJECT_QUERY_LABELS: Record<string, string> = {
  cpi: 'CPI consumer prices',
  ppi: 'PPI producer prices',
  pce: 'PCE inflation',
  'interest-rate': 'interest rate',
  'bond-yield': 'bond yield',
  'earnings-results': 'earnings results',
  'product-release': 'product launch',
  'acquisition-target': 'acquisition',
  'funding-round': 'funding',
  'factory-capacity': 'factory capacity',
  'data-center': 'data center',
  'ai-center': 'AI center',
  'course-curriculum': 'course curriculum',
  assessment: 'assessment',
  'ai-literacy': 'AI literacy',
  'education-policy': 'education policy',
  'sanctions-controls': 'sanctions export controls',
  'military-strike': 'military strike',
  'ceasefire-talks': 'ceasefire talks',
  'shipping-route': 'shipping route',
  'oil-price': 'oil price',
  earthquake: 'earthquake',
}

function usefulQueryEntity(entity: string) {
  const normalized = entity.toLocaleLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim()
  if (!normalized || GENERIC_ENTITY_WORDS.has(normalized) || TOKEN_STOP_WORDS.has(normalized)) return false
  const words = normalized.split(' ')
  if (words.length > 4 || words.every((word) => TOKEN_STOP_WORDS.has(word))) return false
  return !/^(?:archive|news|latest|report|homepage|read|more|sign|log)(?:\s|$)/i.test(normalized)
}

function matchedPreviousAnchors(event: NewsEvent, previousSignals: string[]) {
  const eventText = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const eventEntities = new Set(extractEntities(eventText))
  const eventActions = fingerprintActions(eventText, extractEventObjects(eventText))
  const eventObjects = extractEventObjects(eventText)
  const eventNumbers = extractKeyNumbers(eventText)
  for (const signal of previousSignals.filter(Boolean).slice(0, 20)) {
    const entities = extractEntities(signal).filter((entity) => eventEntities.has(entity) && usefulQueryEntity(entity))
    const actions = [...extractActions(signal)].filter((action) => eventActions.has(action))
    const objects = [...extractEventObjects(signal)].filter((object) => eventObjects.has(object))
    const numbers = extractKeyNumbers(signal).filter((number) => keyNumbersCompatible([number], eventNumbers))
    if (entities.length && (actions.length || objects.length || numbers.length)) {
      return [...entities.slice(0, 1), ...actions.slice(0, 1), ...objects.slice(0, 1).map((object) => EVENT_OBJECT_QUERY_LABELS[object] ?? object), ...numbers.slice(0, 1).map(keyNumberQueryLabel)]
    }
  }
  return []
}

export function buildDynamicQueryForEvent(event: NewsEvent, previousSignals: string[] = []) {
  const text = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const objects = extractEventObjects(text)
  const entities = extractEntities(text)
    .filter(usefulQueryEntity)
    .sort((left, right) => Number(ENTITY_QUERY_LABELS[right] !== undefined) - Number(ENTITY_QUERY_LABELS[left] !== undefined)
      || left.length - right.length || left.localeCompare(right))
    .slice(0, 3)
    .map((entity) => ENTITY_QUERY_LABELS[entity] ?? entity)
  const actions = [...fingerprintActions(text, objects)].slice(0, 2)
  const objectLabels = [...objects].slice(0, 2).map((object) => EVENT_OBJECT_QUERY_LABELS[object] ?? object)
  const numbers = extractKeyNumbers(text).slice(0, 2).map(keyNumberQueryLabel)
  const date = Number.isFinite(new Date(event.publishedAt).getTime()) ? event.publishedAt.slice(0, 10) : ''
  const previousAnchors = matchedPreviousAnchors(event, previousSignals)
  return [...new Set([...entities, ...actions, ...objectLabels, ...numbers, date, ...previousAnchors])]
    .filter((value) => value && !/^(?:archive|news|latest|report)$/i.test(value))
    .join(' ').replace(/\s+/g, ' ').trim()
}

export function buildDynamicQueries(
  domain: DomainId,
  baseCandidates: Candidate[],
  previousSignals: string[] = [],
  now = new Date(),
) {
  const seeds = clusterCandidates(deduplicateCandidates(baseCandidates))
    .sort((left, right) => compareCandidates(left.primaryArticle, right.primaryArticle))
  const queries = seeds.map((event) => buildDynamicQueryForEvent(event, previousSignals)).filter(Boolean)
  if (queries.length >= 2) return [...new Set(queries)].slice(0, 2)
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
  const fallback = `${DOMAIN_CONFIGS[domain].topicTerms.slice(0, 4).join(' ')} ${date}`.trim()
  const fallbackIndependent = `${DOMAIN_CONFIGS[domain].topicTerms.slice(4, 8).join(' ') || DOMAIN_CONFIGS[domain].topicTerms.slice(0, 4).join(' ')} ${date} independent`.trim()
  return [...new Set([...queries, fallback, fallbackIndependent])].slice(0, 2)
}

export async function collectSearchCandidates(
  domain: DomainId,
  runtime: SearchRuntime,
  now = new Date(),
  previousSignals: string[] = [],
  onDecision?: (decision: CandidateDecision) => void,
) {
  if (!runtime.enabled) return []
  const config = DOMAIN_CONFIGS[domain]
  const baseQueries = buildDiscoveryQueries(domain, runtime.baseDiscoveryQueriesPerDomain)
  const baseBatches = await Promise.all(baseQueries.map(async (query) => {
    const hits = await runtime.search(query, 8, searchOptionsForDomain(domain, now, query), { domain, phase: 'base' })
    return hits.flatMap((hit) => {
      const assessment = assessSearchHit(config, hit, query, now, 'base')
      onDecision?.(assessment.decision)
      return assessment.candidate ? [assessment.candidate] : []
    })
  }))
  const baseCandidates = baseBatches.flat().sort(compareCandidates)
  const dynamicQueries = buildDynamicQueries(domain, baseCandidates, previousSignals, now)
  const dynamicBatches = await Promise.all(dynamicQueries.map(async (query) => {
    const hits = await runtime.search(query, 8, searchOptionsForDomain(domain, now, query), { domain, phase: 'dynamic' })
    return hits.flatMap((hit) => {
      const assessment = assessSearchHit(config, hit, query, now, 'dynamic')
      onDecision?.(assessment.decision)
      return assessment.candidate ? [assessment.candidate] : []
    })
  }))
  return [...baseCandidates, ...dynamicBatches.flat()].sort(compareCandidates)
}

export function compareCandidates(a: Candidate, b: Candidate) {
  const scoreDifference = b.score - a.score
  if (scoreDifference) return scoreDifference
  const confidenceDifference = Number(b.dateConfidence !== 'unknown') - Number(a.dateConfidence !== 'unknown')
  if (confidenceDifference) return confidenceDifference
  const leftTime = new Date(a.publishedAt).getTime()
  const rightTime = new Date(b.publishedAt).getTime()
  const timeDifference = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
  if (timeDifference) return timeDifference
  return cleanUrl(a.url).localeCompare(cleanUrl(b.url))
    || a.domain.localeCompare(b.domain)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id)
}

export function deduplicateCandidates(candidates: Candidate[]) {
  const sorted = [...candidates].sort(compareCandidates)
  const accepted: Candidate[] = []
  for (const candidate of sorted) {
    const duplicateIndex = accepted.findIndex((item) =>
      cleanUrl(item.url) === cleanUrl(candidate.url)
      || normalizeTitle(item.title) === normalizeTitle(candidate.title)
      || titleSimilarity(item.title, candidate.title) >= 0.94,
    )
    if (duplicateIndex === -1) {
      accepted.push({ ...candidate, duplicates: candidate.duplicates ? [...candidate.duplicates] : undefined })
    } else {
      const duplicate = accepted[duplicateIndex]
      accepted[duplicateIndex] = {
        ...duplicate,
        duplicates: [...(duplicate.duplicates ?? []), candidate, ...(candidate.duplicates ?? [])],
      }
    }
  }
  return accepted
}

function uniqueArticles(candidates: Candidate[]) {
  const byId = new Map<string, Candidate>()
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate)
    for (const duplicate of candidate.duplicates ?? []) byId.set(duplicate.id, duplicate)
  }
  return [...byId.values()].map(({ duplicates: _duplicates, ...candidate }) => candidate)
}

export function buildEvidence(articles: Candidate[]): EventEvidence {
  const uniqueSources = new Map(articles.map((article) => [article.source.id, article.source]))
  const sources = [...uniqueSources.values()]
  const primarySourcePresent = sources.some((source) => source.reliability === 'primary')
  const syndication = diagnoseSyndication(articles)
  const reliableIndependentSources = new Set(
    articles
      .filter((article) => article.source.reliability === 'tier-1' || article.source.reliability === 'tier-2')
      .map((article) => syndication.effectiveKeys.get(article.id) ?? sourceIndependenceKey(article)),
  )
  const independentSourceCount = reliableIndependentSources.size
  const sourceCount = sources.length
  const rumorLike = articles.some((article) => RUMOR_PATTERN.test(`${article.title} ${article.description}`))

  let level: EventEvidence['level']
  if (primarySourcePresent && independentSourceCount >= 1) level = 'confirmed'
  else if (independentSourceCount >= 2) level = 'corroborated'
  else if (sourceCount === 1 && rumorLike) level = 'unverified'
  else if (sourceCount === 1) level = 'single-source'
  else level = 'unverified'

  return { level, sourceCount, independentSourceCount, primarySourcePresent }
}

export function createEvent(domain: DomainId, members: Candidate[]): NewsEvent {
  const representatives = [...members].sort(compareCandidates)
  const primaryArticle = representatives[0]
  const articles = uniqueArticles(representatives)
  const publishedTimes = articles.map((article) => new Date(article.publishedAt).getTime()).filter(Number.isFinite)
  const publishedAt = new Date(Math.min(...publishedTimes)).toISOString()
  const latestUpdateAt = new Date(Math.max(...publishedTimes)).toISOString()
  const entities = [...new Set(articles.flatMap((article) => extractEntities(article.title)))]
  const topicTags = [...new Set(articles.flatMap((article) => article.tags))].slice(0, 6)
  const evidence = buildEvidence(articles)
  const syndication = diagnoseSyndication(articles)
  const datedArticles = articles
    .map((article) => ({ id: article.id, sourceId: article.source.id, time: new Date(article.publishedAt).getTime() }))
    .filter((article) => Number.isFinite(article.time))
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
  const dateSpreadHours = datedArticles.length > 1
    ? (datedArticles.at(-1)!.time - datedArticles[0].time) / 3_600_000
    : 0
  const dateConflict = dateSpreadHours > 24 && new Set(datedArticles.map((article) => article.sourceId)).size > 1 ? {
    earliestPublishedAt: new Date(datedArticles[0].time).toISOString(),
    latestPublishedAt: new Date(datedArticles.at(-1)!.time).toISOString(),
    spreadHours: Math.round(dateSpreadHours * 10) / 10,
    articleIds: datedArticles.map((article) => article.id),
  } : undefined
  const id = createHash('sha1').update(`${domain}:event:${primaryArticle.id}`).digest('hex').slice(0, 12)
  return {
    id,
    domain,
    canonicalTitle: primaryArticle.title,
    articles,
    primaryArticle,
    entities,
    topicTags,
    publishedAt,
    latestUpdateAt,
    sourceCount: evidence.sourceCount,
    evidence,
    dateConflict,
    syndicationWarnings: syndication.findings.filter((finding) => finding.confidence === 'medium'),
  }
}

export function clusterCandidates(candidates: Candidate[]) {
  const sorted = [...candidates].sort(compareCandidates)
  const clusters: Candidate[][] = []
  for (const candidate of sorted) {
    const cluster = clusters.find((members) => members.every((member) => eventMatch(member, candidate)))
    if (cluster) cluster.push(candidate)
    else clusters.push([candidate])
  }
  return clusters
    .filter((members) => members.some((candidate) => Number.isFinite(new Date(candidate.publishedAt).getTime())))
    .map((members) => createEvent(members[0].domain, members))
    .sort((a, b) => compareCandidates(a.primaryArticle, b.primaryArticle))
}

export function crossDomainEventMatch(left: NewsEvent, right: NewsEvent) {
  const leftTime = new Date(left.latestUpdateAt).getTime()
  const rightTime = new Date(right.latestUpdateAt).getTime()
  const timeDistance = Math.abs(leftTime - rightTime) / 3_600_000
  if (!Number.isFinite(timeDistance) || timeDistance > 72) return false
  if (left.articles.some((article) => right.articles.some((other) => cleanUrl(article.url) === cleanUrl(other.url)))) return true
  if (normalizeTitle(left.canonicalTitle) === normalizeTitle(right.canonicalTitle)) return true

  const leftText = left.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const rightText = right.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const entityScore = overlapCoefficient(new Set(extractEntities(leftText)), new Set(extractEntities(rightText)))
  const leftObjects = extractEventObjects(leftText)
  const rightObjects = extractEventObjects(rightText)
  const objectScore = overlapCoefficient(leftObjects, rightObjects)
  const leftIndicators = new Set([...leftObjects].filter((object) => INDICATOR_OBJECTS.has(object)))
  const rightIndicators = new Set([...rightObjects].filter((object) => INDICATOR_OBJECTS.has(object)))
  if (leftIndicators.size && rightIndicators.size && overlapCoefficient(leftIndicators, rightIndicators) === 0) return false
  if (leftObjects.size && rightObjects.size && objectScore === 0) return false
  const leftActions = fingerprintActions(leftText, leftObjects)
  const rightActions = fingerprintActions(rightText, rightObjects)
  const actionScore = overlapCoefficient(leftActions, rightActions)
  if (leftActions.size && rightActions.size && actionScore === 0) return false
  const leftNumbers = extractKeyNumbers(leftText)
  const rightNumbers = extractKeyNumbers(rightText)
  if (!keyNumbersCompatible(leftNumbers, rightNumbers)) return false
  const titleScore = titleSimilarity(left.canonicalTitle, right.canonicalTitle)
  return titleScore >= 0.9 || (entityScore > 0 && actionScore > 0 && objectScore > 0)
}

export function eventDomainFit(event: NewsEvent, domain: DomainId) {
  const config = DOMAIN_CONFIGS[domain]
  const matches = event.articles.map((article) => domainMatchSignals(
    config,
    `${article.title} ${article.description} ${article.fullText ?? ''}`,
    article.query ?? '',
    article.source,
  ))
  const best = Math.max(0, ...matches.map((match) => match.score))
  const evidence = event.evidence.level === 'confirmed' ? 8
    : event.evidence.level === 'corroborated' ? 6
      : event.evidence.level === 'single-source' ? 1
        : -3
  const text = event.articles.map((article) => `${article.title} ${article.description}`).join(' ')
  const featureDepth = Math.min(3, extractEntities(text).length)
    + Math.min(2, extractActions(text).size)
    + Math.min(2, extractEventObjects(text).size)
    + Math.min(2, extractKeyNumbers(text).length) * 0.5
    + (Number.isFinite(new Date(event.publishedAt).getTime()) ? 1 : 0)
  return best + evidence + featureDepth + (domain === 'learning' ? learningPersonalRelevance(text).score : 0)
}

function buildEventLayer(collection: CollectionResult) {
  const deduped = deduplicateCandidates(collection.candidates)
  const events = clusterCandidates(deduped)
  return { deduped, events }
}

export function selectDiverseStories(candidates: Candidate[], limit = 5) {
  const selected: Candidate[] = []
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if ((counts.get(candidate.source.id) ?? 0) >= 2) continue
    selected.push(candidate)
    counts.set(candidate.source.id, (counts.get(candidate.source.id) ?? 0) + 1)
    if (selected.length === limit) return selected
  }
  for (const candidate of candidates) {
    if (!selected.includes(candidate)) selected.push(candidate)
    if (selected.length === limit) break
  }
  return selected
}

function rankedEventCandidates(events: NewsEvent[]) {
  return events.map((event) => ({ ...event.primaryArticle, id: event.id }))
}

function selectDiverseEvents(events: NewsEvent[], limit = 5) {
  const byId = new Map(events.map((event) => [event.id, event]))
  return selectDiverseStories(rankedEventCandidates(events), limit)
    .map((candidate) => byId.get(candidate.id))
    .filter((event): event is NewsEvent => Boolean(event))
}

export function buildCandidatePool(collection: CollectionResult, limit = 60) {
  const { events } = buildEventLayer(collection)
  const previousTitles = collection.previousTitles ?? []
  return events
    .map((event) => ({
      event,
      adjustedScore: event.primaryArticle.score
        - (previousTitles.some((title) => titleSimilarity(title, event.canonicalTitle) >= 0.62) ? 18 : 0),
    }))
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .map(({ event }) => event)
    .slice(0, Math.max(1, Math.min(60, limit)))
}

function shorten(text: string, max = 180) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text
}

function containsEnoughChinese(text: string) {
  const letters = text.replace(/\s|[\p{P}\p{S}\d]/gu, '')
  return letters.length > 0 && (letters.match(/[\p{Script=Han}]/gu) ?? []).length / letters.length >= 0.35
}

const PLACEHOLDER_TITLE_PATTERNS = [
  /(?:来源|公司|机构|[\w.-]+\.com|[\w.-]+\.org|[\w.-]+\.gov|[\w.-]+\.edu|blog|news|cnbc|bbc|dw|techcrunch).{0,24}(?:发布|披露|提供).{0,18}(?:相关)?(?:更新|信息)$/iu,
  /^.{2,40}(?:发布|披露|提供)(?:了)?(?:与)?(?:当前)?[^：:，。]{1,24}(?:相关)?(?:更新|信息)$/u,
  /(?:发布|披露|提供)(?:了)?(?:与)?(?:当前)?(?:主题|事件|领域).{0,12}(?:相关)?(?:更新|信息)$/u,
]

const PLACEHOLDER_SUMMARY_PATTERNS = [
  /来源材料(?:发布|披露|提供)了?与当前(?:主题|事件)相关的(?:新)?信息/u,
  /这里仅保留(?:原文可以直接支持的)?(?:定性事实|定性结论)/u,
  /具体细节以来源(?:页面|材料|原文)为准/u,
  /未获来源明确确认的细节不作推断/u,
  /现有来源材料明确记录了?这一具体动作/u,
  /(?:来源|原文)(?:已|明确)?(?:确认|记录|支持)(?:了)?(?:上述|这一|该)(?:动作|事件|说法)/u,
]

const ENTITY_LABELS: Record<string, string> = {
  openai: 'OpenAI', nvidia: 'NVIDIA', google: 'Google', anthropic: 'Anthropic', microsoft: '微软', meta: 'Meta',
  apple: '苹果', amazon: '亚马逊', amd: 'AMD', intel: '英特尔', tsmc: '台积电',
  'federal-reserve': '美联储', sec: '美国证交会', bls: '美国劳工统计局',
  'united-nations': '联合国', china: '中国', 'united-states': '美国', 'european-union': '欧盟',
  oecd: 'OECD', unesco: 'UNESCO', 'international-baccalaureate': 'IB', 'world-bank': '世界银行', imf: 'IMF',
  'sk-hynix': 'SK海力士', 'berkshire-hathaway': '伯克希尔', alphabet: 'Alphabet', grok: 'Grok',
  'mit-sloan': 'MIT斯隆管理学院', israel: '以色列', iran: '伊朗', oman: '阿曼', indonesia: '印度尼西亚',
  'south-korea': '韩国', 'north-korea': '朝鲜', uae: '阿联酋',
}

const ACTION_LABELS: Record<string, string> = {
  launch: '发布', acquire: '收购', funding: '筹集资金', earnings: '公布业绩', appoint: '调整管理层',
  investigate: '启动调查', security: '应对安全事件', rates: '调整利率', agreement: '达成合作',
  restriction: '实施限制', attack: '发动袭击', policy: '实施新规', build: '扩建', 'stake-change': '增持',
  reduce: '下调', support: '推出支持措施', negotiate: '推进谈判', death: '确认去世', 'rank-change': '公布排名变化',
  misuse: '卷入滥用争议', explain: '公布细节', rescue: '开展救援', implement: '启动实施', 'fraud-charge': '指控欺诈',
  'data-release': '发布数据', occur: '发生',
}

const OBJECT_LABELS: Record<string, string> = {
  cpi: '消费者价格指数', ppi: '生产者价格指数', pce: '个人消费支出价格指数', 'interest-rate': '利率政策',
  'bond-yield': '债券收益率', 'earnings-results': '经营业绩', 'product-release': '新产品',
  'acquisition-target': '并购交易', 'funding-round': '融资安排', 'factory-capacity': '产能建设',
  'data-center': '数据中心', 'ai-center': 'AI中心', 'course-curriculum': '课程改革', assessment: '教育评估',
  'ai-literacy': 'AI素养教育', 'education-policy': '教育政策', 'sanctions-controls': '制裁与出口管制',
  'military-strike': '军事行动', 'ceasefire-talks': '停火谈判', 'shipping-route': '航运安排', 'oil-price': '油价变化',
  earthquake: '地震救援', 'memory-capacity': 'AI内存产能', 'equity-stake': '持股', 'ev-target': '电动车销售目标',
  'fraud-case': '投资欺诈案件', 'university-ranking': '世界大学排名', 'image-abuse': '图像滥用问题',
  watermark: '模型水印机制', 'student-support': '学生父母支持计划', 'mba-program': 'MBA课程',
  'creative-program': '数字创意项目', 'executive-governance': '上市前治理', 'vaccine-health': '疫苗与健康议题',
}

function articleMaterial(article: Candidate) {
  return `${article.title} ${cleanEventMaterial(article.title, article.description, article.domain)} ${cleanEventMaterial(article.title, article.fullText ?? '', article.domain)} ${article.publishedAt.slice(0, 10)}`.trim()
}

function normalizedMaterial(event: NewsEvent) {
  return event.articles.map(articleMaterial).join(' ')
}

function displayEntity(entity: string) {
  return ENTITY_LABELS[entity] ?? entity.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
}

function contentActor(text: string, event: NewsEvent, includeEventMaterial = true) {
  const material = includeEventMaterial ? `${text} ${event.articles.map((article) => article.title).join(' ')}` : text
  const entity = extractEntities(material)[0]
  if (entity) return displayEntity(entity)
  const englishLead = stripHtml(text).match(/^([A-Z][A-Za-z0-9.&'-]*(?:\s+[A-Z][A-Za-z0-9.&'-]*){0,3})\s+/)?.[1]
  if (englishLead) return englishLead
  return stripHtml(text).match(/^([\p{Script=Han}A-Za-z0-9·.-]{2,20})(?:正|已|将)?(?=发布|推出|宣布|公布|启动|设立|建立|联合|合作|投资|融资|扩产|增持|收购|指控|调查|下调|发生|袭击|提议|签署|实施|推进|去世)/u)?.[1] ?? ''
}

function contentAction(text: string) {
  const objectSet = extractEventObjects(text)
  const actions = fingerprintActions(text, objectSet)
  if (objectSet.has('funding-round') && actions.has('agreement')) return '联合设立'
  if ((objectSet.has('memory-capacity') || objectSet.has('factory-capacity')) && actions.has('build')) return '扩建'
  const priority = ['fraud-charge', 'attack', 'rescue', 'negotiate', 'stake-change', 'reduce', 'misuse', 'death', 'rank-change', 'support', 'implement', 'funding', 'build', 'launch', 'explain']
  const action = priority.find((value) => actions.has(value)) ?? [...actions][0]
  return ACTION_LABELS[action] ?? ''
}

function contentObject(text: string, event: NewsEvent) {
  const objects = extractEventObjects(text)
  if (objects.has('funding-round') && (objects.has('data-center') || /ai compute infrastructure/i.test(text))) return 'AI算力基础设施融资平台'
  const priority = ['memory-capacity', 'equity-stake', 'cpi', 'ppi', 'pce', 'ev-target', 'fraud-case', 'university-ranking', 'earthquake', 'military-strike', 'shipping-route', 'ceasefire-talks', 'image-abuse', 'watermark', 'student-support', 'mba-program', 'creative-program', 'executive-governance', 'funding-round', 'factory-capacity', 'data-center', 'ai-center', 'product-release']
  const object = priority.find((value) => objects.has(value)) ?? [...objects][0]
  if (object === 'equity-stake') {
    const entities = extractEntities(text)
    if (entities[1]) return `${displayEntity(entities[1])}股份`
  }
  if (object && OBJECT_LABELS[object]) return OBJECT_LABELS[object]
  return event.topicTags.find((tag) => tag.length >= 2 && !/^(?:AI|科技|产业|市场|国际新闻|高等教育|学习)$/.test(tag)) ?? ''
}

function candidateSpecificity(candidate: Candidate) {
  const text = `${candidate.title} ${candidate.description}`
  const generic = /^(?:press release details?|news|article|homepage|untitled)$/i.test(candidate.title.trim())
  return (generic ? -100 : 0)
    + extractEntities(text).length * 12
    + extractActions(text).size * 10
    + extractEventObjects(text).size * 8
    + extractKeyNumbers(text).length * 4
    + Math.min(20, candidate.title.split(/\s+/).length)
}

function bestSpecificCandidate(event: NewsEvent) {
  return [...event.articles].sort((left, right) => candidateSpecificity(right) - candidateSpecificity(left)
    || right.score - left.score || left.url.localeCompare(right.url))[0] ?? event.primaryArticle
}

export function isPlaceholderTitle(value: string) {
  const text = stripHtml(value).trim()
  return !text || PLACEHOLDER_TITLE_PATTERNS.some((pattern) => pattern.test(text))
}

export function isPlaceholderSummary(value: string) {
  const text = stripHtml(value).trim()
  return !text || PLACEHOLDER_SUMMARY_PATTERNS.some((pattern) => pattern.test(text))
}

export function hasConcreteActorAndAction(value: string, event: NewsEvent) {
  const text = stripHtml(value)
  if (isPlaceholderTitle(text)) return false
  const hasObjectOrResult = extractEventObjects(text).size > 0
    || /造成|导致|引发|获得|获批|拒绝|去世|死亡|受损|增长|下降|上升|持平|扩大|收缩|survivors?|concern|growth|decline|dead|damage/iu.test(text)
  return Boolean(contentActor(text, event, false))
    && Boolean(contentAction(text))
    && hasObjectOrResult
}

export function claimMatchesEvent(value: string, event: NewsEvent) {
  const text = stripHtml(value)
  if (!text) return false
  return fingerprintMatches(eventFingerprint(event), fingerprintText(text, event.domain))
}

export function articleSupportsClaim(article: Candidate, claim: string) {
  const cleanClaim = stripHtml(claim)
  if (!cleanClaim || isPlaceholderSummary(cleanClaim)) return false
  const material = articleMaterial(article)
  const claimFingerprint = fingerprintText(cleanClaim, article.domain)
  const materialFingerprint = fingerprintText(material, article.domain)
  const claimNumbers = extractKeyNumbers(cleanClaim)
  if (claimNumbers.length && !keyNumbersCompatible(claimNumbers, extractKeyNumbers(material))) return false
  const objectsAligned = !claimFingerprint.objects.length || overlaps(claimFingerprint.objects, materialFingerprint.objects)
  const actionsAligned = !claimFingerprint.actions.length || overlaps(claimFingerprint.actions, materialFingerprint.actions)
  const entitiesAligned = !claimFingerprint.entities.length || overlaps(claimFingerprint.entities, materialFingerprint.entities)
  const tokenOverlap = overlapCoefficient(textTokens(cleanClaim), textTokens(material))
  const alignedSignalCount = Number(overlaps(claimFingerprint.entities, materialFingerprint.entities))
    + Number(overlaps(claimFingerprint.actions, materialFingerprint.actions))
    + Number(overlaps(claimFingerprint.objects, materialFingerprint.objects))
  return objectsAligned && actionsAligned && entitiesAligned
    && (tokenOverlap >= 0.16 || claimNumbers.length > 0 || alignedSignalCount >= 2)
}

export function supportingUrlsForClaim(event: NewsEvent, claim: string) {
  if (!claimMatchesEvent(claim, event)) return []
  return event.articles.filter((article) => articleSupportsClaim(article, claim)).map((article) => article.url)
}

function addsFingerprintDetail(title: string, summary: string, domain: DomainId) {
  const titleFingerprint = fingerprintText(title, domain)
  const summaryFingerprint = fingerprintText(summary, domain)
  return summaryFingerprint.numbers.some((value) => !titleFingerprint.numbers.includes(value))
    || summaryFingerprint.dates.some((value) => !titleFingerprint.dates.includes(value))
    || summaryFingerprint.locations.some((value) => !titleFingerprint.locations.includes(value))
    || summaryFingerprint.entities.some((value) => !titleFingerprint.entities.includes(value))
    || summaryFingerprint.actions.some((value) => !titleFingerprint.actions.includes(value))
    || summaryFingerprint.objects.some((value) => !titleFingerprint.objects.includes(value))
}

export function summaryAddsNewInformation(title: string, summary: string, event: NewsEvent) {
  const cleanTitle = stripHtml(title)
  const cleanSummary = stripHtml(summary)
  if (cleanSummary.length < 32 || isPlaceholderSummary(cleanSummary) || hasHtmlArtifact(summary) || hasMeaninglessEnglishFragment(cleanSummary)) return false
  if (!claimMatchesEvent(cleanSummary, event) || !supportingUrlsForClaim(event, cleanSummary).length) return false
  const normalizedTitle = normalizeTitle(cleanTitle)
  const normalizedSummary = normalizeTitle(cleanSummary)
  const residual = normalizedSummary.replace(normalizedTitle, '')
  const novelTokens = [...textTokens(cleanSummary)].filter((token) => !textTokens(cleanTitle).has(token))
  return residual.length >= 10 && novelTokens.length >= 2
    && (addsFingerprintDetail(cleanTitle, cleanSummary, event.domain)
      || /时间|地点|位于|用于|旨在|面向|覆盖|涉及|导致|造成|结果|计划|目标|同比|环比|参与方|受影响|期间|目前|其中/u.test(cleanSummary))
}

export function hasInformativeSummary(value: string, event: NewsEvent, title = '') {
  const text = stripHtml(value)
  if (text.length < 32 || isPlaceholderSummary(text) || hasHtmlArtifact(value) || hasMeaninglessEnglishFragment(text)) return false
  if (!claimMatchesEvent(text, event) || !supportingUrlsForClaim(event, text).length) return false
  return title ? summaryAddsNewInformation(title, text, event) : Boolean(contentAction(text) && contentActor(text, event, false))
}

function rawNumberLabels(value: string) {
  return [...new Set(value.match(/(?:[$€£¥￥]\s*)?\d[\d,.]*(?:\.\d+)?\s*(?:%|percent|percentage points?|basis points?|bps|trillion|billion|million|tn|bn|mn|亿元|亿美元|万亿元|万吨|gw|mw)?/gi)
    ?.map((number) => number.replace(/\s+/g, ' ').trim()).filter((number) => /[%$€£¥￥]|\b(?:trillion|billion|million|tn|bn|mn|亿元|亿美元|万亿元|万吨|gw|mw)\b/i.test(number)) ?? [])]
}

function structuredChineseSummary(title: string, candidate: Candidate, event: NewsEvent) {
  const material = articleMaterial(candidate)
  const actor = contentActor(material, event)
  const objects = [...extractEventObjects(material)]
  const object = objects[0] ?? ''
  const secondaryEntities = [...new Set(extractEntities(material).map(displayEntity))]
    .filter((entity) => entity !== actor && !/^(?:Press Release Details|Exclusive)$/i.test(entity)).slice(0, 4)
  const numbers = rawNumberLabels(material).filter((number) => !title.includes(number)).slice(0, 2)
  const locations = extractLocations(material).map((location) => ENTITY_LABELS[location] ?? LOCATION_ALIASES.find(([id]) => id === location)?.[0] ?? location)
  const dates = extractDates(material).filter((date) => !title.toLocaleLowerCase().includes(date)).slice(0, 2)
  const details: string[] = []
  if (secondaryEntities.length) details.push(`参与或受影响的主体还包括${secondaryEntities.join('、')}`)
  if (numbers.length) {
    const prefix = object === 'funding-round' ? '计划涉及的资金规模为'
      : object === 'factory-capacity' || object === 'memory-capacity' ? '相关扩建规模为'
        : object === 'equity-stake' ? '相关持仓变动为'
          : '事件中的关键数值为'
    details.push(`${prefix}${numbers.join('、')}`)
  }
  if (locations.length) details.push(`事件涉及${[...new Set(locations)].join('、')}`)
  if (dates.length) details.push(`相关时间为${dates.join('、')}`)
  const result = details.slice(0, 2).join('；')
  if (!result) return ''
  const summary = `${actor || '相关主体'}此次行动聚焦${contentObject(material, event) || '该事项'}；${result}。`
  return summary.length >= 32 ? shorten(summary, 160) : ''
}

export type EventSpecificContent = {
  title: string
  summary: string
  keyFacts: string[]
  sourceUrl: string
  factSources: Array<{ factIndex: number; urls: string[] }>
}

export function buildEventSpecificContent(event: NewsEvent): EventSpecificContent {
  const candidate = bestSpecificCandidate(event)
  const rawTitle = stripHtml(candidate.title)
  const candidateText = articleMaterial(candidate)
  let title = rawTitle
  if (!containsEnoughChinese(rawTitle) || rawTitle.length > 58 || isPlaceholderTitle(rawTitle) || !hasConcreteActorAndAction(rawTitle, event)) {
    title = [contentActor(candidateText, event), contentAction(candidateText), contentObject(candidateText, event)].filter(Boolean).join('')
  }
  title = shorten(title.replace(/\s+/g, ' ').trim(), 58)

  const supported = event.articles.flatMap((article) => materialSentences(`${article.description} ${article.fullText ?? ''}`)
    .filter((sentence) => containsEnoughChinese(sentence) && supportingUrlsForClaim(event, sentence).includes(article.url))
    .map((sentence) => ({ sentence: shorten(sentence, 160), url: article.url })))
  const informative = supported.filter((item) => summaryAddsNewInformation(title, item.sentence, event))
  const structured = structuredChineseSummary(title, candidate, event)
  const facts = informative.length ? informative.slice(0, 2) : structured ? [{ sentence: structured, url: candidate.url }] : []
  const summary = facts.map((item) => item.sentence).join('').slice(0, 260)
  return {
    title,
    summary,
    keyFacts: facts.map((item) => item.sentence),
    sourceUrl: candidate.url,
    factSources: facts.map((item, factIndex) => ({ factIndex, urls: [item.url] })),
  }
}

function ruleAnalysis(config: DomainConfig, event: NewsEvent, rank: number): BriefingStory {
  const candidate = event.primaryArticle
  const specific = buildEventSpecificContent(event)
  const title = specific.title
  const facts = specific.keyFacts.length ? specific.keyFacts : [`${title}。`]
  const sourceDescription = event.sourceCount > 1
    ? `该事件由 ${event.sourceCount} 个来源报道，证据等级为 ${event.evidence.level}。`
    : '当前只有一个来源，仍需等待独立信息补充。'
  return {
    id: event.id,
    eventId: event.id,
    rank,
    title,
    summary: specific.summary,
    keyFacts: facts,
    whyItMatters: `这条信息可能影响${config.fallback.affectedParties.slice(0, 2).join('与')}，但仍需结合后续数据判断真实影响。`,
    background: `围绕“${title}”的公开材料已经给出主体、动作与对象；后续判断应继续区分正式宣布、实际执行和最终结果，不能用同领域的其他事件补充事实。`,
    impactChain: ['事件或政策信号出现', '相关主体调整资源与行为', '影响逐步传导至行业、市场或个人决策'],
    affectedParties: config.fallback.affectedParties,
    uncertainties: `当前只依据 RSS 标题与摘要整理；${sourceDescription} 未获来源明确确认的细节不作推断。`,
    glossary: [],
    trend: {
      nearTerm: '如果后续出现官方补充信息或其他可靠来源的交叉验证，短期判断可能随证据变化。',
      mediumTerm: `若执行结果和后续数据持续印证，“${title}”的影响才可能从一次事件发展为更稳定的中期变化。`,
      signalsToWatch: ['官方文件或数据', '相关参与方行动', '行业与市场的持续反应'],
    },
    url: candidate.url,
    source: { name: candidate.source.name, type: candidate.source.type, reliability: candidate.source.reliability },
    sources: event.articles.map((article) => ({
      name: article.source.name,
      type: article.source.type,
      reliability: article.source.reliability,
    })).filter((source, index, sources) => sources.findIndex((item) => item.name === source.name) === index),
    evidenceSources: event.articles.map((article) => ({
      name: article.source.name,
      type: article.source.type,
      reliability: article.source.reliability,
      title: article.title,
      publishedAt: article.publishedAt,
      url: article.url,
      discoveryMethod: article.discoveryMethod,
      materialLevel: article.materialLevel,
    })),
    factSources: specific.factSources.length
      ? specific.factSources
      : facts.map((_, factIndex) => ({ factIndex, urls: [specific.sourceUrl] })),
    publishedAt: event.publishedAt,
    evidence: event.evidence,
    tags: event.topicTags,
  }
}

export type CollectionResult = {
  domain: DomainId
  candidates: Candidate[]
  fetched: number
  sourceCount: number
  rssCandidates?: number
  searchCandidates?: number
  searchCalls?: number
  previousTitles?: string[]
  warnings: string[]
}

export async function collectCandidates(
  domain: DomainId,
  now = new Date(),
  options: {
    searchRuntime?: SearchRuntime
    previousSignals?: string[]
    previousTitles?: string[]
    onCandidateDecision?: (decision: CandidateDecision) => void
  } = {},
): Promise<CollectionResult> {
  const config = DOMAIN_CONFIGS[domain]
  const results = await Promise.allSettled(config.sources.map((source) => fetchSource(config, source, now, options.onCandidateDecision)))
  const warnings: string[] = []
  const candidates: Candidate[] = []
  let sourceCount = 0
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value)
      if (result.value.length) sourceCount += 1
    } else {
      warnings.push(`${config.sources[index].name} 暂时无法获取`)
    }
  })
  const rssCandidates = candidates.length
  const searchCallsBefore = options.searchRuntime
    ? options.searchRuntime.callsFor(domain, 'base') + options.searchRuntime.callsFor(domain, 'dynamic')
    : 0
  const searched = options.searchRuntime
    ? await collectSearchCandidates(domain, options.searchRuntime, now, options.previousSignals, options.onCandidateDecision)
    : []
  const searchCandidates = searched.length
  candidates.push(...searched)
  if (options.searchRuntime && !options.searchRuntime.enabled) warnings.push('未配置 Tavily，已自动使用 RSS-only 模式')
  else if (options.searchRuntime?.stats.failures) warnings.push('部分动态搜索失败，已保留 RSS 候选')
  const uniqueSourceIds = new Set(candidates.map((candidate) => candidate.source.id))
  return {
    domain,
    candidates,
    fetched: candidates.length,
    sourceCount: uniqueSourceIds.size || sourceCount,
    rssCandidates,
    searchCandidates,
    searchCalls: options.searchRuntime
      ? options.searchRuntime.callsFor(domain, 'base') + options.searchRuntime.callsFor(domain, 'dynamic') - searchCallsBefore
      : 0,
    previousTitles: options.previousTitles ?? [],
    warnings,
  }
}

export function buildRulesBriefing(collection: CollectionResult, now = new Date(), preferredIds: string[] = []): DailyBriefing {
  const config = DOMAIN_CONFIGS[collection.domain]
  const { deduped, events } = buildEventLayer(collection)
  const preferred = preferredIds.map((id) => events.find((event) => event.id === id)).filter((event): event is NewsEvent => Boolean(event))
  const selected = [...preferred]
  for (const event of selectDiverseEvents(events)) {
    if (selected.length >= 5) break
    if (!selected.some((item) => item.id === event.id)) selected.push(event)
  }
  if (selected.length < 5) throw new Error(`${config.title}可用事件不足 5 条（当前 ${selected.length} 条），已停止生成，避免用旧内容补位。`)
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
  const stories = selected.map((event, index) => ruleAnalysis(config, event, index + 1))
  const verifiedCount = stories.filter((story) => story.evidence.level === 'confirmed' || story.evidence.level === 'corroborated').length
  return {
    schemaVersion: 2,
    id: `${date}-${config.id}`,
    domain: config.id,
    domainTitle: config.title,
    domainCode: config.code,
    date,
    generatedAt: now.toISOString(),
    sourceWindow: {
      from: new Date(now.getTime() - config.sourceWindowDays * 86_400_000).toISOString(),
      to: now.toISOString(),
    },
    mode: 'rules',
    overview: `从 ${collection.sourceCount} 个有效来源获取 ${collection.fetched} 条候选，文章去重后保留 ${deduped.length} 条，聚合为 ${events.length} 个事件，并选出 5 条重点。`,
    keyTakeaway: stories[0].whyItMatters,
    logic: `事件聚类综合标题、摘要、实体、动作和时间接近度；排序继续沿用来源级别、发布时间、影响关键词与信息完整度，并限制单一主来源最多 2 条。本期有 ${verifiedCount} 个事件达到多源确认或印证。`,
    newKnowledge: config.fallback.knowledge,
    outlook: config.fallback.outlook,
    trendRadar: [
      { theme: stories[0].tags[0], direction: '↑', reason: '近期相关信息密度上升，需继续用后续数据验证。' },
      { theme: stories[1].tags[0], direction: '→', reason: '方向仍在形成，暂不把单日变化视为确定趋势。' },
    ],
    watchNext: ['官方后续材料', '可量化的数据变化', '其他可靠来源的交叉验证'],
    stories,
    pipeline: {
      fetched: collection.fetched,
      afterDedup: deduped.length,
      afterClustering: events.length,
      sourceCount: collection.sourceCount,
      rssCandidates: collection.rssCandidates ?? collection.fetched,
      searchCandidates: collection.searchCandidates ?? 0,
      searchCalls: collection.searchCalls ?? 0,
      confirmedCount: stories.filter((story) => story.evidence.level === 'confirmed').length,
      corroboratedCount: stories.filter((story) => story.evidence.level === 'corroborated').length,
      singleSourceCount: stories.filter((story) => story.evidence.level === 'single-source').length,
      unverifiedCount: stories.filter((story) => story.evidence.level === 'unverified').length,
      primarySourceCount: stories.filter((story) => story.evidence.primarySourcePresent).length,
      maxSourceConcentration: Math.max(...[...new Set(stories.map((story) => story.source.name))].map((name) => stories.filter((story) => story.source.name === name).length)),
      qualityStatus: 'degraded',
      warnings: collection.warnings,
    },
  }
}
