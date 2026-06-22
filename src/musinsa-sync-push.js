/**
 * 목적: 무신사 상품 페이지 스크랩 → /sync/push-from-extension으로 서버 push (#7b)
 *
 * 흐름:
 *  1. background.js 또는 popup에서 pushMusinsaProduct(goodsNo) 호출
 *  2. musinsa.js의 getDetail + getOptions로 스크랩 (기존 엔진 재사용)
 *  3. api.js의 apiCall로 /sync/push-from-extension에 POST
 *  4. 재시도 포함 — 네트워크 오류 시 최대 3회
 *
 * 인증: api.js의 apiCall이 X-Auth-Key 헤더를 자동으로 포함
 */

import { getDetail, getOptions } from './musinsa.js';
import { apiCall } from './api.js';

const MAX_PUSH_RETRIES = 3;
const PUSH_RETRY_DELAY = 2000;

/** 단순 딜레이 */
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 무신사 상품 한 건을 스크랩하여 서버에 push
 * @param {number|string} goodsNo - 무신사 상품 번호
 * @returns {{ ok: boolean, received?: object, error?: string }}
 */
export async function pushMusinsaProduct(goodsNo) {
  const id = Number(goodsNo);
  if (!id || isNaN(id)) {
    return { ok: false, error: `유효하지 않은 goodsNo: ${goodsNo}` };
  }

  // 1. 스크랩
  let detail, opts;
  try {
    [detail, opts] = await Promise.all([
      getDetail(id),
      getOptions(id),
    ]);
  } catch (err) {
    console.error(`[SyncPush] 무신사 스크랩 실패 ${id}:`, err.message);
    return { ok: false, error: `스크랩 실패: ${err.message}` };
  }

  if (detail?.isOfflineGoods) {
    return { ok: false, error: '오프라인 전용 상품 (push 스킵)' };
  }

  // 2. payload 조립 (musinsa.js collect() 결과 형태와 동일)
  // MAX_STOCK cap: 10 (백엔드와 동일)
  // remainQuantity: null=충분(→10) / 숫자=실재고 / outOfStock/!activated=0
  const MAX_STOCK = 10;
  const rawTotal = opts.reduce((sum, o) => {
    if (o.outOfStock || !o.activated) return sum;
    return sum + (o.remainQuantity != null ? o.remainQuantity : MAX_STOCK);
  }, 0);
  const totalStock = Math.min(rawTotal, MAX_STOCK);
  const isSoldout = rawTotal === 0;

  /** @type {object} */
  const payload = {
    sourceMarket: 'musinsa',
    sourceId: String(id),
    sourceUrl: `https://www.musinsa.com/products/${id}`,
    brand: detail.brand ?? '',
    originalTitle: detail.goodsName ?? '',
    originalPrice: detail.normalPrice ?? 0,
    sellPrice: detail.salePrice ?? 0,
    couponPrice: detail.salePrice ?? 0,        // goodsPrice.salePrice = 쿠폰 적용가
    categorySource: detail.category ?? '',
    images: detail.images ?? [],
    specs: detail.specs ?? {},
    options: opts.map(o => ({
      optionName: o.name,
      optionType: o.optionName ?? 'size',
      sku: o.managedCode ?? '',
      stock: o.outOfStock
        ? 0
        : (!o.activated
            ? 0
            : Math.min(o.remainQuantity != null ? o.remainQuantity : MAX_STOCK, MAX_STOCK)),
      isSoldout: o.outOfStock || !o.activated,
      priceDiff: o.price ?? 0,
    })),
    totalStock,
    isSoldout,
    // 혜택가 (로그인 세션 있을 때 정확)
    ...(detail.benefitPrice != null && { benefitPrice: detail.benefitPrice }),
    ...(detail.benefitDetails && { benefitDetails: detail.benefitDetails }),
    ...(detail.memberGrade && { memberGradeLevel: detail.memberGrade?.level }),
    // 혜택 세부
    ...(detail.couponDcPrice != null && { couponDcPrice: detail.couponDcPrice }),
    ...(detail.isPrePoint != null && { isPrePoint: detail.isPrePoint }),
    ...(detail.savePoint != null && { savePoint: detail.savePoint }),
    ...(detail.memberDiscountRate != null && { memberDiscountRate: detail.memberDiscountRate }),
    ...(detail.memberSavePointRate != null && { memberSavePointRate: detail.memberSavePointRate }),
    ...(detail.memberSaveMoneyRate != null && { memberSaveMoneyRate: detail.memberSaveMoneyRate }),
    ...(detail.musinsaRaw && { musinsaRaw: detail.musinsaRaw }),
    ...(detail.productNotices != null && { productNotices: detail.productNotices }),
    // 2026-04-22 PR-D followup: 출고소요일 (willReleaseDate 기반, v1.2.2).
    //   서버 push-from-extension 이 products.source_lead_days 를 즉시 UPSERT → drift cron 감지.
    ...(detail.sourceLeadDays != null && { sourceLeadDays: detail.sourceLeadDays }),
  };

  // 3. 서버 push (재시도 포함)
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      const result = await apiCall('/sync/push-from-extension', {
        method: 'POST',
        body: JSON.stringify({
          source: 'musinsa',
          goodsNo: String(id),
          payload,
        }),
      });
      console.log(`[SyncPush] push 완료 goodsNo=${id}:`, result?.received?.title ?? '');
      return { ok: true, received: result?.received };
    } catch (err) {
      if (attempt < MAX_PUSH_RETRIES) {
        console.warn(`[SyncPush] push 실패 (${attempt}/${MAX_PUSH_RETRIES}), ${PUSH_RETRY_DELAY}ms 후 재시도:`, err.message);
        await delay(PUSH_RETRY_DELAY);
      } else {
        console.error(`[SyncPush] push 최종 실패 goodsNo=${id}:`, err.message);
        return { ok: false, error: err.message };
      }
    }
  }

  return { ok: false, error: '알 수 없는 오류' };
}

/**
 * 현재 탭이 무신사 상품 페이지인지 확인하고 goodsNo 추출
 * URL 패턴: https://www.musinsa.com/products/{goodsNo}
 * @param {string} url
 * @returns {string|null} goodsNo 또는 null
 */
export function extractMusinsaGoodsNo(url) {
  try {
    const match = url.match(/musinsa\.com\/products\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
