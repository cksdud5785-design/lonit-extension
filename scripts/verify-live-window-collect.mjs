import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SITE_PARSERS } from '../src/site-parsers/index.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_TIMEOUT_MS = 60_000;

const TARGETS = [
  {
    label: 'Nike.com/kr search -> PDP',
    siteName: 'nike',
    url: 'https://www.nike.com/kr/w?q=nike',
    plpExtractor: 'nike',
    limit: 1,
  },
  {
    label: 'OliveYoung.co.kr PDP',
    siteName: 'oliveyoung',
    url: 'https://m.oliveyoung.co.kr/goods/A000000249650',
    limit: 1,
  },
  {
    label: 'Adidas.co.kr PDP',
    siteName: 'adidas',
    url: 'https://www.adidas.co.kr/%EC%82%BC%EB%B0%94-og-/KJ8900.html',
    limit: 1,
  },
  {
    label: 'Gmarket.co.kr global PDP',
    siteName: 'gmarket',
    url: 'https://global.gmarket.co.kr/item?goodscode=2773785814',
    limit: 1,
  },
  {
    label: 'TheHyundai.com PDP',
    siteName: 'thehyundai',
    url: 'https://hi.thehyundai.com/product/40B0148057',
    limit: 1,
  },
  {
    label: 'FolderStyle.com service page',
    siteName: 'folderstyle',
    url: 'https://www.folderstyle.com/serviceEndInfo',
    limit: 1,
    allowNoProducts: true,
    unavailableReason: 'Official FolderStyle store redirects to serviceEndInfo; new orders and payments are stopped.',
  },
];

const REQUIRED_CHECKS = [
  'identity',
  'image',
  'options',
  'optionStock',
  'optionPrice',
  'detailInfo',
  'productNotices',
];

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyObject(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  return Object.values(value).some((entry) => {
    if (entry == null) return false;
    if (typeof entry === 'string') return entry.trim().length > 0;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (Array.isArray(entry)) return entry.length > 0;
    if (typeof entry === 'object') return hasNonEmptyObject(entry);
    return Boolean(entry);
  });
}

function hasProductPrice(product) {
  return [
    product?.sellPrice,
    product?.salePrice,
    product?.finalPrice,
    product?.originalPrice,
    product?.price,
  ].some((value) => Number.isFinite(Number(value)));
}

function hasOptionPrice(option, product) {
  const hasAbsoluteOptionPrice = [
    option?.sellPrice,
    option?.salePrice,
    option?.finalPrice,
    option?.originalPrice,
    option?.optionPrice,
  ].some((value) => Number.isFinite(Number(value)));

  if (hasAbsoluteOptionPrice) return true;
  return Number.isFinite(Number(option?.priceDiff)) && hasProductPrice(product);
}

function hasOptionStock(option) {
  return [
    option?.stock,
    option?.quantity,
    option?.availableQuantity,
  ].some((value) => value != null && Number.isFinite(Number(value))) || option?.isSoldout != null;
}

function summarizePrice(product) {
  return [
    product?.sellPrice,
    product?.salePrice,
    product?.finalPrice,
    product?.originalPrice,
    product?.price,
  ].find((value) => Number.isFinite(Number(value))) ?? null;
}

function summarizeOptionPrice(option, product) {
  const absolute = [
    option?.sellPrice,
    option?.salePrice,
    option?.finalPrice,
    option?.originalPrice,
    option?.optionPrice,
  ].find((value) => Number.isFinite(Number(value)));
  if (absolute != null) return Number(absolute);
  if (Number.isFinite(Number(option?.priceDiff)) && hasProductPrice(product)) {
    return Number(summarizePrice(product)) + Number(option.priceDiff);
  }
  return null;
}

function validateProduct(product) {
  const options = Array.isArray(product?.options) ? product.options : [];
  const images = Array.isArray(product?.images) ? product.images : [];
  const detailImages = Array.isArray(product?.detailImages) ? product.detailImages : [];

  const checks = {
    identity: hasText(product?.sourceMarket) && hasText(product?.sourceId || product?.externalId || product?.productId) && hasText(product?.sourceUrl),
    image: images.length > 0 || detailImages.length > 0 || hasText(product?.imageUrl) || hasText(product?.thumbnailUrl),
    options: options.length > 0,
    optionStock: options.length > 0 && options.every(hasOptionStock),
    optionPrice: options.length > 0 && options.every((option) => hasOptionPrice(option, product)),
    detailInfo: hasText(product?.description) || hasText(product?.detailHtml) || detailImages.length > 0,
    productNotices: hasNonEmptyObject(product?.productNotices),
  };

  return {
    checks,
    missing: REQUIRED_CHECKS.filter((key) => !checks[key]),
  };
}

