import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BriefingStory, DailyBriefing, DailyDigest, DomainId, TrendRadarItem } from '../shared/briefing'

type LoadState = 'loading' | 'ready' | 'error'

const domainPresentation: Record<DomainId, { stations: string[] }> = {
  'ai-tech': { stations: ['重点速览', '技术进展', '产业逻辑', '趋势预测', '术语与来源'] },
  markets: { stations: ['重点速览', '市场动向', '公司变化', '估值与风险', '指标与来源'] },
  world: { stations: ['重点速览', '事件进展', '各方立场', '外溢影响', '风险与来源'] },
  learning: { stations: ['重点速览', '政策研究', '课堂实践', '能力变化', '术语与来源'] },
}

function isDailyDigest(value: unknown): value is DailyDigest {
  if (!value || typeof value !== 'object') return false
  const digest = value as Partial<DailyDigest>
  return digest.schemaVersion === 2
    && typeof digest.generatedAt === 'string'
    && Array.isArray(digest.briefings)
    && digest.briefings.length === 4
    && digest.briefings.every((briefing) => briefing.schemaVersion === 2 && briefing.stories.length === 5)
}

function formatBriefingDate(date?: string) {
  const value = date ? new Date(`${date}T12:00:00+08:00`) : new Date()
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(value)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function modeLabel(mode?: DailyBriefing['mode']) {
  const labels = { rules: '规则整理 · 未调用 AI', qwen: 'Qwen 深度分析', deepseek: 'DeepSeek 深度分析', openai: 'OpenAI 深度分析' }
  return mode ? labels[mode] : '正在读取数据'
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="settings-icon">
      <path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Z" />
      <path d="m19.3 13.8 1.25 1-.15.75-1.55 2.65-.7.25-1.5-.6a8 8 0 0 1-1.55.9l-.25 1.6-.55.5h-3.1l-.55-.5-.25-1.6a8 8 0 0 1-1.55-.9l-1.5.6-.7-.25-1.55-2.65-.15-.75 1.25-1a7 7 0 0 1 0-1.8l-1.25-1 .15-.75L6.65 7.3l.7-.25 1.5.6a8 8 0 0 1 1.55-.9l.25-1.6.55-.5h3.1l.55.5.25 1.6a8 8 0 0 1 1.55.9l1.5-.6.7.25 1.55 2.65.15.75-1.25 1a7 7 0 0 1 0 1.8Z" />
    </svg>
  )
}

function ArrowIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="arrow-icon"><path d="M5 12h13M13 7l5 5-5 5" /></svg>
}

function InsightIcon({ type }: { type: 'judgment' | 'knowledge' | 'watch' }) {
  if (type === 'judgment') return <svg aria-hidden="true" viewBox="0 0 48 48" className="insight-icon"><circle cx="24" cy="24" r="15" /><circle cx="24" cy="24" r="8" /><circle cx="24" cy="24" r="2.5" /><path d="M24 3v9M24 36v9M3 24h9M36 24h9" /></svg>
  if (type === 'knowledge') return <svg aria-hidden="true" viewBox="0 0 48 48" className="insight-icon"><path d="M14 21a10 10 0 1 1 20 0c0 5-4 7-5 11H19c-1-4-5-6-5-11Z" /><path d="M19 37h10M20.5 42h7M24 5V1M9.5 10.5 6 7M38.5 10.5 42 7M8 23H3M45 23h-5" /></svg>
  return <svg aria-hidden="true" viewBox="0 0 48 48" className="insight-icon"><rect x="7" y="10" width="34" height="31" rx="1" /><path d="M7 18h34M16 6v8M32 6v8M13 25h5M22 25h5M31 25h5M13 32h5M22 32h5" /></svg>
}

function Masthead({ date }: { date?: string }) {
  return (
    <header className="masthead">
      <div className="brand-group"><a className="brand" href="#top" aria-label="DailyNews 首页">DailyNews</a><span className="mast-divider" aria-hidden="true" /><time dateTime={date}>{formatBriefingDate(date)}</time></div>
      <nav className="reading-route" aria-label="阅读进度">
        <span className="route-label">阅读进度</span>
        <a className="route-step is-current" href="#top"><i />今日简报</a>
        <a className="route-step" href="#domains"><i />领域浏览</a>
        <a className="route-step" href="#briefings"><i />深度阅读</a>
        <a className="route-step" href="#trend-radar"><i />趋势雷达</a>
      </nav>
      <button className="settings-button" type="button" disabled title="个性化设置将在下一版开放"><SettingsIcon /><span>设置</span></button>
    </header>
  )
}

