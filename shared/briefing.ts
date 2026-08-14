export type BriefingMode = 'rules' | 'qwen' | 'deepseek' | 'openai'

export type DomainId = 'ai-tech' | 'markets' | 'world' | 'learning'

export type SourceReliability = 'primary' | 'tier-1' | 'tier-2' | 'other'

export type EvidenceConfidence = 'confirmed' | 'corroborated' | 'single-source' | 'unverified'

export type NewsSource = {
  name: string
  type: 'official' | 'media'
  reliability: SourceReliability
}

export type EventEvidence = {
  level: EvidenceConfidence
  sourceCount: number
  independentSourceCount: number
  primarySourcePresent: boolean
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
  eventId: string
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
  sources: NewsSource[]
  publishedAt: string
  evidence: EventEvidence
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
    afterClustering: number
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
