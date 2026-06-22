const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'ko-KR' });
  for (const url of process.argv.slice(2)) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      console.log(`${url}\t${response && response.status()}\t${page.url()}\t${(await page.title()).slice(0, 80)}`);
      console.log(text.slice(0, 200).replace(/\s+/g, ' '));
    } catch (error) {
      console.log(`${url}\tERR\t${error.message}`);
    }
  }
  await browser.close();
})();
