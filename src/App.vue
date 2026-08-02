<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  CACHE_KEY,
  MAX_CONCURRENCY,
  formatDuration,
  parseNames,
  readSessionCache,
  runCheckQueue,
  writeSessionCache,
  type CheckResult,
  type DefinitiveResult,
  type ResultCache,
  type ResultStatus,
} from './checker'

type ResultFilter = 'all' | ResultStatus
type RunState = 'idle' | 'running' | 'complete' | 'stopped'
type ProcessingOrder = 'input' | 'shortest' | 'longest'
type ResultSort = 'newest' | 'oldest' | 'name-asc' | 'name-desc' | 'shortest' | 'longest' | 'status'

const PROCESSING_ORDER_KEY = 'minehut-name-checker:processing-order'

const input = ref('')
const baseUrl = import.meta.env.BASE_URL
const results = ref<CheckResult[]>(Object.values(loadCache()))
const activeNames = ref<string[]>([])
const selectedFilter = ref<ResultFilter>('all')
const processingOrder = ref<ProcessingOrder>(loadProcessingOrder())
const resultSort = ref<ResultSort>('newest')
const runState = ref<RunState>('idle')
const queueActive = ref(false)
const totalCheckable = ref(0)
const completedCheckable = ref(0)
const networkCompleted = ref(0)
const runStartedAt = ref(0)
const now = ref(Date.now())
const rateLimitUntil = ref(0)
const sessionCache = ref<ResultCache>(loadCache())

let controller: AbortController | null = null
let timer: number | null = null

const parsedInput = computed(() => parseNames(input.value))
const uniqueCount = computed(
  () => parsedInput.value.valid.length + parsedInput.value.invalid.length,
)
const isRunning = computed(() => runState.value === 'running')
const cacheCount = computed(() => Object.keys(sessionCache.value).length)
const progressPercent = computed(() => {
  if (!totalCheckable.value) return 0
  return Math.min(100, Math.round((completedCheckable.value / totalCheckable.value) * 100))
})
const elapsed = computed(() => Math.max(0, now.value - runStartedAt.value))
const eta = computed(() => {
  const remaining = totalCheckable.value - completedCheckable.value
  if (!isRunning.value || remaining <= 0) return '0s'
  if (!networkCompleted.value || elapsed.value <= 0) return 'Calculating…'
  const requestsPerMillisecond = networkCompleted.value / elapsed.value
  return formatDuration(remaining / requestsPerMillisecond)
})

const counts = computed(() => {
  const totals: Record<ResultStatus, number> = {
    available: 0,
    taken: 0,
    invalid: 0,
    error: 0,
  }
  for (const result of results.value) totals[result.status] += 1
  return totals
})

const filters = computed(() => [
  { value: 'all' as const, label: 'All', count: results.value.length },
  { value: 'available' as const, label: 'Available', count: counts.value.available },
  { value: 'taken' as const, label: 'Taken', count: counts.value.taken },
  { value: 'invalid' as const, label: 'Invalid', count: counts.value.invalid },
  { value: 'error' as const, label: 'Failed', count: counts.value.error },
])

const filteredResults = computed(() => {
  const filtered = selectedFilter.value === 'all'
    ? results.value
    : results.value.filter((result) => result.status === selectedFilter.value)

  return [...filtered].sort((a, b) => {
    if (resultSort.value === 'oldest') return a.checkedAt - b.checkedAt
    if (resultSort.value === 'name-asc') return a.normalizedName.localeCompare(b.normalizedName)
    if (resultSort.value === 'name-desc') return b.normalizedName.localeCompare(a.normalizedName)
    if (resultSort.value === 'shortest') {
      return a.displayName.length - b.displayName.length || a.normalizedName.localeCompare(b.normalizedName)
    }
    if (resultSort.value === 'longest') {
      return b.displayName.length - a.displayName.length || a.normalizedName.localeCompare(b.normalizedName)
    }
    if (resultSort.value === 'status') {
      return a.status.localeCompare(b.status) || a.normalizedName.localeCompare(b.normalizedName)
    }
    return b.checkedAt - a.checkedAt
  })
})