type TopStory = { story: BriefingStory; domainTitle: string }

function MajorEvents({ stories, state }: { stories: TopStory[]; state: LoadState }) {
  return (
    <section className="major-events" aria-labelledby="major-events-title" aria-busy={state === 'loading'}>
      <div className="section-rule" />
      <div className="section-title-row"><h2 id="major-events-title">今日三件大事</h2><span className="micro-status">跨领域筛选</span></div>
      {state === 'loading' ? <div className="inline-state">正在读取四领域最新简报…</div> : state === 'error' ? <div className="inline-state is-error">简报暂时不可用，请重新读取。</div> : (
        <ol>{stories.slice(0, 3).map(({ story, domainTitle }, index) => (
          <li key={story.id} className={index === 0 ? 'is-primary' : undefined}>
            <span className="event-index">{String(index + 1).padStart(2, '0')}</span>
            <div><span className="event-domain">{domainTitle}</span><h3>{story.title}</h3><p>{story.whyItMatters}</p></div>
          </li>
        ))}</ol>
      )}
    </section>
  )
}

function DomainLine({ briefing, index, state }: { briefing: DailyBriefing | null; index: number; state: LoadState }) {
  const fallbackIds: DomainId[] = ['ai-tech', 'markets', 'world', 'learning']
  const domain = briefing?.domain ?? fallbackIds[index]
  const stations = domainPresentation[domain].stations
  return (
    <article className="domain-line is-live" id={domain} style={{ '--route-delay': `${index * 90}ms` } as React.CSSProperties}>
      <header className="domain-header">
        <div className="domain-name"><span className="signal-bar" aria-hidden="true" /><div className="domain-title-row"><h2>{briefing?.domainTitle ?? ['AI · 科技 · 芯片', '投资市场 · 公司动态', '国际新闻 · 地缘政治', '学习 · 教育趋势'][index]}</h2><span className="domain-code">{briefing?.domainCode ?? `DN—0${index + 1}`}</span></div></div>
        <div className="domain-meta" aria-label={briefing ? '5 条重点新闻，已生成' : '正在读取'}><span>{briefing ? '05 条重点' : '读取中'}</span><span className={`unread-dot${briefing ? '' : ' is-muted'}`} aria-hidden="true" /><span>{briefing ? '已生成' : '等待'}</span></div>
      </header>
      <div className="domain-route" aria-label={`${briefing?.domainTitle ?? domain} 阅读路径`}><ol>{stations.map((station, stationIndex) => <li key={station} className={stationIndex === 0 && briefing ? 'is-active' : undefined}><span className="station-dot" aria-hidden="true" /><span className="station-index">{String(stationIndex + 1).padStart(2, '0')}</span><span className="station-label">{station}</span></li>)}</ol></div>
      <div className="domain-summary"><p>{briefing?.keyTakeaway ?? '正在读取本领域重点与趋势判断。'}</p>{briefing && state === 'ready' ? <a className="text-link" href={`#${domain}-briefing`}>阅读完整板块<ArrowIcon /></a> : <span className="static-preview-label">数据读取中</span>}</div>
    </article>
  )
}

function DetailSection({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`deep-section ${className}`}><h4>{title}</h4>{children}</section>
}

