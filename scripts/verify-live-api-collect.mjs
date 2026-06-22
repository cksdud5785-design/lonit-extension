import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TARGETS = [
  {
    label: 'GrandStage.a-rt.com',
    module: '../src/grandstage.js',
    url: 'https://grandstage.a-rt.com/display/search-word/result?searchWord=nike',
  },
  {
    label: 'ABCMart.a-rt.com FOLDER keyword',
    module: '../src/abcmart.js',
    url: 'https://abcmart.a-rt.com/display/search-word/result?searchWord=FOLDER',
  },
  {
    label: 'GSShop.com',
    module: '../src/gsshop.js',
    url: 'https://m.gsshop.com/search/searchSect.gs?tq=%EB%82%98%EC%9D%B4%ED%82%A4',
  },
  {
    label: 'lotteimall.com search',
    module: '../src/lotteimall.js',
    url: 'https://www.lotteimall.com/search/searchMain.lotte?headerQuery=nike',
  },
  {
    label: 'lotteimall.com PDP',
    module: '../src/lotteimall.js',
    url: 'https://www.lotteimall.com/goods/viewGoodsDetail.lotte?goods_no=12901016',
  },
  {
    label: 'FashionPlus.co.kr',
    module: '../src/fashionplus.js',
    url: 'https://www.fashionplus.co.kr/search/goods/result?searchWord=nike',
  },
  {
    label: 'Worksout.co.kr',
    module: '../src/worksout.js',
    url: 'https://www.worksout.co.kr/products/187258',
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
  const mod = await import(new URL(target.module, import.meta.url));
  const batches = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${target.label} timeout`)), target.timeoutMs || 45_000);

  try {
    const progress = () => {};
    const result = await mod.collect(target.url, target.limit || 1, progress, {
      signal: controller.signal,
      onBatch: async (batch) => {
        if (Array.isArray(batch)) batches.push(...batch);
      },
    });
    const products = (Array.isArray(result) && result.length > 0) ? result : batches;
    const product = products[0] || null;
    const validation = validateProduct(product);
    return {
      label: target.label,
      url: target.url,
      ok: validation.missing.length === 0,
      count: products.length,
      missing: validation.missing,
      checks: validation.checks,
      sample: summarizeProduct(product),
    };
  } catch (error) {
    return {
      label: target.label,
      url: target.url,
      ok: false,
      count: 0,
      missing: REQUIRED_CHECKS,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
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

const results = [];
for (const target of TARGETS) {
  const result = await collectTarget(target);
  results.push(result);
  const status = result.ok ? 'OK' : `FAIL:${result.missing.join(',')}`;
  console.log(`${result.label}\t${status}\tcount=${result.count}`);
}

await mkdir(resolve('output'), { recursive: true });
const artifactPath = resolve('output/live-api-collection-quality.json');
const openGaps = results
  .filter((result) => !result.ok)
  .map((result) => ({
    label: result.label,
    status: result.error ? 'error' : 'quality_fail',
    missing: result.missing || [],
    error: result.error || '',
  }));
const requirementComplete = openGaps.length === 0;
await writeFile(artifactPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  requirementComplete,
  openGaps,
  results,
}, null, 2)}\n`, 'utf8');

const failed = results.filter((result) => !result.ok);
console.log(`artifact=${artifactPath}`);
console.log(`requirementComplete=${requirementComplete}`);
if (openGaps.length > 0) {
  console.log(`openGaps=${openGaps.map((gap) => `${gap.label}[${gap.status}]`).join('; ')}`);
}
if (failed.length > 0) {
  console.log(`failed=${failed.map((result) => `${result.label}[${result.missing.join(',')}]`).join('; ')}`);
  process.exitCode = 1;
}