const progressLabel = computed(() => {
  if (runState.value === 'stopped') return 'Check stopped'
  if (runState.value === 'complete') return 'Check complete'
  if (rateLimitUntil.value > now.value) {
    return `Rate limited — retrying in ${formatDuration(rateLimitUntil.value - now.value)}`
  }
  if (activeNames.value.length === 0) return 'Preparing checks…'
  const [first, ...rest] = activeNames.value
  return rest.length ? `Checking ${first} + ${rest.length} more` : `Checking ${first}`
})

function loadCache(): ResultCache {
  try {
    return readSessionCache(sessionStorage)
  } catch {
    return {}
  }
}

function loadProcessingOrder(): ProcessingOrder {
  try {
    const saved = localStorage.getItem(PROCESSING_ORDER_KEY)
    if (saved === 'input' || saved === 'shortest' || saved === 'longest') return saved
  } catch {
    // Use the default if browser storage is unavailable.
  }
  return 'shortest'
}

function persistCache(): void {
  try {
    writeSessionCache(sessionStorage, sessionCache.value)
  } catch {
    // The checker still works if browser storage is disabled or full.
  }
}

async function startCheck(): Promise<void> {
  if (queueActive.value || uniqueCount.value === 0) return

  const parsed = parseNames(input.value)
  for (const invalid of parsed.invalid) upsertResult(invalid)
  activeNames.value = []
  totalCheckable.value = parsed.valid.length
  completedCheckable.value = 0
  networkCompleted.value = 0
  runStartedAt.value = Date.now()
  now.value = runStartedAt.value
  rateLimitUntil.value = 0

  const orderedNames = [...parsed.valid].sort((a, b) => {
    if (processingOrder.value === 'shortest') {
      return a.displayName.length - b.displayName.length
    }
    if (processingOrder.value === 'longest') {
      return b.displayName.length - a.displayName.length
    }
    return 0
  })

  const uncached = []
  for (const name of orderedNames) {
    const cached = sessionCache.value[name.normalizedName]
    if (cached) {
      upsertResult({ ...cached, displayName: name.displayName, source: 'cache' })
      completedCheckable.value += 1
    } else {
      uncached.push(name)
    }
  }

  if (uncached.length === 0) {
    runState.value = 'complete'
    return
  }

  runState.value = 'running'
  queueActive.value = true
  controller = new AbortController()
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)

  await runCheckQueue(uncached, {
    concurrency: MAX_CONCURRENCY,
    signal: controller.signal,
    onRateLimit: (retryAfterMilliseconds) => {
      rateLimitUntil.value = Date.now() + retryAfterMilliseconds
    },
    onStart: (name) => {
      activeNames.value = [...activeNames.value, name.displayName]
    },
    onSettled: (result) => {
      rateLimitUntil.value = 0
      activeNames.value = activeNames.value.filter(
        (activeName) => activeName.toLowerCase() !== result.normalizedName,
      )
      upsertResult(result)
      completedCheckable.value += 1
      networkCompleted.value += 1

      if (result.status === 'available' || result.status === 'taken') {
        sessionCache.value[result.normalizedName] = result as DefinitiveResult
        persistCache()
      }
    },
  })

  stopTimer()
  activeNames.value = []
  rateLimitUntil.value = 0
  now.value = Date.now()
  if (runState.value === 'running') runState.value = 'complete'
  queueActive.value = false
  controller = null
}

function stopCheck(): void {
  if (!controller) return
  runState.value = 'stopped'
  controller.abort()
  stopTimer()
}

function clearInput(): void {
  input.value = ''
}

function clearResults(): void {
  if (isRunning.value) stopCheck()
  results.value = []
  activeNames.value = []
  rateLimitUntil.value = 0
  selectedFilter.value = 'all'
  totalCheckable.value = 0
  completedCheckable.value = 0
  runState.value = 'idle'
}