async function collectTarget(target) {
  const parser = SITE_PARSERS[target.siteName];
  if (!parser) {
    return failResult(target, `missing parser: ${target.siteName}`);
  }

  const page = await capturePageWithRetry(target.url, target);
  await saveHtmlArtifact(target, page.html);

  if (detectBotBlock(page.html)) {
    return {
      label: target.label,
      siteName: target.siteName,
      url: target.url,
      status: 'blocked',
      ok: !!target.allowBlocked,
      allowed: !!target.allowBlocked,
      count: 0,
      missing: REQUIRED_CHECKS,
      htmlLength: page.html.length,
      stderr: page.stderr.slice(0, 1000),
    };
  }

  if (detectTransientServerError(page.html)) {
    return {
      label: target.label,
      siteName: target.siteName,
      url: target.url,
      status: 'server_error',
      ok: false,
      count: 0,
      missing: REQUIRED_CHECKS,
      htmlLength: page.html.length,
      stderr: page.stderr.slice(0, 1000),
    };
  }

  const plpItems = buildPlpItems(target, page.html, target.url);
  const rawProducts = await parser.parse(page.html, target.url, null, plpItems);
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
    return {
      label: target.label,
      siteName: target.siteName,
      url: target.url,
      status: 'no_products',
      ok: !!target.allowNoProducts,
      allowed: !!target.allowNoProducts,
      unavailableReason: target.unavailableReason || '',
      count: 0,
      missing: REQUIRED_CHECKS,
      htmlLength: page.html.length,
      plpItemCount: plpItems?.length || 0,
    };
  }

  const products = await enrichProducts({
    products: rawProducts.slice(0, target.limit || 1),
    parser,
    siteName: target.siteName,
    originUrl: target.url,
  });
  const product = products[0] || null;
  const validation = validateProduct(product);

  return {
    label: target.label,
    siteName: target.siteName,
    url: target.url,
    status: validation.missing.length === 0 ? 'ok' : 'quality_fail',
    ok: validation.missing.length === 0,
    count: products.length,
    missing: validation.missing,
    checks: validation.checks,
    htmlLength: page.html.length,
    plpItemCount: plpItems?.length || 0,
    sample: summarizeProduct(product),
  };
}

function failResult(target, error) {
  return {
    label: target.label,
    siteName: target.siteName,
    url: target.url,
    status: 'error',
    ok: false,
    count: 0,
    missing: REQUIRED_CHECKS,
    error,
  };
}

async function capturePageWithRetry(url, target) {
  const maxAttempts = target.captureAttempts || 3;
  let lastPage = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastPage = await capturePage(url, target);
    if (!detectTransientServerError(lastPage.html)) return lastPage;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  return lastPage;
}

