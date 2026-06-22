/**
 * 목적: 더망고-style invisible window content script — window-collector.js 가
 *      chrome.scripting.executeScript({files:['src/site-parsers/runner.js']}) 로 주입.
 *
 * 중요: chrome.scripting.executeScript({files:[...]}) 는 **classic script** 로 inject.
 *      ES module 미지원 → `export` 키워드 사용 시 SyntaxError → inject fail → timeout.
 *      따라서 본 파일은 IIFE 패턴 + 모든 함수 internal 로. 외부 노출은 globalThis.__LONIT_RUNNER__
 *      에 read-only namespace 로 (test 환경 검증용).
 *
 * 책임:
 *   1. window.__LONIT_SITE_NAME__ 에서 siteName 읽기 (선행 주입된 inline func)
 *   2. SITES[siteName].ready() 를 1초 간격 polling (max TIMEOUT_MS)
 *   3. ready 되면 document.documentElement.outerHTML 캡처
 *   4. captcha / cf-challenge 감지 시 status: 'bot_block'
 *   5. SITES[siteName].extra() 가 추가 HTML 반환하면 함께 보냄 (Gmarket iframe 등)
 *   6. chrome.runtime.sendMessage({ type: 'WINDOW_COLLECTOR_RESULT', payload }) 발사
 *
 * 자동 실행:
 *   - chrome.runtime 환경에선 IIFE 끝에서 main() 자동 실행
 *   - test 환경 (Node) 에선 globalThis.chrome 없으므로 skip — test 가 명시 호출
 */

