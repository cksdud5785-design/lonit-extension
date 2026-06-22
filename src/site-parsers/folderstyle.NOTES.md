# FOLDERStyle Parser Notes

- `hostMatches`: `['folderstyle.com']`
- PDP URL pattern used: `/shop/goodsView/{id}`
- PDP price selector from recon: `span.price[ge-data-original-price]`
- List card selector from 더망고/live JS recon: `li.fb__items__list`
- Data extraction method: regex-only parsing with `JSON.parse` not required; service-worker safe, no `DOMParser`
- Option structure emitted: `{ name, stock, externalOptionId }[]`
- Image extraction: prefer `.js__productImg__slider img`, fallback `og:image`
- Price mapping: `price`/`salePrice` = displayed discounted price, `originalPrice` = `ge-data-original-price` or `.info__price__cost`
- Recon gotcha: live homepage currently `307 -> /serviceEndInfo`, and `/serviceEndInfo` is a shutdown notice. Live PDP HTML could not be fetched on 2026-05-17.
- Fixture note: `__fixtures__/folderstyle/pdp.html` is synthetic, but based on live recon artifacts that were still reachable on 2026-05-17:
  - live shell HTML from `/serviceEndInfo`
  - live JS bundle strings confirming `/shop/goodsView/{id}`, `fb__goodsView`, `js__productImg__slider`, `li.fb__items__list`, `info__brand`, `info__name`, `info__price__discount`, `info__price__cost`
- Known limitation: multi-select products are flattened per visible `<option>` entries; variant combination expansion is not attempted in this PoC.