function capturePage(url, target) {
  const captureUrl = withLonitParams(url, target.siteName, target.limit || 1);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--window-size=1365,768',
    '--dump-dom',
    captureUrl,
  ];

  return new Promise((resolvePage, rejectPage) => {
    const child = spawn(CHROME_PATH, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectPage(new Error(`${target.label} Chrome timeout`));
    }, target.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPage(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        rejectPage(new Error(`${target.label} Chrome exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolvePage({ html: stdout, stderr, code });
    });
  });
}

function withLonitParams(url, siteName, limit) {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams((parsed.hash || '').replace(/^#/, ''));
    params.set('__lonit_site', siteName);
    params.set('__lonit_limit', String(limit));
    parsed.hash = params.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

async function enrichProducts({ products, parser, siteName, originUrl }) {
  const enriched = [];
  const seen = new Set();
  for (const product of products) {
    const detailUrl = normalizeDetailUrl(product?.sourceUrl);
    if (!shouldFetchDetail(product, detailUrl, originUrl) || seen.has(detailUrl)) {
      enriched.push(product);
      continue;
    }
    seen.add(detailUrl);
    try {
      const page = await capturePage(detailUrl, { label: `${siteName} detail`, siteName, limit: 1 });
      if (detectBotBlock(page.html)) {
        enriched.push(product);
        continue;
      }
      const detailProducts = await parser.parse(page.html, detailUrl, null, null);
      const detailProduct = Array.isArray(detailProducts)
        ? detailProducts.find((entry) => !entry?.isShallow) || detailProducts[0]
        : null;
      enriched.push(hasUsefulDetail(detailProduct) ? mergeProduct(product, detailProduct) : product);
    } catch {
      enriched.push(product);
    }
  }
  return enriched;
}

function shouldFetchDetail(product, detailUrl, originUrl) {
  if (!product || !detailUrl) return false;
  if (sameUrlWithoutLonitParams(detailUrl, originUrl)) return false;
  const options = Array.isArray(product.options) ? product.options : [];
  return product.isShallow === true || options.length === 0 || options.some((option) => option?.stock == null || option?.priceDiff == null);
}

function hasUsefulDetail(product) {
  if (!product || product.isShallow === true) return false;
  return (
    (Array.isArray(product.options) && product.options.length > 0)
    || (Array.isArray(product.images) && product.images.length > 0)
    || (Array.isArray(product.detailImages) && product.detailImages.length > 0)
    || !!product.productNotices
    || !!product.detailHtml
    || !!product.description
  );
}

function mergeProduct(shallow, detail) {
  return {
    ...shallow,
    ...detail,
    sourceUrl: detail.sourceUrl || shallow.sourceUrl,
    sourceId: detail.sourceId || shallow.sourceId,
    productId: detail.productId || shallow.productId,
    externalId: detail.externalId || shallow.externalId,
    originalTitle: detail.originalTitle || shallow.originalTitle,
    images: Array.isArray(detail.images) && detail.images.length > 0 ? detail.images : (shallow.images || []),
    detailImages: Array.isArray(detail.detailImages) && detail.detailImages.length > 0 ? detail.detailImages : (shallow.detailImages || []),
    options: Array.isArray(detail.options) && detail.options.length > 0 ? detail.options : (shallow.options || []),
    isShallow: false,
  };
}

function buildPlpItems(target, html, url) {
  if (target.plpExtractor === 'nike') return extractNikePlpItems(html, url, target.limit || 1);
  return null;
}

function extractNikePlpItems(html, baseUrl, limit) {
  const items = [];
  const seen = new Set();
  const re = /href=["']([^"']*\/kr\/t\/[^"']+\/([A-Z0-9]{2,}-[0-9]+)[^"']*)["']/gi;
  let match;
  while ((match = re.exec(html)) && items.length < limit) {
    const href = decodeEntities(match[1]);
    const sourceUrl = resolveUrl(baseUrl, href);
    const sourceId = match[2];
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const nearby = html.slice(Math.max(0, match.index - 1000), Math.min(html.length, match.index + 2000));
    items.push({
      sourceId,
      url: sourceUrl,
      title: extractAttribute(nearby, 'aria-label') || stripTags(nearby).slice(0, 120),
      image: extractFirstImage(nearby, sourceUrl),
      price: extractPrice(nearby),
    });
  }
  return items;
}

function detectBotBlock(html) {
  return (
    /id=["']captcha["']/i.test(html) ||
    /class=["'][^"']*cf-challenge[^"']*["']/i.test(html) ||
    /_cf_chl_opt|challenge-platform|cloudflare-branding|Enable JavaScript and cookies/i.test(html) ||
    /sec-if-cpt-container|akamai[^<]{0,120}(?:challenge|blocked|bot)|잠시만\s*기다리십시오/i.test(html) ||
    /WAFfailoverassets|unable to give you access|HTTP\s*403\s*-\s*Forbidden|security issue was automatically identified/i.test(html) ||
    /denied access|access denied|blocked by/i.test(html)
  );
}

function detectTransientServerError(html) {
  return (
    /<h1>\s*50[234]\b/i.test(html) ||
    /\b(?:502|503|504)\s+(?:Bad Gateway|Service Unavailable|Gateway Time-out|Gateway Timeout)\b/i.test(html) ||
    /The server didn't respond in time/i.test(html)
  );
}

function summarizeProduct(product) {
  if (!product) return null;
  const options = Array.isArray(product.options) ? product.options : [];
  const firstOption = options[0] || null;
  return {
    sourceMarket: product.sourceMarket,
    sourceId: product.sourceId || product.externalId || product.productId,
    title: product.originalTitle || product.title || product.name,
    sourceUrl: product.sourceUrl,
    imageCount: Array.isArray(product.images) ? product.images.length : 0,
    detailImageCount: Array.isArray(product.detailImages) ? product.detailImages.length : 0,
    hasDescription: hasText(product.description),
    hasDetailHtml: hasText(product.detailHtml),
    productPrice: summarizePrice(product),
    optionCount: options.length,
    firstOption: firstOption ? {
      optionName: firstOption.optionName || firstOption.name,
      stock: firstOption.stock,
      isSoldout: firstOption.isSoldout,
      priceDiff: firstOption.priceDiff,
      salePrice: firstOption.salePrice,
      finalPrice: firstOption.finalPrice,
      effectivePrice: summarizeOptionPrice(firstOption, product),
    } : null,
    hasProductNotices: hasNonEmptyObject(product.productNotices),
  };
}

async function saveHtmlArtifact(target, html) {
  await mkdir(resolve('output'), { recursive: true });
  const safe = target.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await writeFile(resolve(`output/live-window-${safe}.html`), html, 'utf8');
}

function normalizeDetailUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('__lonit_site');
    parsed.searchParams.delete('__lonit_limit');
    return parsed.toString();
  } catch {
    return url;
  }
}

function sameUrlWithoutLonitParams(a, b) {
  return normalizeDetailUrl(a) === normalizeDetailUrl(b);
}

function resolveUrl(baseUrl, href) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function extractAttribute(html, name) {
  const re = new RegExp(`\\b${name}=["']([^"']+)["']`, 'i');
  const match = String(html || '').match(re);
  return match ? decodeEntities(match[1]) : '';
}

function extractFirstImage(html, baseUrl) {
  const match = String(html || '').match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/i);
  return match ? resolveUrl(baseUrl, decodeEntities(match[1])) : '';
}

function extractPrice(html) {
  const match = String(html || '').match(/([0-9][0-9,\s]{2,})\s*(?:원|KRW)/i);
  return match ? Number(match[1].replace(/[^\d]/g, '')) : 0;
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

const results = [];
for (const target of TARGETS) {
  try {
    const result = await collectTarget(target);
    results.push(result);
    const status = result.ok
      ? `${result.allowed ? 'ALLOWED' : 'OK'}:${result.status}`
      : `FAIL:${result.status}:${result.missing?.join(',') || result.error || ''}`;
    console.log(`${result.label}\t${status}\tcount=${result.count}`);
  } catch (error) {
    const result = failResult(target, error?.message || String(error));
    results.push(result);
    console.log(`${result.label}\tFAIL:error\tcount=0\t${result.error}`);
  }
}

await mkdir(resolve('output'), { recursive: true });
const artifactPath = resolve('output/live-window-collection-quality.json');
const openGaps = results
  .filter((result) => !result.ok)
  .map((result) => ({
    label: result.label,
    status: result.status,
    allowed: !!result.allowed,
    missing: result.missing || [],
    error: result.error || '',
  }));
const knownUnavailable = results
  .filter((result) => result.ok && result.allowed && result.status !== 'ok')
  .map((result) => ({
    label: result.label,
    status: result.status,
    reason: result.unavailableReason || '',
    missing: result.missing || [],
  }));
const requirementComplete = openGaps.length === 0;
await writeFile(artifactPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  requirementComplete,
  openGaps,
  knownUnavailable,
  results,
}, null, 2)}\n`, 'utf8');
console.log(`artifact=${artifactPath}`);
console.log(`requirementComplete=${requirementComplete}`);
if (knownUnavailable.length > 0) {
  console.log(`knownUnavailable=${knownUnavailable.map((gap) => `${gap.label}[${gap.status}]`).join('; ')}`);
}
if (openGaps.length > 0) {
  console.log(`openGaps=${openGaps.map((gap) => `${gap.label}[${gap.status}]`).join('; ')}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.log(`failed=${failed.map((result) => `${result.label}[${result.status}]`).join('; ')}`);
  process.exitCode = 1;
}
