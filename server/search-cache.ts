import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SearchHit, SearchResultCache } from './search.js'

type CacheState = {
  schemaVersion: 1
  date: string
  complete: boolean
  responses: Record<string, SearchHit[]>
}

export class FileSearchResultCache implements SearchResultCache {
  private statePromise: Promise<CacheState> | null = null
  private writeQueue = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly date: string,
  ) {}

  private async state() {
    if (!this.statePromise) {
      this.statePromise = readFile(this.path, 'utf8')
        .then((content) => JSON.parse(content) as CacheState)
        .then((state) => state.schemaVersion === 1 && state.date === this.date
          ? state
          : { schemaVersion: 1 as const, date: this.date, complete: false, responses: {} })
        .catch(() => ({ schemaVersion: 1 as const, date: this.date, complete: false, responses: {} }))
    }
    return this.statePromise
  }

  async get(query: string) {
    const state = await this.state()
    return Object.hasOwn(state.responses, query) ? state.responses[query] : undefined
  }

  async set(query: string, hits: SearchHit[]) {
    const state = await this.state()
    state.responses[query] = hits
    await this.persist(state)
  }

  async isComplete() {
    return (await this.state()).complete
  }

  async markComplete() {
    const state = await this.state()
    state.complete = true
    await this.persist(state)
  }

  private async persist(state: CacheState) {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
      await rename(temporary, this.path)
    })
    await this.writeQueue
  }
}
