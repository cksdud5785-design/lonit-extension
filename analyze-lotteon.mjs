import { readFileSync } from 'fs';
const content = readFileSync('ref-lotteon.js', 'utf8');

// Extract all URL-like strings
const urlRegex = /https?:\/\/[^\s'"\\]+/g;
const urls = [...new Set(content.match(urlRegex) || [])];
console.log('URLs found:');
urls.slice(0, 30).forEach(u => console.log(' ', u));

// Find lotteon-related strings
const keywords = ['lotteon', 'product', 'mallId', 'srchPagination', 'search', 'prd', 'itemId', 'priceList', 'option'];
for (const kw of keywords) {
  const idx = content.indexOf(kw);
  if (idx >= 0) {
    console.log(`\nKeyword "${kw}" at ${idx}:`);
    console.log('  Context:', content.substring(Math.max(0, idx-20), idx+100));
  }
}

// Extract string literals (they're obfuscated but some plain strings remain)
const strings = content.match(/'[^']{5,100}'/g) || [];
console.log('\nString literals:');
for (const s of strings.slice(0, 50)) {
  if (s.includes('lotteon') || s.includes('http') || s.includes('search') || s.includes('product') || s.includes('mall')) {
    console.log(' ', s);
  }
}
