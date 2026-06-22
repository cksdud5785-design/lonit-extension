import {
  parseDetail,
  getOptions,
  getLeadDays,
  toProductPayload,
} from '../oliveyoung.js';

const SOURCE_MARKET = 'oliveyoung';
const GOODS_NO_RE = /A[0-9]{12}/i;

export async function parse(html, url, _extraHtml, plpItems) {
  const goodsNo = extractGoodsNo(url) || extractGoodsNo(html);
  if (goodsNo) {
    const data = parseDetail(goodsNo, html);
    if (!data) return [buildShallowDetailCandidate(goodsNo, html, url)];
    const options = getOptions(data);
    const leadInfo = getLeadDays(data);
    const product = toProductPayload({ goodsNo }, data, options, leadInfo);
    return product ? [product] : [];
  }
  return parsePlp(plpItems);
}

function parsePlp(plpItems) {
  if (!Array.isArray(plpItems)) return [];
  return plpItems.map((item) => ({
    sourceMarket: SOURCE_MARKET,
    sourceId: String(item.sourceId || ''),
    productId: String(item.sourceId || ''),
    sourceUrl: item.url || '',
    originalTitle: item.title || '',
    brand: '',
    originalPrice: Number(item.price) || 0,
    sellPrice: Number(item.price) || 0,
    images: item.image ? [item.image] : [],
    options: [],
    categorySource: '',
    isSoldout: false,
    isShallow: true,
  }));
}

function extractGoodsNo(value) {
  const match = String(value || '').match(GOODS_NO_RE);
  return match ? match[0].toUpperCase() : '';
}

function buildShallowDetailCandidate(goodsNo, html, url) {
  const detailUrl = extractRedirectDetailUrl(html, url)
    || `https://m.oliveyoung.co.kr/goods/${encodeURIComponent(goodsNo)}`;
  return {
    sourceMarket: SOURCE_MARKET,
    sourceId: goodsNo,
    productId: goodsNo,
    sourceUrl: detailUrl,
    originalTitle: '',
    brand: '',
    originalPrice: 0,
    sellPrice: 0,
    images: [],
    options: [],
    categorySource: '',
    isSoldout: false,
    isShallow: true,
  };
}

function extractRedirectDetailUrl(html, baseUrl) {
  const match = String(html || '').match(/goods\/getGoodsDetail\.do\?goodsNo=([A-Z][0-9]{12})/i);
  if (!match) return '';
  try {
    return `https://m.oliveyoung.co.kr/goods/${encodeURIComponent(match[1].toUpperCase())}`;
  } catch {
    return `${baseUrl || 'https://m.oliveyoung.co.kr/m/G.do'}?goodsNo=${match[1].toUpperCase()}`;
  }
}