function StoryRow({ story }: { story: BriefingStory }) {
  return (
    <article className="story-row">
      <div className="story-register"><span className="story-rank">{String(story.rank).padStart(2, '0')}</span><span>{story.source.name}</span><time dateTime={story.publishedAt}>{formatTime(story.publishedAt)}</time><span>{story.source.type === 'official' ? '官方源' : '专业媒体'} · 置信度{story.confidence}</span></div>
      <div className="story-main"><div className="story-tags">{story.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><h3><a href={story.url} target="_blank" rel="noreferrer">{story.title}<ArrowIcon /></a></h3><p>{story.summary}</p></div>
      <div className="story-analysis"><h4>为何重要</h4><p>{story.whyItMatters}</p></div>
      <details className="story-deep-dive">
        <summary><span>展开完整分析</span><span>事实 · 背景 · 影响 · 风险 · 术语 · 趋势</span></summary>
        <div className="story-deep-grid">
          <DetailSection title="事实梳理"><ul>{story.keyFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul></DetailSection>
          <DetailSection title="背景逻辑"><p>{story.background}</p></DetailSection>
          <DetailSection title="影响链" className="is-wide"><ol className="impact-chain">{story.impactChain.map((node, index) => <li key={`${node}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{node}</p></li>)}</ol></DetailSection>
          <DetailSection title="谁会受到影响"><ul>{story.affectedParties.map((party) => <li key={party}>{party}</li>)}</ul></DetailSection>
          <DetailSection title="不确定性与风险"><p>{story.uncertainties}</p></DetailSection>
          <DetailSection title="专业术语解释" className="is-wide glossary-section">
            {story.glossary.length ? <div className="glossary-list">{story.glossary.map((item) => <details key={item.term} className="term-note"><summary>{item.term}<span>查看解释</span></summary><p>{item.definition}</p></details>)}</div> : <p>本条没有必须额外解释的专业术语。</p>}
          </DetailSection>
          <DetailSection title="未来趋势预测" className="is-wide trend-section">
            <div className="trend-horizon"><div><span>未来 24–72 小时</span><p>{story.trend.nearTerm}</p></div><div><span>未来数周至数月</span><p>{story.trend.mediumTerm}</p></div></div>
            <div className="watch-signals"><h5>用这些信号验证预测</h5><ul>{story.trend.signalsToWatch.map((signal) => <li key={signal}>{signal}</li>)}</ul></div>
          </DetailSection>
        </div>
      </details>
    </article>
  )
}

function DomainAnalysis({ briefing }: { briefing: DailyBriefing }) {
  return (
    <details className="domain-analysis">
      <summary><span>展开本领域深度判断</span><span>逻辑 · 知识点 · 趋势雷达 · 后续观察</span></summary>
      <div className="domain-analysis-grid">
        <section><h3>背后的逻辑</h3><p>{briefing.logic}</p></section>
        <section><h3>今日知识点</h3><p>{briefing.newKnowledge}</p></section>
        <section><h3>未来趋势预测</h3><p>{briefing.outlook}</p></section>
        <section><h3>接下来重点观察</h3><ul>{briefing.watchNext.map((item) => <li key={item}>{item}</li>)}</ul></section>
      </div>
    </details>
  )
}

function BriefingLedger({ briefing }: { briefing: DailyBriefing }) {
  return (
    <section className="briefing-ledger" id={`${briefing.domain}-briefing`} aria-labelledby={`${briefing.domain}-title`}>
      <header className="ledger-head"><div><h2 id={`${briefing.domain}-title`}>{briefing.domainTitle}</h2><p>{briefing.overview}</p><strong className="domain-takeaway">今日判断：{briefing.keyTakeaway}</strong></div><div className="ledger-meta"><span>更新 {formatTime(briefing.generatedAt)}</span><span>{briefing.pipeline.sourceCount} 个有效来源</span><span>{modeLabel(briefing.mode)}</span></div></header>
      <DomainAnalysis briefing={briefing} />
      {briefing.stories.map((story) => <StoryRow key={story.id} story={story} />)}
      {briefing.pipeline.warnings.length > 0 && <div className="source-warning"><strong>本板块提醒：</strong>{briefing.pipeline.warnings.join('；')}</div>}
    </section>
  )
}

function DailyRadar({ briefings }: { briefings: DailyBriefing[] }) {
  const items = briefings.flatMap((briefing) => briefing.trendRadar.map((item) => ({ ...item, domain: briefing.domainCode })))
  return (
    <details className="daily-radar" id="trend-radar">
      <summary><span>今日趋势雷达</span><span>{items.length} 个需要持续跟踪的信号</span></summary>
      <div className="radar-grid">{items.map((item, index) => <article key={`${item.domain}-${item.theme}-${index}`}><span className="radar-domain">{item.domain}</span><div><h3>{item.theme}</h3><p>{item.reason}</p></div><strong>{item.direction}</strong></article>)}</div>
    </details>
  )
}

function InsightStrip({ briefings }: { briefings: DailyBriefing[] }) {
  const byDomain = new Map(briefings.map((briefing) => [briefing.domain, briefing]))
  const insights = [
    { type: 'judgment' as const, title: '今日判断', text: byDomain.get('ai-tech')?.keyTakeaway ?? '简报读取完成后显示。' },
    { type: 'knowledge' as const, title: '新知识', text: byDomain.get('markets')?.newKnowledge ?? '简报读取完成后显示。' },
    { type: 'watch' as const, title: '接下来关注', text: [byDomain.get('world')?.watchNext[0], byDomain.get('learning')?.watchNext[0]].filter(Boolean).join('；') || '简报读取完成后显示。' },
  ]
  return <section className="insight-strip" aria-label="今日简报结论">{insights.map((item) => <article key={item.title}><InsightIcon type={item.type} /><div className="insight-copy"><h2>{item.title}</h2><p>{item.text}</p></div></article>)}</section>
}

function App() {
  const [digest, setDigest] = useState<DailyDigest | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')

  const loadBriefing = useCallback(async () => {
    setState('loading'); setError('')
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}data/briefings/daily-latest.json`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`数据文件返回 ${response.status}`)
      const data: unknown = await response.json()
      if (!isDailyDigest(data)) throw new Error('四领域数据结构不完整')
      setDigest(data); setState('ready')
    } catch (loadError) {
      setDigest(null); setError(`${loadError instanceof Error ? loadError.message : '未知错误'}。请重新生成每日简报。`); setState('error')
    }
  }, [])

  useEffect(() => { void loadBriefing() }, [loadBriefing])
  useEffect(() => { if (!window.location.hash || window.location.hash === '#top') window.scrollTo({ top: 0, left: 0, behavior: 'auto' }) }, [])

  const topStories = useMemo<TopStory[]>(() => {
    if (!digest) return []
    return digest.topStories.flatMap((reference) => {
      const briefing = digest.briefings.find((item) => item.domain === reference.domain)
      const story = briefing?.stories.find((item) => item.id === reference.storyId)
      return briefing && story ? [{ story, domainTitle: briefing.domainTitle }] : []
    })
  }, [digest])

  return (
    <div className="app-shell" id="top">
      <Masthead date={digest?.date} />
      <main>
        <div className="briefing-grid" id="domains">
          <aside className="brief-overview"><div className="brief-heading"><h1>今日简报</h1><span className="title-signal" aria-hidden="true" /><div className="edition-meta"><span>晨间版</span><span>4 个领域</span><span className="sample-tag">20 条重点</span></div></div><p className="brief-intro">先用 30 秒掌握当天主线，再进入四个领域查看事实、背景逻辑、专业术语和未来趋势。</p><MajorEvents stories={topStories} state={state} /></aside>
          <section className="domain-list" aria-label="四个新闻领域"><div className="domain-list-head"><span>今日领域线路</span><span>{state === 'ready' ? '4 个已生成 · 20 条重点' : '正在读取四领域数据'}</span></div>{[0, 1, 2, 3].map((index) => <DomainLine key={digest?.briefings[index]?.domain ?? index} briefing={digest?.briefings[index] ?? null} index={index} state={state} />)}{state === 'error' && <div className="domain-load-error" role="alert"><strong>没有读取到今日简报</strong><p>{error}</p><button type="button" onClick={loadBriefing}>重新读取</button></div>}</section>
        </div>
        <div id="briefings">{digest?.briefings.map((briefing) => <BriefingLedger key={briefing.domain} briefing={briefing} />)}</div>
        {digest && <DailyRadar briefings={digest.briefings} />}
        <InsightStrip briefings={digest?.briefings ?? []} />
      </main>
      <footer className="footer-note"><span>DailyNews · 个人每日简报</span><span>共 4 个领域、20 条重点；RSS 用于发现，事实以原始来源为准，预测需用后续信号验证。</span></footer>
    </div>
  )
}

export default App
