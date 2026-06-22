/**
 * 목적: Background-side site parser registry — window-collector.js 의 result.html 을
 *      siteName 으로 라우팅해 sites-parsers/<site>.js 의 parse 함수 호출.
 *
 * background.js 에서 사용:
 *   import { SITE_PARSERS } from './site-parsers/index.js';
 *   const products = await SITE_PARSERS[siteName].parse(html, url, extraHtml);
 *
 * Phase 0: worksout stub.
 * PoC (Task P.4): worksout 실 구현.
 * Phase 1: adidas / nike / folderstyle / gmarket 추가 (Codex 위임).
 */

import { parse as worksoutParse } from './worksout.js';
import { parse as gmarketParse } from './gmarket.js';
import { parse as adidasParse } from './adidas.js';
import { parse as nikeParse } from './nike.js';

/**
 * @typedef {Object} SiteParser
 * @property {(html: string, url: string, extraHtml: string|null) => Promise<Array>} parse
 */

/** @type {Record<string, SiteParser>} */
export const SITE_PARSERS = {
  worksout: { parse: worksoutParse },
  gmarket: { parse: gmarketParse },
  adidas: { parse: adidasParse },
  nike: { parse: nikeParse },
};
