# Gmarket Unified Collector Notes

## hostMatches

```js
[
  'gmarket.co.kr',
  'item.gmarket.co.kr',
  'minishop.gmarket.co.kr',
  'auction.co.kr',
  'itempage.auction.co.kr',
  'stores.auction.co.kr',
]
```

## URL patterns

- PDP, Gmarket: `https://www.gmarket.co.kr/item?goodsCode=...` / `https://www.gmarket.co.kr/n/item?goodsCode=...`
- PDP, Auction: `https://itempage.auction.co.kr/DetailView.aspx?itemNo=...` or `https://www.auction.co.kr/item/{id}`
- StarDelivery: URL contains `/star-delivery` or `stardelevery`
- 404 sentinel: URL contains `not_found.html` or `goodsNotFound`
- Minishop/list: host contains `minishop.gmarket.co.kr` or `stores.auction.co.kr`
- General list fallback: card HTML containing `img.image--itemcard`, `img.image__item`, or `a.itemname`

## Exact `extra()` snippet

```js
export function extra() {
  try {
    const iframe = document.querySelector('#detail1, #hIfrmExplainView');
    const body = iframe?.contentDocument?.body;
    return body ? body.innerHTML : null;
  } catch {
    return null;
  }
}
```

## Bot-block risk

- Vendor hint: `X-Px` / PerimeterX (HUMAN) 추정
- Risk: `5/10`
- 본 PoC 는 network fetch 우회가 아니라 이미 열린 브라우저 문서 `outerHTML` 기준 파싱만 가정

## 더망고 `site.js` lines 6350-6488 key findings

- Gmarket + Auction 는 하나의 collector 분기로 통합된다.
- 상세는 `outerHTML` 에 iframe 본문을 append 해서 admin 으로 전송한다.
- Auction iframe target 은 `#hIfrmExplainView`, Gmarket target 은 `#detail1` 이다.
- `not_found.html` 상세 URL 은 404 sentinel 로 즉시 send 한다.
- StarDelivery/SmileDelivery 와 미니샵 목록은 스크롤 없이 즉시 send 한다.
- 일반 목록 ready selector 는 Auction `img.image--itemcard`, Gmarket 일반 `img.image__item`, Gmarket best `a.itemname` 이다.
- load wait 는 1초 간격 최대 20회이며, Gmarket 일반 목록은 추가 대기(load_count < 6)가 붙는다.

## Iframe merge caveats

- `#detail1` / `#hIfrmExplainView` 가 cross-origin 이면 `contentDocument` 접근이 실패한다.
- 이 경우 parser 는 `extraHtml=null` 로도 동작해야 하며, 상세 HTML 병합은 graceful degrade 로 취급한다.
- 현재 PoC fixture 는 synthetic iframe body HTML 을 직접 주입해 병합 성공 케이스를 검증한다.
