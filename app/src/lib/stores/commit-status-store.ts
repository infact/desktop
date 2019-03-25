import { Account } from '../../models/account'
import { AccountsStore } from './accounts-store'
import { GitHubRepository } from '../../models/github-repository'
import { API, IAPIRefStatus } from '../api'
import { IDisposable, Disposable } from 'event-kit'
import pLimit from 'p-limit'
import { remote, ipcRenderer } from 'electron'

interface ICommitStatusCacheEntry {
  readonly status: IAPIRefStatus | null
  readonly fetchedAt: Date
}

export type StatusCallBack = (status: IAPIRefStatus | null) => void

interface IRefStatusSubscription {
  readonly endpoint: string
  readonly owner: string
  readonly name: string
  readonly ref: string
  readonly callbacks: Set<StatusCallBack>
}

function getCacheKeyForRepository(repository: GitHubRepository, ref: string) {
  const { endpoint, owner, name } = repository
  return getCacheKey(endpoint, owner.login, name, ref)
}

function getCacheKey(
  endpoint: string,
  owner: string,
  name: string,
  ref: string
) {
  return `${endpoint}/repos/${owner}/${name}/commits/${ref}/status`
}

function entryIsEligibleForRefresh(entry: ICommitStatusCacheEntry) {
  const elapsed = Date.now() - entry.fetchedAt.valueOf()
  return elapsed > 60 * 1000
}

const BackgroundRefreshInterval = 60 * 1000

export class CommitStatusStore {
  private accounts: ReadonlyArray<Account> = []

  private backgroundRefreshHandle: number | null = null
  private refreshQueued = false

  private readonly subscriptions = new Map<string, IRefStatusSubscription>()
  private readonly cache = new Map<string, ICommitStatusCacheEntry>()
  private readonly queue = new Map<string, Promise<void>>()
  private readonly limit = pLimit(5)

  public constructor(accountsStore: AccountsStore) {
    accountsStore.getAll().then(accounts => (this.accounts = accounts))
    accountsStore.onDidUpdate(accounts => (this.accounts = accounts))

    ipcRenderer.on('focus', () => {
      this.startBackgroundRefresh()
      this.queueRefresh()
    })

    ipcRenderer.on('blur', () => this.stopBackgroundRefresh())

    if (remote.getCurrentWindow().isFocused()) {
      this.startBackgroundRefresh()
    }
  }

  private startBackgroundRefresh() {
    if (this.backgroundRefreshHandle === null) {
      this.backgroundRefreshHandle = window.setInterval(
        () => this.queueRefresh(),
        BackgroundRefreshInterval
      )
    }
  }

  private stopBackgroundRefresh() {
    if (this.backgroundRefreshHandle !== null) {
      window.clearInterval(this.backgroundRefreshHandle)
      this.backgroundRefreshHandle = null
    }
  }

  private queueRefresh() {
    if (!this.refreshQueued) {
      this.refreshQueued = true
      setImmediate(() => {
        this.refreshQueued = false
        this.refreshEligibleSubscriptions()
      })
    }
  }

  private async refreshEligibleSubscriptions() {
    for (const key of this.subscriptions.keys()) {
      // Is it already being worked on?
      if (this.queue.has(key)) {
        continue
      }

      const entry = this.cache.get(key)

      if (entry && !entryIsEligibleForRefresh(entry)) {
        continue
      }

      this.queue.set(
        key,
        this.limit(async () => {
          try {
            this.refreshSubscription(key)
          } finally {
            this.queue.delete(key)
          }
        })
      )
    }
  }

  private async refreshSubscription(key: string) {
    // Make sure it's still a valid subscription that
    // someone might care about before fetching
    const subscription = this.subscriptions.get(key)

    if (subscription === undefined) {
      return
    }

    const { endpoint, owner, name, ref } = subscription
    const account = this.accounts.find(a => a.endpoint === endpoint)

    if (account === undefined) {
      return
    }

    const status = await API.fromAccount(account)
      .fetchCombinedRefStatus(owner, name, ref)
      .catch(err => null)

    const entry = { status, fetchedAt: new Date() }
    this.cache.set(getCacheKey(endpoint, owner, name, ref), entry)

    subscription.callbacks.forEach(cb => cb(status))
  }

  public tryGetStatus(
    repository: GitHubRepository,
    ref: string
  ): IAPIRefStatus | null {
    const entry = this.cache.get(getCacheKeyForRepository(repository, ref))
    return entry !== undefined ? entry.status : null
  }

  private getOrCreateSubscription(repository: GitHubRepository, ref: string) {
    const key = getCacheKeyForRepository(repository, ref)
    let subscription = this.subscriptions.get(key)

    if (subscription !== undefined) {
      return subscription
    }

    subscription = {
      endpoint: repository.endpoint,
      owner: repository.owner.login,
      name: repository.name,
      ref,
      callbacks: new Set<StatusCallBack>(),
    }

    this.subscriptions.set(key, subscription)

    return subscription
  }

  public subscribe(
    repository: GitHubRepository,
    ref: string,
    callback: StatusCallBack
  ): IDisposable {
    const key = getCacheKeyForRepository(repository, ref)
    const subscription = this.getOrCreateSubscription(repository, ref)

    subscription.callbacks.add(callback)
    this.queueRefresh()

    return new Disposable(() => {
      subscription.callbacks.delete(callback)
      if (subscription.callbacks.size === 0) {
        this.subscriptions.delete(key)
      }
    })
  }
}