(function lonitRunner() {
  const TIMEOUT_MS = 28_000;     // background timeout (30s) 보다 2s 짧게 — race 방지
  const POLL_INTERVAL_MS = 1000;

  // 2026-05-18 hotfix #9: ready() 에 PLP fallback 추가 (PDP-only selector → PLP 영원 timeout 회피).
  // plpItems() 신규 — PLP 페이지의 product card href 추출 → background parse 가 shallow product[] 변환.
  const SITES = {
    // Worksout: Next.js SPA. PDP = dehydratedState.queries[0]. PLP = /products/ link 5+ 개.
    worksout: {
      ready: () => {
        const el = document.getElementById('__NEXT_DATA__');
        if (el?.textContent) {
          try {
            const data = JSON.parse(el.textContent);
            if (data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data) return true;
          } catch {}
        }
        // PLP fallback
        return document.querySelectorAll('a[href*="/products/"]').length >= 5;
      },
      extra: () => null,
      plpItems: (limit) => extractLinks('a[href*="/products/"]', /\/products\/(\d+)/, limit),
    },
    // Adidas: Next.js. PDP = /api/products/. PLP = .html link 5+ 개 (model code).
    adidas: {
      ready: () => {
        const el = document.getElementById('__NEXT_DATA__');
        if (el?.textContent) {
          try {
            const data = JSON.parse(el.textContent);
            const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
            if (queries.some((q) => Array.isArray(q?.queryKey) && q.queryKey[0]?.includes?.('/api/products/'))) return true;
          } catch {}
        }
        // PLP fallback — adidas card href: /{slug}/{6글자모델}.html
        return document.querySelectorAll('a[href$=".html"]').length >= 5;
      },
      extra: () => null,
      plpItems: (limit) => extractLinks('a[href$=".html"]', /\/([A-Z0-9]{6})\.html/, limit),
    },
    // Nike: PDP = JSON-LD ProductGroup. PLP = /kr/t/ link 5+ 개.
    nike: {
      ready: () => {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
          try {
            const parsed = JSON.parse(s.textContent || '');
            const candidates = Array.isArray(parsed) ? parsed : [parsed];
            if (candidates.some((c) => c?.['@type'] === 'ProductGroup' && Array.isArray(c.hasVariant) && c.hasVariant.length > 0)) {
              return true;
            }
          } catch {}
        }
        // PLP fallback
        return document.querySelectorAll('a[href*="/kr/t/"]').length >= 5;
      },
      extra: () => null,
      plpItems: (limit) => extractLinks('a[href*="/kr/t/"]', /\/kr\/t\/[^/]+\/([A-Z0-9]+-\d+)/, limit),
    },
    // Gmarket + Auction: 더망고 site.js:6350-6488 패턴.
    gmarket: {
      ready: () => {
        const url = location.href;
        if (/not_found\.html|goodsNotFound/.test(url)) return true;
        if (/\/star-delivery|stardelevery|smile-delivery/.test(url)) return true;
        if (/minishop\.gmarket\.co\.kr|stores\.auction\.co\.kr/.test(url)) return true;
        if (document.querySelector('#detail1, #hIfrmExplainView, .price_real, .item_no')) return true;
        if (document.querySelector('img.image--itemcard, img.image__item, a.itemname')) return true;
        return false;
      },
      extra: () => {
        try {
          const iframe = document.querySelector('#detail1, #hIfrmExplainView');
          const body = iframe?.contentDocument?.body;
          return body ? body.innerHTML : null;
        } catch {
          return null;
        }
      },
    },
  };

  /**
   * PLP product card link 추출 — selector 로 a[href] 모은 후 idPattern 으로 sourceId 추출.
   * 각 card 에서 title + image + price text 도 추출 (closest container 의 img.alt, .src,
   * 가격 정규식 매칭). dedup by URL + 추출 결과를 background parser 가 product[] 변환.
   *
   * @param {string} selector — a[href] selector
   * @param {RegExp} idPattern — URL 에서 sourceId 추출 정규식 (matched group [1])
   * @param {number} [limit=100] — 결과 상한
   */
  function extractLinks(selector, idPattern, limit) {
    const anchors = document.querySelectorAll(selector);
    const map = new Map();
    const max = (typeof limit === 'number' && limit > 0) ? limit : 100;
    for (const a of anchors) {
      if (map.size >= max) break;
      const rawHref = a.getAttribute('href') || '';
      const url = rawHref.startsWith('http') ? rawHref : new URL(rawHref, location.href).href;
      const idMatch = url.match(idPattern);
      if (!idMatch) continue;
      const sourceId = idMatch[1];
      if (map.has(url)) continue;
      // title: img.alt 우선 (정확), fallback a.textContent
      const img = a.querySelector('img');
      const title = (img?.getAttribute('alt') || a.textContent || '').trim().slice(0, 200);
      // image: img.src 또는 closest container 의 img
      const image = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      // price: card 의 text 에서 가격 정규식 매칭 (₩, 원, KRW)
      const card = a.closest('article, li, div[class*="card"], div[class*="product"]') || a;
      const priceMatch = (card.textContent || '').match(/[\d,]+\s*원|₩\s*[\d,]+|KRW\s*[\d,]+/);
      const price = priceMatch ? Number(priceMatch[0].replace(/[^\d]/g, '')) : 0;
      map.set(url, { url, sourceId, title, image, price });
    }
    return Array.from(map.values());
  }

  function detectBotBlock(html) {
    return (
      /id=["']captcha["']/i.test(html) ||
      /class=["'][^"']*cf-challenge[^"']*["']/i.test(html) ||
      /denied access|access denied|blocked by/i.test(html)
    );
  }

  function send(payload) {
    console.log('[Lonit runner] send 시도 — status:', payload?.status, 'siteName:', payload?.siteName);
    try {
      // MV3 sendMessage: callback + Promise 둘 다 지원. lastError 노출 위해 callback 형태 사용.
      chrome.runtime.sendMessage({ type: 'WINDOW_COLLECTOR_RESULT', payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Lonit runner] sendMessage lastError:', chrome.runtime.lastError.message);
        } else {
          console.log('[Lonit runner] sendMessage 성공 — response:', response);
        }
      });
      console.log('[Lonit runner] sendMessage 호출 완료 (callback pending)');
    } catch (e) {
      console.error('[Lonit runner] sendMessage sync 실패:', e?.message);
    }
  }

  /** URL query param '__lonit_site' 추출. window-collector.js 가 chrome.windows.create 시 URL 에 append. */
  function siteNameFromUrl() {
    try {
      return new URL(location.href).searchParams.get('__lonit_site') || '';
    } catch {
      return '';
    }
  }

  /** URL query param '__lonit_limit' 추출. PLP fallback 시 product card 상한 적용. */
  function limitFromUrl() {
    try {
      const n = Number(new URL(location.href).searchParams.get('__lonit_limit') || '0');
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  async function main(opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || TIMEOUT_MS;
    // URL query 우선, fallback window.__LONIT_SITE_NAME__ (test 환경 호환)
    const siteName = siteNameFromUrl() || (typeof window !== 'undefined' ? window.__LONIT_SITE_NAME__ : undefined);
    const url = typeof window !== 'undefined' ? window.location.href : '';

    // URL guard — siteName 없으면 일반 브라우징, noop (manifest 가 4 사이트 host 에 모두 inject)
    if (!siteName) return;

    const site = SITES[siteName];

    console.log('[Lonit runner] main 시작 — siteName:', siteName, 'url:', url, 'hasSite:', !!site);

    if (!site) {
      console.warn('[Lonit runner] SITES 에 siteName 없음:', siteName, 'available:', Object.keys(SITES));
      send({ status: 'no_parser', html: '', extraHtml: null, url: url, siteName: siteName });
      return;
    }

    const start = Date.now();
    let readyAt = 0;
    while (Date.now() - start < timeoutMs) {
      try {
        if (await site.ready()) {
          readyAt = Date.now() - start;
          console.log('[Lonit runner] ready signal detected at', readyAt, 'ms');
          break;
        }
      } catch (e) {
        // ready 함수 자체 오류 — continue polling
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (readyAt === 0) {
      console.warn('[Lonit runner] ready timeout — outerHTML 강제 캡처 진행');
    }

    const html = typeof document !== 'undefined' ? document.documentElement.outerHTML : '';
    console.log('[Lonit runner] outerHTML captured — length:', html.length);

    if (detectBotBlock(html)) {
      console.warn('[Lonit runner] bot_block detected');
      send({ status: 'bot_block', html: html, extraHtml: null, url: url, siteName: siteName });
      return;
    }

    let extraHtml = null;
    try {
      extraHtml = site.extra ? site.extra() : null;
    } catch (e) {
      // extra 실패는 graceful
    }

    // PLP fallback — site.plpItems(limit) 가 product card 추출. PDP 일 때도 호출.
    // limit 은 URL query __lonit_limit 에서 (window-collector 가 collectLimit 으로 append).
    let plpItems = null;
    try {
      const limit = limitFromUrl();
      plpItems = site.plpItems ? site.plpItems(limit) : null;
    } catch (e) {
      // graceful
    }

    console.log('[Lonit runner] sending status:ok — html.length:', html.length, 'extraHtml:', extraHtml ? extraHtml.length : 'null', 'plpItems:', plpItems ? plpItems.length : 'null');
    send({ status: 'ok', html: html, extraHtml: extraHtml, plpItems: plpItems, url: url, siteName: siteName });
  }

  // chrome.runtime 환경 (실 확장 inject) — 자동 실행
  // Node test 환경 (globalThis.chrome 없음) — globalThis 에만 expose, test 가 명시 호출
  if (typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.sendMessage) {
    main();
  } else if (typeof globalThis !== 'undefined') {
    // test 환경 — namespace expose
    globalThis.__LONIT_RUNNER__ = { SITES: SITES, detectBotBlock: detectBotBlock, main: main };
  }
})();
