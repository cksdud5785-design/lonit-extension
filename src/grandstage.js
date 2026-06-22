// GrandStage collector wrapper.
//
// GrandStage is served by the same a-rt.com product/search APIs as ABC-MART,
// but it uses channel 10002 and should be reported as its own sourceMarket.

import { collect as collectAbcmart, cleanupAbcmartTab } from './abcmart.js';

const GRANDSTAGE_BASE = 'https://grandstage.a-rt.com';
const ABCMART_BASE = 'https://abcmart.a-rt.com';

function normalizeGrandstageInput(input) {
  const value = String(input || '').trim();
  if (!value) return `${GRANDSTAGE_BASE}/display/search-word/result?searchWord=`;

  try {
    const url = new URL(value);
    if (url.hostname.includes('abcmart.a-rt.com')) {
      url.hostname = 'grandstage.a-rt.com';
    }
    return url.toString();
  } catch {
    return `${GRANDSTAGE_BASE}/display/search-word/result?searchWord=${encodeURIComponent(value)}`;
  }
}

function toGrandstageProduct(product) {
  if (!product || typeof product !== 'object') return product;
  const sourceUrl = String(product.sourceUrl || '').replace(ABCMART_BASE, GRANDSTAGE_BASE);
  return {
    ...product,
    sourceMarket: 'grandstage',
    sourceUrl,
    storeName: 'GrandStage',
    productNotices: product.productNotices
      ? {
          ...product.productNotices,
          importer: product.productNotices.importer || 'ABC-MART Korea',
          asContact: product.productNotices.asContact || 'ABC-MART customer center',
        }
      : product.productNotices,
  };
}

export async function collect(url, limit = 10000, onProgress = () => {}, options = {}) {
  const normalizedUrl = normalizeGrandstageInput(url);
  const wrappedOptions = {
    ...options,
    ...(options?.onBatch
      ? { onBatch: async (batch) => options.onBatch(batch.map(toGrandstageProduct)) }
      : {}),
  };
  const products = await collectAbcmart(normalizedUrl, limit, onProgress, wrappedOptions);
  return Array.isArray(products) ? products.map(toGrandstageProduct) : [];
}

export function cleanupGrandstageTab() {
  cleanupAbcmartTab();
}

export const __internals = {
  normalizeGrandstageInput,
  toGrandstageProduct,
};
