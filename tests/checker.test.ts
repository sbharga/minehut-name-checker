import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_KEY,
  formatDuration,
  parseNames,
  readSessionCache,
  requestName,
  runCheckQueue,
  writeSessionCache,
  type DefinitiveResult,
  type ParsedName,
} from '../src/checker'

const names = (...values: string[]): ParsedName[] =>
  values.map((value) => ({ displayName: value, normalizedName: value.toLowerCase() }))

const jsonResponse = (payload: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

describe('parseNames', () => {
  it('supports common paste separators and deduplicates without regard to case', () => {
    const parsed = parseNames('Minehut, fresh123\nFRESH123  world9', 100)

    expect(parsed.valid).toEqual(names('Minehut', 'fresh123', 'world9'))
    expect(parsed.invalid).toEqual([])
    expect(parsed.duplicateCount).toBe(1)
  })

  it('rejects names outside the length and character rules', () => {
    const parsed = parseNames('abc abcdefghijklm bad-name okay4', 100)

    expect(parsed.valid).toEqual(names('okay4'))
    expect(parsed.invalid.map(({ displayName, reason }) => ({ displayName, reason }))).toEqual([
      { displayName: 'abc', reason: 'Must be at least 4 characters' },
      { displayName: 'abcdefghijklm', reason: 'Must be no more than 12 characters' },
      { displayName: 'bad-name', reason: 'Only letters and numbers are allowed' },
    ])
  })

  it('accepts the exact 4 and 12 character boundaries', () => {
    expect(parseNames('abcd abcdefgh1234').valid).toHaveLength(2)
  })
})

describe('session cache', () => {
  it('round-trips definitive results and restores them as cached', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    const result: DefinitiveResult = {
      displayName: 'Fresh123',
      normalizedName: 'fresh123',
      status: 'available',
      source: 'api',
      checkedAt: 100,
    }

    writeSessionCache(storage, { fresh123: result })

    expect(readSessionCache(storage)).toEqual({
      fresh123: { ...result, source: 'cache' },
    })
  })

  it('discards malformed persisted data', () => {
    const removeItem = vi.fn()
    const storage = {
      getItem: () => '{not json',
      removeItem,
    }

    expect(readSessionCache(storage)).toEqual({})
    expect(removeItem).toHaveBeenCalledWith(CACHE_KEY)
  })

  it('never restores failed results from storage', () => {
    const failedResult = {
      failed1: {
        displayName: 'failed1',
        normalizedName: 'failed1',
        status: 'error',
        source: 'api',
        reason: 'Network error',
        checkedAt: 100,
      },
    }
    const storage = {
      getItem: () => JSON.stringify(failedResult),
      removeItem: vi.fn(),
    }

    expect(readSessionCache(storage)).toEqual({})
  })
})

describe('requestName', () => {
  it.each([
    [{ server: null }, 'available'],
    [{ server: { name: 'Minehut' } }, 'taken'],
  ] as const)('classifies the API response %#', async (payload, status) => {
    const result = await requestName(names('Minehut')[0], new AbortController().signal, {
      fetchImpl: vi.fn(async () => jsonResponse(payload)),
    })

    expect(result.status).toBe(status)
  })

  it('keeps retrying throttled responses and respects Retry-After', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '120' } }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ server: null }))
    const sleepImpl = vi.fn(async () => undefined)
    const onRateLimit = vi.fn()

    const result = await requestName(names('fresh123')[0], new AbortController().signal, {
      fetchImpl,
      sleepImpl,
      onRateLimit,
    })

    expect(result.status).toBe('available')
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 120_000, expect.any(AbortSignal))
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 120_000, expect.any(AbortSignal))
    expect(sleepImpl).toHaveBeenNthCalledWith(3, 240_000, expect.any(AbortSignal))
    expect(sleepImpl).toHaveBeenNthCalledWith(4, 300_000, expect.any(AbortSignal))
    expect(onRateLimit).toHaveBeenCalledTimes(4)
  })

  it('rejects an unexpected successful response', async () => {
    await expect(
      requestName(names('fresh123')[0], new AbortController().signal, {
        fetchImpl: vi.fn(async () => jsonResponse({ somethingElse: true })),
      }),
    ).rejects.toThrow('unexpected response')
  })
})

describe('runCheckQueue', () => {
  it('caps concurrent work and emits results in completion order', async () => {
    let active = 0
    let maximumActive = 0
    const settled: string[] = []
    const delays: Record<string, number> = { alpha1: 20, bravo2: 5, charlie3: 1 }
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const name = new URL(String(url)).pathname.split('/').pop() ?? ''
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, delays[name]))
      active -= 1
      return jsonResponse({ server: null })
    })

    await runCheckQueue(names('alpha1', 'bravo2', 'charlie3'), {
      concurrency: 2,
      minimumRequestIntervalMilliseconds: 0,
      signal: new AbortController().signal,
      fetchImpl,
      onSettled: (result) => settled.push(result.normalizedName),
    })

    expect(maximumActive).toBe(2)
    expect(settled).toEqual(['bravo2', 'charlie3', 'alpha1'])
  })

  it('paces request starts below the API rate limit', async () => {
    let currentTime = 0
    const requestTimes: number[] = []
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)

    try {
      await runCheckQueue(names('alpha1', 'bravo2', 'charlie3'), {
        signal: new AbortController().signal,
        fetchImpl: vi.fn(async () => {
          requestTimes.push(Date.now())
          return jsonResponse({ server: null })
        }),
        sleepImpl: vi.fn(async (milliseconds) => {
          currentTime += milliseconds
        }),
      })
    } finally {
      dateNow.mockRestore()
    }

    expect(requestTimes).toEqual([0, 650, 1_300])
  })

  it('turns non-transient request failures into error results', async () => {
    const settled: string[] = []

    await runCheckQueue(names('alpha1'), {
      signal: new AbortController().signal,
      fetchImpl: vi.fn(async () => jsonResponse({}, { status: 404 })),
      onSettled: (result) => settled.push(result.status),
    })

    expect(settled).toEqual(['error'])
  })
})

describe('formatDuration', () => {
  it('formats short and minute-scale estimates', () => {
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(72_000)).toBe('1m 12s')
  })
})