function clearHistory(): void {
  sessionCache.value = {}
  try {
    sessionStorage.removeItem(CACHE_KEY)
  } catch {
    // Storage may be unavailable in restrictive browser modes.
  }
  clearResults()
}

function upsertResult(result: CheckResult): void {
  const existingIndex = results.value.findIndex(
    (existing) => existing.normalizedName === result.normalizedName,
  )
  if (existingIndex === -1) results.value.push(result)
  else results.value.splice(existingIndex, 1, result)
}

function exportResults(): void {
  const header = ['Name', 'Status', 'Reason', 'Source', 'Checked at']
  const rows = results.value.map((result) => [
    result.displayName,
    result.status,
    result.reason ?? '',
    result.source,
    new Date(result.checkedAt).toISOString(),
  ])
  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `minehut-name-results-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function stopTimer(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
}

function statusLabel(status: ResultStatus): string {
  if (status === 'error') return 'Failed'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function statusClasses(status: ResultStatus): string {
  return {
    available: 'bg-[#00C8D3]/10 text-[#5de8ef] ring-[#00C8D3]/20',
    taken: 'bg-slate-400/10 text-slate-300 ring-slate-300/15',
    invalid: 'bg-amber-400/10 text-amber-300 ring-amber-400/20',
    error: 'bg-rose-400/10 text-rose-300 ring-rose-400/20',
  }[status]
}

function statusDotClasses(status: ResultStatus): string {
  return {
    available: 'bg-[#00C8D3]',
    taken: 'bg-stone-400',
    invalid: 'bg-amber-500',
    error: 'bg-rose-500',
  }[status]
}

watch(processingOrder, (value) => {
  try {
    localStorage.setItem(PROCESSING_ORDER_KEY, value)
  } catch {
    // The setting remains active for this page when storage is unavailable.
  }
})

onBeforeUnmount(() => {
  controller?.abort()
  stopTimer()
})
</script>

<template>
  <div class="flex h-dvh w-full flex-col overflow-hidden bg-[#0a0a0a] text-slate-100 selection:bg-[#00C8D3]/40">
    <header class="relative z-10 h-14 shrink-0 border-b border-white/8 bg-[#0a0a0a]">
      <div class="mx-auto flex h-full w-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <a :href="baseUrl" class="font-semibold tracking-tight text-white">
          Minehut <span class="font-normal text-slate-500">Name Checker</span>
        </a>

        <div class="flex items-center gap-2">
          <button
            v-if="results.length"
            type="button"
            class="px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-200"
            @click="exportResults"
          >
            Export CSV
          </button>
          <button
            type="button"
            class="px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-200 disabled:cursor-default disabled:opacity-40"
            :disabled="(cacheCount === 0 && results.length === 0) || queueActive"
            @click="clearHistory"
          >
            Clear cache<span v-if="cacheCount" class="ml-1 tabular-nums">{{ cacheCount }}</span>
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto grid min-h-0 w-full max-w-7xl flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(300px,0.78fr)_minmax(0,1.22fr)] lg:grid-rows-1 lg:p-5">
      <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/8 bg-[#171717]">
        <div class="shrink-0 border-b border-white/6 px-4 py-3.5 sm:px-5 sm:py-4 lg:px-6 lg:py-5">
          <h1 class="text-xl font-semibold tracking-[-0.025em] text-white lg:text-2xl">Find a name that fits.</h1>
          <p class="mt-1.5 text-xs leading-5 text-slate-400 sm:text-sm">
            Paste names separated by spaces, commas, or new lines. Use 4–12 letters or numbers.
          </p>
        </div>

        <div class="flex min-h-0 flex-1 flex-col p-3 sm:p-4 lg:p-5">
          <div class="mb-2.5 flex shrink-0 items-center justify-between gap-3">
            <label for="names" class="text-xs font-semibold text-slate-300">Server names</label>
            <div class="flex items-center gap-2 text-[11px] text-slate-500">
              <span>{{ uniqueCount ? `${uniqueCount} unique` : 'No names added' }}</span>
              <button
                v-if="input"
                type="button"
                class="font-medium text-slate-500 transition hover:text-slate-200 disabled:opacity-40"
                :disabled="queueActive"
                @click="clearInput"
              >
                Clear
              </button>
            </div>
          </div>

          <div class="relative min-h-24 flex-1 lg:min-h-0">
            <textarea
              id="names"
              v-model="input"
              spellcheck="false"
              :disabled="queueActive"
              placeholder="coolserver&#10;myworld123&#10;survival"
              class="absolute inset-0 block size-full resize-none rounded-md border border-white/10 bg-black/20 px-3.5 py-3 font-mono text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-[#00C8D3]/80 focus:bg-black/30 focus:ring-2 focus:ring-[#00C8D3]/10 disabled:cursor-not-allowed disabled:opacity-65"
            ></textarea>
          </div>

          <div
            v-if="parsedInput.invalid.length || parsedInput.duplicateCount"
            class="mt-3 shrink-0 rounded-md border border-white/6 bg-white/[0.025] px-3 py-2.5"
          >
            <div class="flex items-center justify-between gap-3 text-xs">
              <span class="text-slate-400">Input cleanup</span>
              <div class="flex items-center gap-2 tabular-nums">
                <span v-if="parsedInput.invalid.length" class="text-amber-400">{{ parsedInput.invalid.length }} invalid</span>
                <span v-if="parsedInput.duplicateCount" class="text-slate-500">{{ parsedInput.duplicateCount }} duplicate</span>
              </div>
            </div>
          </div>

          <div class="mt-3 flex shrink-0 items-center justify-between gap-3">
            <label for="processing-order" class="text-xs font-medium text-slate-400">Processing order</label>
            <select
              id="processing-order"
              v-model="processingOrder"
              :disabled="queueActive"
              class="rounded-md border border-white/10 bg-[#111] px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-[#00C8D3]/80 disabled:opacity-50"
            >
              <option value="shortest">Shortest first</option>
              <option value="longest">Longest first</option>
              <option value="input">Input order</option>
            </select>
          </div>

          <button
            v-if="queueActive"
            type="button"
            class="mt-3 inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-slate-100 px-5 text-sm font-semibold text-slate-950 transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-white/10 disabled:cursor-wait disabled:opacity-70"
            :disabled="!isRunning"
            @click="stopCheck"
          >
            <span class="size-2.5 rounded-[2px] bg-white"></span>
            {{ isRunning ? 'Stop check' : 'Stopping…' }}
          </button>
          <button
            v-else
            type="button"
            class="mt-3 inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[#00C8D3] px-5 text-sm font-semibold text-[#04191b] transition hover:bg-[#31d7df] focus:outline-none focus:ring-2 focus:ring-[#00C8D3]/15 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-slate-600"
            :disabled="uniqueCount === 0"
            @click="startCheck"
          >
            Check {{ uniqueCount || '' }} {{ uniqueCount === 1 ? 'name' : 'names' }}
            <svg viewBox="0 0 20 20" class="size-4" aria-hidden="true">
              <path d="m7 4 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </section>

      <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/8 bg-[#171717]">
        <div class="shrink-0 border-b border-white/6 px-4 py-3 sm:px-5 sm:py-3.5">
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="text-sm font-semibold text-white">Results</h2>
                <span v-if="results.length" class="rounded-md bg-white/7 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-400">{{ results.length }}</span>
              </div>
              <p class="mt-0.5 truncate text-[11px] text-slate-400">
                {{ results.length ? 'Updated live as names are checked' : 'Your checked names will appear here' }}
              </p>
            </div>
          </div>

          <div v-if="runState !== 'idle'" class="mt-3" aria-live="polite">
            <div class="mb-2 flex items-end justify-between gap-4">
              <div class="min-w-0">
                <p class="truncate text-xs font-medium text-slate-300">{{ progressLabel }}</p>
                <p class="mt-0.5 text-[11px] tabular-nums text-slate-400">{{ completedCheckable }} / {{ totalCheckable }} checked</p>
              </div>
              <div class="shrink-0 text-right">
                <span class="text-sm font-semibold tabular-nums text-slate-100">{{ progressPercent }}%</span>
                <span class="ml-2 text-[11px] tabular-nums text-slate-400">{{ isRunning ? `${eta} left` : formatDuration(elapsed) }}</span>
              </div>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-white/7">
              <div
                class="h-full rounded-full bg-[#00C8D3] transition-[width] duration-300 ease-out"
                :style="{ width: `${progressPercent}%` }"
              ></div>
            </div>
          </div>
        </div>

        <template v-if="results.length">
          <div class="shrink-0 border-b border-white/6 px-2 py-2 sm:px-3">
            <div class="flex items-center gap-2">
              <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
              <button
                v-for="filter in filters"
                :key="filter.value"
                type="button"
                role="tab"
                :aria-selected="selectedFilter === filter.value"
                class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition"
                :class="selectedFilter === filter.value ? 'bg-[#00C8D3] text-[#04191b]' : 'text-slate-500 hover:bg-white/5 hover:text-slate-200'"
                @click="selectedFilter = filter.value"
              >
                {{ filter.label }}
                <span
                  class="rounded px-1 py-0.5 text-[9px] tabular-nums"
                  :class="selectedFilter === filter.value ? 'bg-black/15 text-[#04191b]' : 'bg-white/7 text-slate-500'"
                >{{ filter.count }}</span>
              </button>
              </div>
              <select
                v-model="resultSort"
                aria-label="Sort results"
                class="shrink-0 rounded-md border border-white/10 bg-[#111] px-2 py-1.5 text-[11px] text-slate-300 outline-none focus:border-[#00C8D3]/80"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
                <option value="shortest">Shortest</option>
                <option value="longest">Longest</option>
                <option value="status">Status</option>
              </select>
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <TransitionGroup name="result" tag="ul" class="divide-y divide-white/6" aria-live="polite">
              <li
                v-for="result in filteredResults"
                :key="`${result.normalizedName}-${result.checkedAt}`"
                class="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-white/[0.025] sm:px-5"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.035] ring-1 ring-white/8">
                    <span class="size-2 rounded-full" :class="statusDotClasses(result.status)"></span>
                  </span>
                  <div class="min-w-0">
                    <p class="truncate font-mono text-[13px] font-semibold text-slate-200">{{ result.displayName }}</p>
                    <p v-if="result.reason" class="mt-0.5 truncate text-[11px] text-slate-400">{{ result.reason }}</p>
                    <p v-else-if="result.source === 'cache'" class="mt-0.5 text-[11px] text-slate-400">Session cache</p>
                  </div>
                </div>
                <span
                  class="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold ring-1 ring-inset"
                  :class="statusClasses(result.status)"
                >
                  {{ statusLabel(result.status) }}
                </span>
              </li>
            </TransitionGroup>
            <div v-if="filteredResults.length === 0" class="grid h-full min-h-32 place-items-center px-5 text-center text-xs text-slate-400">
              No results in this category.
            </div>
          </div>
        </template>

        <div v-else class="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div>
            <div class="mx-auto grid size-12 place-items-center rounded-lg bg-[#00C8D3]/10 text-[#00C8D3] ring-1 ring-[#00C8D3]/15">
              <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true">
                <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M9 12l2 2 9-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <p class="mt-3 text-sm font-medium text-slate-300">Ready when you are</p>
            <p class="mt-1 max-w-56 text-xs leading-5 text-slate-400">Add server names on the left and start checking availability.</p>
          </div>
        </div>

      </section>
    </main>
  </div>
</template>
