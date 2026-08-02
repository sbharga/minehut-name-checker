export const CACHE_KEY = 'minehut-name-checker:v1'
export const MAX_CONCURRENCY = 1
export const MIN_REQUEST_INTERVAL_MS = 650

export type ResultStatus = 'available' | 'taken' | 'invalid' | 'error'
export type ResultSource = 'api' | 'cache' | 'validation'

export interface ParsedName {
  displayName: string
  normalizedName: string
}

export interface CheckResult extends ParsedName {
  status: ResultStatus
  source: ResultSource
  reason?: string
  checkedAt: number
}

export interface ParseResult {
  valid: ParsedName[]
  invalid: CheckResult[]
  duplicateCount: number
}

export type DefinitiveResult = CheckResult & {
  status: 'available' | 'taken'
  source: 'api' | 'cache'
}

export type ResultCache = Record<string, DefinitiveResult>

export function parseNames(input: string, now = Date.now()): ParseResult {
  const tokens = input.split(/[\s,]+/).filter(Boolean)
  const seen = new Set<string>()
  const valid: ParsedName[] = []
  const invalid: CheckResult[] = []
  let duplicateCount = 0

  for (const displayName of tokens) {
    const normalizedName = displayName.toLowerCase()

    if (seen.has(normalizedName)) {
      duplicateCount += 1
      continue
    }

    seen.add(normalizedName)
    const reason = getValidationError(displayName)

    if (reason) {
      invalid.push({
        displayName,
        normalizedName,
        status: 'invalid',
        source: 'validation',
        reason,
        checkedAt: now,
      })
    } else {
      valid.push({ displayName, normalizedName })
    }
  }

  return { valid, invalid, duplicateCount }
}

export function getValidationError(name: string): string | undefined {
  if (name.length < 4) return 'Must be at least 4 characters'
  if (name.length > 12) return 'Must be no more than 12 characters'
  if (!/^[a-z0-9]+$/i.test(name)) return 'Only letters and numbers are allowed'
  return undefined
}

export function readSessionCache(storage: Pick<Storage, 'getItem' | 'removeItem'>): ResultCache {
  const raw = storage.getItem(CACHE_KEY)
  if (!raw) return {}

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()

    const cache: ResultCache = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isCachedResult(value) || key !== value.normalizedName) continue
      cache[key] = { ...value, source: 'cache' }
    }
    return cache
  } catch {
    storage.removeItem(CACHE_KEY)
    return {}
  }
}

export function writeSessionCache(
  storage: Pick<Storage, 'setItem'>,
  cache: ResultCache,
): void {
  storage.setItem(CACHE_KEY, JSON.stringify(cache))
}

function isCachedResult(value: unknown): value is DefinitiveResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<DefinitiveResult>
  return (
    typeof result.displayName === 'string' &&
    typeof result.normalizedName === 'string' &&
    (result.status === 'available' || result.status === 'taken') &&
    typeof result.checkedAt === 'number'
  )
}

export interface RequestDependencies {
  fetchImpl?: typeof fetch
  sleepImpl?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  onRateLimit?: (retryAfterMilliseconds: number) => void
}

export async function requestName(
  name: ParsedName,
  signal: AbortSignal,
  dependencies: RequestDependencies = {},
): Promise<DefinitiveResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleepImpl = dependencies.sleepImpl ?? abortableDelay
  let transientAttempt = 0
  let rateLimitAttempt = 0

  while (true) {
    try {
      const response = await fetchImpl(
        `https://api.minehut.com/server/${encodeURIComponent(name.normalizedName)}?byName=true`,
        { signal },
      )

      if (!response.ok) {
        if (response.status === 429) {
          const retryDelay = getRateLimitDelay(response, rateLimitAttempt)
          rateLimitAttempt += 1
          dependencies.onRateLimit?.(retryDelay)
          await sleepImpl(retryDelay, signal)
          continue
        }
        if (response.status >= 500 && transientAttempt < 2) {
          await sleepImpl(getTransientRetryDelay(response, transientAttempt), signal)
          transientAttempt += 1
          continue
        }
        throw new Error(`Request failed with status ${response.status}`)
      }

      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' || !('server' in payload)) {
        throw new Error('Minehut returned an unexpected response')
      }

      const server = (payload as { server: unknown }).server
      if (server !== null && (typeof server !== 'object' || Array.isArray(server))) {
        throw new Error('Minehut returned an unexpected response')
      }

      return {
        ...name,
        status: server === null ? 'available' : 'taken',
        source: 'api',
        checkedAt: Date.now(),
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      if (transientAttempt < 2 && isNetworkError(error)) {
        await sleepImpl(500 * 2 ** transientAttempt, signal)
        transientAttempt += 1
        continue
      }
      throw error
    }
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function getRateLimitDelay(response: Response, attempt: number): number {
  const headerDelay = getHeaderDelay(response)
  if (headerDelay !== undefined) return Math.min(Math.max(headerDelay, 1_000), 15 * 60_000)

  // Minehut does not expose quota headers on normal responses. If a 429 also
  // omits Retry-After, wait out a typical rate-limit window before trying again.
  return Math.min(60_000 * 2 ** attempt, 5 * 60_000)
}

function getTransientRetryDelay(response: Response, attempt: number): number {
  return getHeaderDelay(response) ?? Math.min(500 * 2 ** attempt, 2_000)
}

function getHeaderDelay(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(seconds * 1_000, 0)

    const dateDelay = Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(dateDelay)) return Math.max(dateDelay, 0)
  }
  return undefined
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Request aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

export interface QueueOptions extends RequestDependencies {
  concurrency?: number
  minimumRequestIntervalMilliseconds?: number
  signal: AbortSignal
  onStart?: (name: ParsedName) => void
  onSettled?: (result: CheckResult) => void
}

export async function runCheckQueue(names: ParsedName[], options: QueueOptions): Promise<void> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? MAX_CONCURRENCY, names.length))
  const requestInterval = Math.max(
    0,
    options.minimumRequestIntervalMilliseconds ?? MIN_REQUEST_INTERVAL_MS,
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl = options.sleepImpl ?? abortableDelay
  let nextIndex = 0
  let nextRequestAt = 0

  const pacedFetch: typeof fetch = async (input, init) => {
    const scheduledAt = Math.max(Date.now(), nextRequestAt)
    nextRequestAt = scheduledAt + requestInterval
    const delay = scheduledAt - Date.now()
    if (delay > 0) await sleepImpl(delay, options.signal)
    return fetchImpl(input, init)
  }

  async function worker(): Promise<void> {
    while (!options.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= names.length) return

      const name = names[index]
      options.onStart?.(name)

      try {
        const result = await requestName(name, options.signal, {
          ...options,
          fetchImpl: pacedFetch,
        })
        options.onSettled?.(result)
      } catch (error) {
        if (options.signal.aborted || isAbortError(error)) return
        options.onSettled?.({
          ...name,
          status: 'error',
          source: 'api',
          reason: error instanceof Error ? error.message : 'Unable to check this name',
          checkedAt: Date.now(),
        })
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}
