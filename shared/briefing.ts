export type BriefingMode = 'rules' | 'qwen' | 'deepseek' | 'openai'

export type DomainId = 'ai-tech' | 'markets' | 'world' | 'learning'

export type NewsSource = {
  name: string
  type: 'official' | 'media'
}
export type GlossaryTerm = {
  term: string
  definition: string
}

export type StoryTrend = {
  nearTerm: string
  mediumTerm: string
  signalsToWatch: string[]
}

export type BriefingStory = {
  id: string
  rank: number
  title: string
  summary: string
  keyFacts: string[]
  whyItMatters: string
  background: string
  impactChain: string[]
  affectedParties: string[]
  uncertainties: string
  glossary: GlossaryTerm[]
  trend: StoryTrend
  url: string
  source: NewsSource
  publishedAt: string
  confidence: '高' | '中'
  tags: string[]
}

export type TrendRadarItem = {
  theme: string
  direction: '↑↑' | '↑' | '→' | '↓' | '高波动'
  reason: string
}

export type DailyBriefing = {
  schemaVersion: 2
  id: string
  domain: DomainId
  domainTitle: string
  domainCode: string
  date: string
  generatedAt: string
  sourceWindow: {
    from: string
    to: string
  }
  mode: BriefingMode
  overview: string
  keyTakeaway: string
  logic: string
  newKnowledge: string
  outlook: string
  trendRadar: TrendRadarItem[]
  watchNext: string[]
  stories: BriefingStory[]
  pipeline: {
    fetched: number
    afterDedup: number
    sourceCount: number
    warnings: string[]
  }
}

export type DailyDigest = {
  schemaVersion: 2
  date: string
  generatedAt: string
  briefings: DailyBriefing[]
  topStories: Array<{ domain: DomainId; storyId: string }>
}
