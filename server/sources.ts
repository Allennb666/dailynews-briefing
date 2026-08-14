import type { DomainId, SourceReliability } from '../shared/briefing.js'

export type FeedSource = {
  id: string
  name: string
  url: string
  type: 'official' | 'media'
  reliability: SourceReliability
  weight: number
  focused: boolean
}

export type DomainConfig = {
  id: DomainId
  code: string
  title: string
  stations: string[]
  sourceWindowDays: number
  topicTerms: string[]
  impactTerms: string[]
  tagRules: Array<{ tag: string; pattern: RegExp }>
  sources: FeedSource[]
  fallback: {
    background: string
    affectedParties: string[]
    outlook: string
    knowledge: string
  }
}

const aiTech: DomainConfig = {
  id: 'ai-tech',
  code: 'DN—01',
  title: 'AI · 科技 · 芯片',
  stations: ['重点速览', '技术进展', '产业逻辑', '趋势预测', '术语与来源'],
  sourceWindowDays: 10,
  topicTerms: [
    'artificial intelligence', 'generative ai', 'machine learning', 'large language model',
    'semiconductor', 'chip', 'gpu', 'accelerator', 'data center', 'robot', 'agent',
    'openai', 'anthropic', 'gemini', 'claude', 'nvidia', 'amd', 'intel', 'tsmc', 'cuda',
    '人工智能', '大模型', '模型', '智能体', '机器人', '芯片', '半导体', '算力', '英伟达', '台积电',
  ],
  impactTerms: ['launch', 'release', 'acquire', 'funding', 'regulation', 'ban', 'export', 'security', 'research', '发布', '推出', '收购', '融资', '监管', '出口', '安全', '研究'],
  tagRules: [
    { tag: '芯片', pattern: /chip|semiconductor|gpu|cuda|芯片|半导体|算力|晶圆/i },
    { tag: '模型', pattern: /model|openai|anthropic|gemini|claude|大模型|模型|智能体|agent/i },
    { tag: '政策', pattern: /regulat|policy|ban|export|监管|政策|禁令|出口/i },
    { tag: '产业', pattern: /funding|acqui|revenue|market|融资|收购|营收|市场/i },
    { tag: '研究', pattern: /research|benchmark|paper|研究|论文|基准/i },
  ],
  sources: [
    { id: 'openai', name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', type: 'official', reliability: 'primary', weight: 40, focused: true },
    { id: 'google', name: 'Google Blog', url: 'https://blog.google/feed/', type: 'official', reliability: 'primary', weight: 38, focused: false },
    { id: 'nvidia', name: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/', type: 'official', reliability: 'primary', weight: 40, focused: true },
    { id: 'huggingface', name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', type: 'official', reliability: 'primary', weight: 36, focused: true },
    { id: 'semiengineering', name: 'Semiconductor Engineering', url: 'https://semiengineering.com/feed/', type: 'media', reliability: 'tier-2', weight: 32, focused: true },
    { id: 'techcrunch-ai', name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', type: 'media', reliability: 'tier-2', weight: 30, focused: true },
    { id: 'ithome', name: 'IT之家', url: 'https://www.ithome.com/rss/', type: 'media', reliability: 'other', weight: 28, focused: false },
    { id: 'solidot', name: 'Solidot', url: 'https://www.solidot.org/index.rss', type: 'media', reliability: 'other', weight: 28, focused: false },
  ],
  fallback: {
    background: '这条信息需要放在技术能力、产品落地与产业供给三个层面分别判断，不能只看发布标题。',
    affectedParties: ['技术供应商', '开发者与企业客户', '上下游产业链'],
    outlook: '继续观察产品实测、客户采用、成本变化和供应链交付，而不是只依据发布方表态。',
    knowledge: '判断技术新闻时，应区分发布、测试、量产、商业部署与规模化盈利五个阶段。',
  },
}

const markets: DomainConfig = {
  id: 'markets',
  code: 'DN—02',
  title: '投资市场 · 公司动态',
  stations: ['重点速览', '市场动向', '公司变化', '估值与风险', '指标与来源'],
  sourceWindowDays: 7,
  topicTerms: ['market', 'stock', 'bond', 'yield', 'inflation', 'cpi', 'rate', 'earnings', 'revenue', 'profit', 'ipo', 'acquisition', 'oil', 'economy', '市场', '股票', '债券', '收益率', '通胀', '利率', '财报', '营收', '利润', '上市', '收购', '油价', '经济'],
  impactTerms: ['rate', 'inflation', 'earnings', 'guidance', 'acquisition', 'ipo', 'regulation', 'tariff', 'oil', '利率', '通胀', '财报', '指引', '收购', '上市', '监管', '关税', '油价'],
  tagRules: [
    { tag: '宏观', pattern: /inflation|cpi|rate|yield|econom|通胀|利率|收益率|经济/i },
    { tag: '公司', pattern: /earnings|revenue|profit|guidance|company|财报|营收|利润|公司/i },
    { tag: '资本', pattern: /ipo|funding|acqui|merger|上市|融资|收购|并购/i },
    { tag: '监管', pattern: /sec|regulat|policy|tariff|监管|政策|关税/i },
    { tag: '能源', pattern: /oil|gas|energy|原油|油价|天然气|能源/i },
  ],
  sources: [
    { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', type: 'official', reliability: 'primary', weight: 40, focused: true },
    { id: 'sec', name: 'U.S. SEC', url: 'https://www.sec.gov/news/pressreleases.rss', type: 'official', reliability: 'primary', weight: 38, focused: true },
    { id: 'bbc-business', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', type: 'media', reliability: 'tier-1', weight: 34, focused: true },
    { id: 'cnbc', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', type: 'media', reliability: 'tier-1', weight: 32, focused: true },
    { id: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', type: 'media', reliability: 'tier-1', weight: 32, focused: true },
    { id: 'npr-business', name: 'NPR Business', url: 'https://feeds.npr.org/1006/rss.xml', type: 'media', reliability: 'tier-1', weight: 30, focused: true },
  ],
  fallback: {
    background: '市场新闻需要同时结合盈利、现金流、估值、利率与风险偏好判断，单日价格变化本身不能说明长期趋势。',
    affectedParties: ['上市公司与投资者', '行业上下游', '消费者与融资主体'],
    outlook: '关注后续数据、公司指引、资金价格与成交反应，验证市场是否形成持续重估。',
    knowledge: '公司基本面改善不一定带来股价上涨；当估值已经反映高预期时，市场会要求更强的盈利兑现。',
  },
}

const world: DomainConfig = {
  id: 'world',
  code: 'DN—03',
  title: '国际新闻 · 地缘政治',
  stations: ['重点速览', '事件进展', '各方立场', '外溢影响', '风险与来源'],
  sourceWindowDays: 7,
  topicTerms: ['war', 'conflict', 'diplomacy', 'sanction', 'election', 'trade', 'security', 'military', 'peace', 'border', '战争', '冲突', '外交', '制裁', '选举', '贸易', '安全', '军事', '和平', '边境'],
  impactTerms: ['attack', 'ceasefire', 'agreement', 'sanction', 'tariff', 'election', 'military', 'nuclear', '袭击', '停火', '协议', '制裁', '关税', '选举', '军事', '核'],
  tagRules: [
    { tag: '冲突', pattern: /war|attack|military|conflict|战争|袭击|军事|冲突/i },
    { tag: '外交', pattern: /diploma|talk|agreement|ceasefire|外交|谈判|协议|停火/i },
    { tag: '贸易', pattern: /trade|tariff|export|sanction|贸易|关税|出口|制裁/i },
    { tag: '安全', pattern: /security|nuclear|terror|安全|核|恐怖/i },
    { tag: '政治', pattern: /election|government|president|选举|政府|总统/i },
  ],
  sources: [
    { id: 'un-news', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', type: 'official', reliability: 'primary', weight: 38, focused: true },
    { id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', type: 'media', reliability: 'tier-1', weight: 34, focused: true },
    { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', type: 'media', reliability: 'tier-1', weight: 32, focused: true },
    { id: 'dw', name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-top', type: 'media', reliability: 'tier-1', weight: 31, focused: true },
    { id: 'npr-world', name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml', type: 'media', reliability: 'tier-1', weight: 30, focused: true },
    { id: 'guardian-world', name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', type: 'media', reliability: 'tier-1', weight: 30, focused: true },
    { id: 'lemonde-world', name: 'Le Monde World', url: 'https://www.lemonde.fr/en/international/rss_full.xml', type: 'media', reliability: 'tier-1', weight: 30, focused: true },
  ],
  fallback: {
    background: '地缘事件需要区分已发生行动、各方表态、谈判条件和媒体推测，并观察是否出现可验证的现实变化。',
    affectedParties: ['冲突或谈判直接参与方', '周边国家与居民', '全球能源、贸易与金融市场'],
    outlook: '关注正式文件、现场行动、第三方验证与贸易流量变化，避免把政治表态直接视为结果。',
    knowledge: '判断地缘风险时，行动与可验证数据通常比措辞更重要，例如实际部署、船运、制裁执行与资金流向。',
  },
}

const learning: DomainConfig = {
  id: 'learning',
  code: 'DN—04',
  title: '学习 · 教育趋势',
  stations: ['重点速览', '政策研究', '课堂实践', '能力变化', '术语与来源'],
  sourceWindowDays: 14,
  topicTerms: ['education', 'school', 'university', 'student', 'teacher', 'learning', 'curriculum', 'assessment', 'literacy', '教育', '学校', '大学', '学生', '教师', '学习', '课程', '评估', '素养'],
  impactTerms: ['policy', 'research', 'curriculum', 'assessment', 'artificial intelligence', 'funding', 'admission', '政策', '研究', '课程', '评估', '人工智能', '资金', '招生'],
  tagRules: [
    { tag: 'AI 教育', pattern: /artificial intelligence|\bai\b|人工智能|ai 教育/i },
    { tag: '高等教育', pattern: /university|college|higher education|大学|高校|高等教育/i },
    { tag: '基础教育', pattern: /k-12|school|teacher|小学|中学|学校|教师/i },
    { tag: '教育政策', pattern: /policy|government|funding|政策|政府|资金/i },
    { tag: '学习科学', pattern: /research|assessment|learning|研究|评估|学习/i },
  ],
  sources: [
    { id: 'google-education', name: 'Google Education', url: 'https://blog.google/outreach-initiatives/education/rss/', type: 'official', reliability: 'primary', weight: 36, focused: true },
    { id: 'mit-education', name: 'MIT News Education', url: 'https://news.mit.edu/rss/topic/education', type: 'official', reliability: 'primary', weight: 36, focused: true },
    { id: 'coursera', name: 'Coursera Blog', url: 'https://blog.coursera.org/feed/', type: 'official', reliability: 'primary', weight: 32, focused: true },
    { id: 'edsurge', name: 'EdSurge', url: 'https://www.edsurge.com/articles_rss', type: 'media', reliability: 'tier-1', weight: 34, focused: true },
    { id: 'hechinger', name: 'The Hechinger Report', url: 'https://hechingerreport.org/feed/', type: 'media', reliability: 'tier-1', weight: 34, focused: true },
    { id: 'inside-higher-ed', name: 'Inside Higher Ed', url: 'https://www.insidehighered.com/rss.xml', type: 'media', reliability: 'tier-1', weight: 32, focused: true },
    { id: 'education-next', name: 'Education Next', url: 'https://www.educationnext.org/feed/', type: 'media', reliability: 'tier-2', weight: 31, focused: true },
    { id: 'eschool-news', name: 'eSchool News', url: 'https://www.eschoolnews.com/feed/', type: 'media', reliability: 'other', weight: 29, focused: true },
    { id: 'edscoop', name: 'EdScoop', url: 'https://www.edscoop.com/feed/', type: 'media', reliability: 'tier-2', weight: 30, focused: true },
    { id: 'lemonde-education', name: 'Le Monde Education', url: 'https://www.lemonde.fr/en/education/rss_full.xml', type: 'media', reliability: 'tier-1', weight: 29, focused: true },
  ],
  fallback: {
    background: '教育变化需要区分政策倡议、课堂试点、研究证据与大规模实施，单个案例不能直接代表普遍效果。',
    affectedParties: ['学生与家庭', '教师与学校管理者', '大学、教育平台与政策制定者'],
    outlook: '关注是否出现长期研究、课程标准、教师培训和可复制的课堂结果，验证趋势能否扩大。',
    knowledge: '教育工具有效不等于学习有效；真正需要观察的是理解、迁移、反馈质量和学生独立判断能力。',
  },
}

export const DOMAIN_CONFIGS: Record<DomainId, DomainConfig> = {
  'ai-tech': aiTech,
  markets,
  world,
  learning,
}

export const DOMAIN_ORDER: DomainId[] = ['ai-tech', 'markets', 'world', 'learning']
