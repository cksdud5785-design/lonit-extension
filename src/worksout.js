const BASE_URL = 'https://www.worksout.co.kr'
const API_BASE_URL = 'https://api.worksout.co.kr/v1'
const PDP_URL_PREFIX = `${BASE_URL}/products/`
const PDP_URL_RE = /\/products\/(\d+)(?:[/?#]|$)/
const SEARCH_PATH_RE = /\/search\/result(?:[/?#]|$)/i
// 2026-05-19 사용자 신고 RCA — 508건 검색결과 중 116 수집 후 SW auto-resume.
// 기존 5000ms throttle 은 508 × 3-5 fetch × 5s = 30-60분 → SW idle sleep (chrome 의 30s
// idle timer) → graceful shutdown + auto-resume 반복. Playwright 정찰: 10건 연속 fetch
// 356ms 전부 200 OK, 차단 없음. 300ms 로 단축 (508 × 4 fetch × 0.3s = ~10분).
// 2026-05-20 #3: 사용자 신고 "worksout 사이트 자체 0건 표시" — WAF (AWS Shield) IP
// 차단 확인. 분당 200+ req 폭주 → 자동 block. 분당 60 req 영역 (1초/req) 로 완화하여
// 재발 방지. SW idle sleep 회피 (1초 < 30초 timer) 유지.
const FETCH_DELAY_MS = 1000
// 2026-05-19 #2: fetch hang 시 SW 가 awaiting promise resolve 안 되는 hang 차단.
const FETCH_TIMEOUT_MS = 30_000
// 2026-05-20 #3: WAF block (403/429) 응답 시 즉시 collect abort. 무한 retry 차단.
const WAF_BLOCK_STATUS = new Set([403, 429])
// 2026-05-20 #4: WAF block 받으면 30분 cool-down — 같은 SW 의 다음 worksout collect
// 시도도 모두 즉시 reject. 사용자 IP 차단 deepening 방지.
const WAF_COOLDOWN_MS = 30 * 60_000
let _wafBackoffUntil = 0
// 2026-05-19 #2: 자주 server POST → DB INSERT 진행 가시화 (사용자 모니터링 안정).
// 기존 20 → 5. STREAM_BATCH × FETCH_DELAY (~5 × 1.2s = 6s) 단위로 onBatch 발생.
const STREAM_BATCH = 5
const ALLOWED_HOSTS = new Set([
  'worksout.co.kr',
  'www.worksout.co.kr',
])

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let _lastFetchAt = 0
let _stockEndpointStrategy

const STOCK_ENDPOINT_CANDIDATES = [
  { mode: 'product', path: '/stock' },
  { mode: 'product', path: '/inventory' },
  { mode: 'size', pathTemplate: '/sizes/{sizeId}/stock' },
]

const STOCK_VALUE_KEYS = [
  'stockCount',
  'availableStock',
  'quantity',
  'stock',
  'inventory',
  'remainingStock',
  'remainQuantity',
  'availableQty',
  'availableStockUser',
]

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function throttle() {
  const now = Date.now()
  // 2026-05-20 #4: WAF cool-down 시 모든 fetch 즉시 abort. 30분 후 자연 해제.
  if (now < _wafBackoffUntil) {
    const wait = Math.round((_wafBackoffUntil - now) / 1000)
    throw new Error(`WAF_COOLDOWN_ACTIVE — ${wait}s 후 재시도 가능. worksout IP 차단 의심, 모바일 hotspot 또는 라우터 재시작 권장`)
  }
  const elapsed = now - _lastFetchAt
  if (elapsed < FETCH_DELAY_MS) {
    await delay(FETCH_DELAY_MS - elapsed)
  }
  _lastFetchAt = Date.now()
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toOptionalNumber(value) {
  if (value == null) return null
  if (typeof value === 'boolean') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeStock(value, fallback = 0) {
  const n = toOptionalNumber(value)
  if (n == null) return fallback
  return Math.max(0, Math.trunc(n))
}

function normalizeUrl(value, base = BASE_URL) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  try {
    return new URL(raw, base).href
  } catch {
    return raw
  }
}

function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const value of values || []) {
    const clean = normalizeUrl(value)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

async function fetchWorksout(url, opts = {}) {
  await throttle()
  const asText = !!opts?.asText
  // 2026-05-19 #2: AbortController + setTimeout 으로 30s hang 방지. caller signal 도 결합.
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS)
  const onCallerAbort = () => timeoutController.abort()
  if (opts?.signal) opts.signal.addEventListener('abort', onCallerAbort, { once: true })
  let res
  try {
    res = await fetch(url, {
    signal: timeoutController.signal,
    headers: {
      Accept: asText
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        : 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'User-Agent': USER_AGENT,
    },
    })
  } finally {
    clearTimeout(timeoutId)
    if (opts?.signal) opts.signal.removeEventListener('abort', onCallerAbort)
  }
  if (!res.ok) {
    // 2026-05-20 #3+#4: WAF block 시 cool-down arming + 구별된 error throw.
    if (WAF_BLOCK_STATUS.has(res.status)) {
      _wafBackoffUntil = Date.now() + WAF_COOLDOWN_MS
      throw new Error(`WAF_BLOCK_${res.status} (${url}) — worksout 가 IP 를 차단. 30분 cooldown 적용. 1-24h 후 자동 해제 또는 모바일 hotspot/VPN 권장`)
    }
    throw new Error(`HTTP ${res.status} (${url})`)
  }
  if (asText) return await res.text()
  const data = await res.json()
  // 2026-05-19 RCA: api.worksout.co.kr 가 `{code, message, payload}` envelope 로 응답.
  // 단일 product 조회 시 payload 가 length=1 array. legacy fixture 는 직접 object 라
  // envelope 부재 케이스도 보존.
  if (data && typeof data === 'object' && !Array.isArray(data) && 'payload' in data) {
    const p = data.payload
    if (Array.isArray(p)) return p[0] ?? null
    return p
  }
  return data
}

async function fetchOtherColor(productId, opts = {}) {
  return await fetchWorksout(`${API_BASE_URL}/products/${encodeURIComponent(String(productId))}/otherColor`, opts)
}

function extractPdpUrlsFromHtml(html, limit = 10000) {
  const out = []
  const seen = new Set()
  const re = /(?:https?:\/\/(?:www\.)?worksout\.co\.kr)?\/products\/(\d+)(?:[/?#"'&]|$)/g
  let match
  while ((match = re.exec(String(html ?? ''))) !== null) {
    const productId = String(match[1] || '')
    if (!productId || seen.has(productId)) continue
    seen.add(productId)
    out.push(`${PDP_URL_PREFIX}${productId}`)
    if (out.length >= limit) break
  }
  return out
}

function toCategorySource(detail) {
  return [detail?.category1Name, detail?.category2Name]
    .filter(Boolean)
    .join(' > ')
}

function getBasePrice(detail) {
  return toNumber(detail?.currentPrice, toNumber(detail?.initialPrice, 0))
}

function readStockValue(record) {
  for (const key of STOCK_VALUE_KEYS) {
    const value = toOptionalNumber(record?.[key])
    if (value != null) return normalizeStock(value)
  }
  return null
}

function normalizeStockEntry(record, fallback = {}) {
  if (record == null) return null

  if (typeof record !== 'object') {
    const quantity = toOptionalNumber(record)
    if (quantity == null) return null
    return {
      productSizeId: String(fallback.productSizeId ?? ''),
      sizeName: String(fallback.sizeName ?? '').trim(),
      quantity,
      raw: record,
    }
  }

  return {
    productSizeId: String(
      record.productSizeId
      ?? record.sizeId
      ?? record.id
      ?? record.sku
      ?? fallback.productSizeId
      ?? '',
    ),
    sizeName: String(
      record.sizeName
      ?? record.name
      ?? record.optionName
      ?? fallback.sizeName
      ?? '',
    ).trim(),
    stockCount: record.stockCount,
    availableStock: record.availableStock,
    availableStockUser: record.availableStockUser,
    quantity: record.quantity ?? record.stock ?? record.inventory ?? record.remainingStock ?? record.remainQuantity ?? record.availableQty,
    raw: record,
  }
}

function normalizeStockEntries(payload, fallback = {}) {
  const entries = []
  const visited = new WeakSet()

  function visit(value, nextFallback = fallback) {
    if (value == null) return

    if (Array.isArray(value)) {
      for (const item of value) visit(item, nextFallback)
      return
    }

    if (typeof value !== 'object') {
      const entry = normalizeStockEntry(value, nextFallback)
      if (entry && readStockValue(entry) != null) entries.push(entry)
      return
    }

    if (visited.has(value)) return
    visited.add(value)

    const directEntry = normalizeStockEntry(value, nextFallback)
    if (directEntry && readStockValue(directEntry) != null) {
      entries.push(directEntry)
    }

    for (const [key, child] of Object.entries(value)) {
      if (child == null) continue
      if (typeof child !== 'object') continue
      const childFallback = /^\d+$/.test(key)
        ? {
            ...nextFallback,
            productSizeId: nextFallback.productSizeId || key,
          }
        : nextFallback
      visit(child, childFallback)
    }
  }

  visit(payload, fallback)
  return entries
}

function getSizesArray(detail) {
  if (Array.isArray(detail?.sizes)) return detail.sizes
  if (Array.isArray(detail?.productSizes)) return detail.productSizes
  return []
}

function hasOptionScopedStockEntries(entries, detail) {
  if (!Array.isArray(entries) || entries.length === 0) return false
  const sizes = getSizesArray(detail)
  if (sizes.length <= 1) return true
  return entries.some((entry) => entry?.productSizeId || entry?.sizeName)
}

function findStockEntry(detail, size) {
  const entries = Array.isArray(detail?.__stockEntries) ? detail.__stockEntries : []
  if (entries.length === 0) return null

  const targetId = String(size?.productSizeId ?? size?.sizeId ?? size?.sku ?? '')
  const targetName = String(size?.sizeName ?? '').trim().toLowerCase()

  for (const entry of entries) {
    if (!entry) continue
    if (targetId && String(entry.productSizeId ?? '') === targetId) return entry
  }

  for (const entry of entries) {
    if (!entry) continue
    if (targetName && String(entry.sizeName ?? '').trim().toLowerCase() === targetName) return entry
  }

  const sizes = getSizesArray(detail)
  if (sizes.length === 1 && entries.length === 1) return entries[0]

  return null
}

function resolveOptionStock(detail, size) {
  const stockEntry = findStockEntry(detail, size)
  const entryStock = readStockValue(stockEntry)
  if (entryStock != null) return entryStock

  const sizeStock = readStockValue(size)
  if (sizeStock != null) return sizeStock

  if (size?.isSoldOut) return 0

  const explicitStock = readStockValue(detail)
  if (explicitStock != null) return explicitStock

  return 10
}

function resolveOptionPriceDiff(detail, size) {
  const optionPrice = toOptionalNumber(size?.price)
  if (optionPrice == null) return 0
  return optionPrice - getBasePrice(detail)
}

function isEndpointMissingError(error) {
  return /^HTTP (404|405)\b/.test(String(error?.message ?? ''))
}

async function fetchStockEntriesForPath(productId, detail, path, opts = {}) {
  const payload = await fetchWorksout(
    `${API_BASE_URL}/products/${encodeURIComponent(String(productId))}${path}`,
    opts,
  )
  const entries = normalizeStockEntries(payload)
  return hasOptionScopedStockEntries(entries, detail) ? entries : []
}

async function fetchStockEntriesPerSize(productId, detail, pathTemplate, opts = {}) {
  const sizes = getSizesArray(detail)
  const entries = []

  for (const size of sizes) {
    const productSizeId = String(size?.productSizeId ?? '')
    if (!productSizeId) continue

    try {
      const payload = await fetchWorksout(
        `${API_BASE_URL}/products/${encodeURIComponent(String(productId))}${pathTemplate.replace('{sizeId}', encodeURIComponent(productSizeId))}`,
        opts,
      )
      const normalized = normalizeStockEntries(payload, {
        productSizeId,
        sizeName: size?.sizeName,
      })
      entries.push(...normalized)
    } catch (error) {
      console.warn(`[BulkFlow Worksout] stock size ${productId}/${productSizeId} 실패:`, error.message)
    }
  }

  return entries
}

async function discoverStockEndpointStrategy(productId, detail, opts = {}) {
  if (_stockEndpointStrategy !== undefined) return { strategy: _stockEndpointStrategy, entries: [] }

  const sizes = getSizesArray(detail)
  if (sizes.length === 0) {
    _stockEndpointStrategy = false
    return { strategy: null, entries: [] }
  }

  let sawRetryableError = false

  for (const candidate of STOCK_ENDPOINT_CANDIDATES) {
    try {
      if (candidate.mode === 'product') {
        const entries = await fetchStockEntriesForPath(productId, detail, candidate.path, opts)
        if (entries.length > 0) {
          _stockEndpointStrategy = candidate
          return { strategy: candidate, entries }
        }
        continue
      }

      const firstSize = sizes[0]
      const productSizeId = String(firstSize?.productSizeId ?? '')
      if (!productSizeId) continue

      const payload = await fetchWorksout(
        `${API_BASE_URL}/products/${encodeURIComponent(String(productId))}${candidate.pathTemplate.replace('{sizeId}', encodeURIComponent(productSizeId))}`,
        opts,
      )
      const entries = normalizeStockEntries(payload, {
        productSizeId,
        sizeName: firstSize?.sizeName,
      })
      if (entries.length > 0) {
        _stockEndpointStrategy = candidate
        return { strategy: candidate, entries }
      }
    } catch (error) {
      if (!isEndpointMissingError(error)) {
        sawRetryableError = true
      }
    }
  }

  if (!sawRetryableError) {
    _stockEndpointStrategy = false
  }

  return { strategy: null, entries: [] }
}

async function fetchStockEntries(productId, detail, opts = {}) {
  if (opts?.stockEntries !== undefined) {
    return Array.isArray(opts.stockEntries) ? opts.stockEntries : []
  }

  if (_stockEndpointStrategy === false) return []

  if (_stockEndpointStrategy === undefined) {
    const discovered = await discoverStockEndpointStrategy(productId, detail, opts)
    if (discovered.entries.length > 0) return discovered.entries
    if (!discovered.strategy) return []
  }

  if (_stockEndpointStrategy?.mode === 'product') {
    return await fetchStockEntriesForPath(productId, detail, _stockEndpointStrategy.path, opts)
  }

  if (_stockEndpointStrategy?.mode === 'size') {
    return await fetchStockEntriesPerSize(productId, detail, _stockEndpointStrategy.pathTemplate, opts)
  }

  return []
}

export function parseUrl(url) {
  const result = {
    url: String(url ?? ''),
    productId: '',
    keyword: '',
    page: 1,
    isPdp: false,
    isSearchUrl: false,
  }

  if (!url || typeof url !== 'string') return result

  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!ALLOWED_HOSTS.has(host)) return result

    const productId = parsed.pathname.match(PDP_URL_RE)?.[1] || ''
    const keyword = (
      parsed.searchParams.get('searchKeyword')
      || parsed.searchParams.get('keyword')
      || parsed.searchParams.get('q')
      || parsed.searchParams.get('search')
      || ''
    ).trim()
    const page = Number(parsed.searchParams.get('page') || '1')

    result.productId = productId
    result.keyword = keyword
    result.page = Number.isFinite(page) && page > 0 ? page : 1
    result.isPdp = !!productId
    result.isSearchUrl = SEARCH_PATH_RE.test(parsed.pathname) || (!!keyword && !productId)
    return result
  } catch {
    result.productId = String(url).match(PDP_URL_RE)?.[1] || ''
    result.isPdp = !!result.productId
    return result
  }
}

export function parseNotices(detailOrInfo) {
  const info = detailOrInfo?.productInfo || detailOrInfo
  if (!info || typeof info !== 'object') return null

  const notices = {}
  if (info.material) notices.material = String(info.material)
  if (info.color) notices.color = String(info.color)
  if (info.colorKoreanName) notices.colorKoreanName = String(info.colorKoreanName)
  if (info.fit) notices.fit = String(info.fit)
  if (info.fabric) notices.fabric = String(info.fabric)
  if (info.manufacturer) notices.manufacturer = String(info.manufacturer)
  if (info.manufactureCountry) notices.manufactureCountry = String(info.manufactureCountry)
  if (info.importer) notices.importer = String(info.importer)
  if (info.productionDate) notices.productionDate = String(info.productionDate)

  return Object.keys(notices).length > 0 ? notices : null
}

export function parseOptions(detail, otherColor = null) {
  void otherColor
  const sizes = getSizesArray(detail)
  return sizes.map((size) => {
    const stock = resolveOptionStock(detail, size)
    return {
      optionName: String(size?.sizeName || '').trim() || 'FREE',
      sku: String(size?.productSizeId ?? ''),
      stock,
      isSoldout: stock <= 0,
      priceDiff: resolveOptionPriceDiff(detail, size),
    }
  })
}

export function parseProduct(detail, opts = {}) {
  if (!detail || typeof detail !== 'object') return null

  const sourceId = String(opts?.productId || detail?.productId || '')
  if (!sourceId) return null

  // 2026-05-20 RCA: 운영 DB worksout 전건 images=[]. detail API 응답에 images/
  // productImageUrls 가 비어 있는 듯 (외부 IP 정찰 504 차단). search API content[i]
  // 의 thumbnailUrl + hoverUrl 는 항상 채워짐 — opts.searchItem 으로 받아 fallback.
  let images = uniqueStrings(
    Array.isArray(detail?.images) && detail.images.length > 0
      ? detail.images.map((image) => image?.originalUrl || image?.thumbnailUrl)
      : detail?.productImageUrls,
  )
  if (images.length === 0 && opts?.searchItem) {
    images = uniqueStrings([opts.searchItem.thumbnailUrl, opts.searchItem.hoverUrl].filter(Boolean))
  }
  const options = parseOptions(detail, opts?.otherColor || null)
  const productNotices = parseNotices(detail)
  const isSoldout = detail?.onlyOffline === true
    || (options.length > 0 && options.every((option) => option.isSoldout))

  return {
    sourceMarket: 'worksout',
    sourceId,
    sourceUrl: opts?.sourceUrl || `${PDP_URL_PREFIX}${sourceId}`,
    originalTitle: String(detail?.productName || '').trim(),
    brand: String(detail?.brandName || '').trim(),
    originalPrice: toNumber(detail?.initialPrice, 0),
    sellPrice: toNumber(detail?.currentPrice, toNumber(detail?.initialPrice, 0)),
    images,
    options,
    categorySource: toCategorySource(detail),
    ...(productNotices ? { productNotices } : {}),
    isSoldout,
  }
}

export async function getDetail(productId, opts = {}) {
  if (!productId) throw new Error('productId 필수')
  const detail = await fetchWorksout(`${API_BASE_URL}/products/${encodeURIComponent(String(productId))}`, opts)

  try {
    const stockEntries = await fetchStockEntries(productId, detail, opts)
    if (stockEntries.length > 0) {
      return {
        ...detail,
        __stockEntries: stockEntries,
      }
    }
  } catch (error) {
    console.warn(`[BulkFlow Worksout] stock ${productId} 실패:`, error.message)
  }

  return detail
}

export async function getOptions(productId, opts = {}) {
  if (!productId) throw new Error('productId 필수')

  const detail = opts?.detail || await getDetail(productId, opts)
  let otherColor = null

  if (opts?.otherColor !== undefined) {
    otherColor = opts.otherColor
  } else if (detail?.productInfo?.groupId != null || detail?.productInfo?.optionVisible === true) {
    try {
      otherColor = await fetchOtherColor(productId, opts)
    } catch (error) {
      console.warn(`[BulkFlow Worksout] otherColor ${productId} 실패:`, error.message)
    }
  }

  return parseOptions(detail, otherColor)
}

async function getProductBundle(productId, opts = {}) {
  const detail = await getDetail(productId, opts)

  let otherColor = null
  try {
    otherColor = await fetchOtherColor(productId, opts)
  } catch (error) {
    console.warn(`[BulkFlow Worksout] otherColor ${productId} 실패:`, error.message)
  }

  return { detail, otherColor }
}

async function collectPdp(parsed, onProgress, options = {}) {
  onProgress(0, 1, 0, '웍스아웃 PDP 조회중...')

  try {
    const bundle = await getProductBundle(parsed.productId, options)
    const product = parseProduct(bundle.detail, {
      productId: parsed.productId,
      sourceUrl: parsed.url || `${PDP_URL_PREFIX}${parsed.productId}`,
      otherColor: bundle.otherColor,
    })
    if (!product) {
      onProgress(100, 0, 0, '웍스아웃 PDP 파싱 실패')
      return []
    }
    if (options?.onBatch) await options.onBatch([product])
    onProgress(100, 1, 1, '수집 완료')
    return [product]
  } catch (error) {
    console.warn(`[BulkFlow Worksout] ${parsed.productId} skip:`, error.message)
    onProgress(100, 1, 0, '웍스아웃 PDP 실패')
    return []
  }
}

// 2026-05-19 RCA: 사용자 신고 "worksout 한도 10000 인데 30개만". 기존 collectSearchFallback
// 는 검색 HTML 1회 fetch + extractPdpUrlsFromHtml 만 — 첫 page 의 SSR PDP link (~20-30) 만
// 추출. Playwright 정찰로 실 API 발견: GET api.worksout.co.kr/v1/search?size=20&page=N
// (Spring Boot Page: payload.products.content[] + totalElements/totalPages/last).
// 신규 path = API 페이지네이션으로 productId 수집 → 기존 PDP detail fetch 흐름 재사용.
const SEARCH_PAGE_SIZE = 20

async function collectSearchAPI(parsed, limit, onProgress, options = {}) {
  const keyword = parsed.keyword
  if (!keyword) {
    onProgress(100, 0, 0, '웍스아웃 검색어 없음')
    return []
  }

  // ── Phase 1: API 페이지네이션으로 search item 수집 (limit 까지)
  // 2026-05-20: productId 만이 아니라 item 전체 보존 — parseProduct 에 searchItem
  // hint 로 전달하여 detail.images 비어있을 때 thumbnailUrl/hoverUrl fallback.
  const searchItems = []
  let page = 0
  let totalPages = 1
  let totalElements = 0
  while (searchItems.length < limit && page < totalPages) {
    if (options?.signal?.aborted) break
    onProgress(0, totalElements, searchItems.length, `웍스아웃 검색 ${searchItems.length}/${limit}`)
    // mainCategoryId=0 = 전체 카테고리 (미지정 시 BAD_REQUEST).
    const apiUrl = `${API_BASE_URL}/search?mainCategoryId=0&searchKeyword=${encodeURIComponent(keyword)}&sort=id,desc&size=${SEARCH_PAGE_SIZE}&page=${page}`
    let payload
    try {
      payload = await fetchWorksout(apiUrl, options)
    } catch (e) {
      console.warn(`[BulkFlow Worksout] search page ${page} 실패:`, e.message)
      break
    }
    const productsObj = payload?.products
    if (!productsObj || !Array.isArray(productsObj.content)) break
    totalElements = Number(productsObj.totalElements) || 0
    totalPages = Number(productsObj.totalPages) || 1
    for (const item of productsObj.content) {
      if (searchItems.length >= limit) break
      if (item?.productId) searchItems.push(item)
    }
    if (productsObj.last === true) break
    page++
  }

  if (searchItems.length === 0) {
    // API 페이지네이션 실패 시 legacy HTML fallback (구 동작)
    console.warn('[BulkFlow Worksout] search API 0 result, HTML fallback 시도')
    return await collectSearchFallback(parsed, limit, onProgress, options)
  }

  // ── Phase 2: productId 별 PDP detail fetch + parseProduct (search item hint 포함)
  const products = []
  const pendingBatch = []
  for (let i = 0; i < searchItems.length; i++) {
    if (options?.signal?.aborted) break
    const searchItem = searchItems[i]
    const productId = String(searchItem.productId)
    try {
      const bundle = await getProductBundle(productId, options)
      const sourceUrl = `${PDP_URL_PREFIX}${productId}`
      const product = parseProduct(bundle.detail, { productId, sourceUrl, otherColor: bundle.otherColor, searchItem })
      if (!product) continue
      products.push(product)
      pendingBatch.push(product)
      if (pendingBatch.length >= STREAM_BATCH && options?.onBatch) {
        await options.onBatch([...pendingBatch])
        pendingBatch.length = 0
      }
    } catch (e) {
      console.warn(`[BulkFlow Worksout] ${productId} skip:`, e.message)
    }
    const progress = Math.min(99, Math.round(((i + 1) / searchItems.length) * 100))
    onProgress(progress, searchItems.length, products.length, `웍스아웃 ${products.length}/${searchItems.length}`)
  }

  if (pendingBatch.length > 0 && options?.onBatch) {
    await options.onBatch([...pendingBatch])
  }
  onProgress(100, productIds.length, products.length, '수집 완료')
  return products
}

async function collectSearchFallback(parsed, limit, onProgress, options = {}) {
  if (!parsed.url) {
    onProgress(100, 0, 0, '웍스아웃 검색 URL 없음')
    return []
  }

  onProgress(0, 0, 0, '웍스아웃 검색 HTML 조회중...')

  let html
  try {
    html = await fetchWorksout(parsed.url, { ...options, asText: true })
  } catch (error) {
    console.warn('[BulkFlow Worksout] 검색 페이지 fetch 실패:', error.message)
    onProgress(100, 0, 0, '웍스아웃 검색 페이지 실패')
    return []
  }

  // TODO: official search API endpoint is not confirmed in this sandbox.
  // Fallback path: search HTML -> extract PDP URLs -> fetch PDP detail API per product.
  const pdpUrls = extractPdpUrlsFromHtml(html, limit)
  if (pdpUrls.length === 0) {
    console.warn('[BulkFlow Worksout] 검색 HTML 에서 PDP URL을 찾지 못함')
    onProgress(100, 0, 0, '웍스아웃 검색 결과 없음')
    return []
  }

  const products = []
  const pendingBatch = []

  for (let index = 0; index < pdpUrls.length && products.length < limit; index++) {
    if (options?.signal?.aborted) break

    const sourceUrl = pdpUrls[index]
    const productId = sourceUrl.match(PDP_URL_RE)?.[1] || ''
    if (!productId) continue

    try {
      const bundle = await getProductBundle(productId, options)
      const product = parseProduct(bundle.detail, {
        productId,
        sourceUrl,
        otherColor: bundle.otherColor,
      })
      if (!product) {
        console.warn(`[BulkFlow Worksout] ${productId} skip: parseProduct 실패`)
        continue
      }

      products.push(product)
      pendingBatch.push(product)

      if (pendingBatch.length >= STREAM_BATCH && options?.onBatch) {
        await options.onBatch([...pendingBatch])
        pendingBatch.length = 0
      }
    } catch (error) {
      console.warn(`[BulkFlow Worksout] ${productId} skip:`, error.message)
    }

    const progress = Math.min(99, Math.round(((index + 1) / pdpUrls.length) * 100))
    onProgress(progress, pdpUrls.length, products.length, `웍스아웃 ${products.length}/${pdpUrls.length}`)
  }

  if (pendingBatch.length > 0 && options?.onBatch) {
    await options.onBatch([...pendingBatch])
  }

  onProgress(100, pdpUrls.length, products.length, '수집 완료')
  return products
}

export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  if (limit <= 0) {
    onProgress(100, 0, 0, '웍스아웃 limit 0')
    return []
  }

  const parsed = parseUrl(url)
  if (parsed.isPdp) {
    return await collectPdp(parsed, onProgress, options)
  }

  // 2026-05-19: 검색 — API 페이지네이션 primary (limit 까지 자동 다중 페이지).
  // API 실패 시 collectSearchAPI 내부에서 collectSearchFallback (HTML extract) 으로 degrade.
  return await collectSearchAPI(parsed, limit, onProgress, options)
}

export function cleanupWorksoutTab() {
  // fetch path only
}
