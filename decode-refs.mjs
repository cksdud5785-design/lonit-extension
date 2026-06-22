import { readFileSync, writeFileSync } from 'fs';

// Decode ref-ssg.js
try {
  const content = readFileSync('ref-ssg.js', 'utf8');
  const idx = content.indexOf('var _jqpdkizs="');
  if (idx >= 0) {
    const start = idx + 'var _jqpdkizs="'.length;
    // Find where the base64 ends - it contains + concatenation
    // The whole thing is var x = "base64part1" + "base64part2" ...
    // Let's extract all the base64 parts and combine
    let code = content.substring(idx);
    // Extract all quoted strings after the variable name
    const parts = [];
    let i = code.indexOf('"') + 1;
    while (i < code.length) {
      const end = code.indexOf('"', i);
      if (end < 0) break;
      // Check if escaped
      if (code[end-1] !== '\\') {
        parts.push(code.substring(i, end));
        // Find next start
        const nextPlus = code.indexOf('+', end);
        const nextQuote = code.indexOf('"', end + 1);
        if (nextPlus < 0 || nextQuote < 0 || nextPlus > nextQuote + 5) break;
        i = nextQuote + 1;
      } else {
        i = end + 1;
      }
    }
    const b64 = parts.join('');
    console.log('SSG b64 total length:', b64.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    writeFileSync('ref-ssg-decoded.js', decoded);
    console.log('Written ref-ssg-decoded.js, length:', decoded.length);
  }
} catch(e) { console.error('SSG error:', e.message); }

// Decode ref-lotteon.js
try {
  const content = readFileSync('ref-lotteon.js', 'utf8');
  const varNames = ['_jqpdkizs', '_lotteon', '_content'];
  // Try to find the variable
  let idx = -1;
  let varPrefix = '';
  for (const name of [...content.matchAll(/var (\w+)="/g)].map(m => m[1])) {
    const tryIdx = content.indexOf(`var ${name}="`);
    if (tryIdx >= 0) { idx = tryIdx; varPrefix = `var ${name}="`; break; }
  }
  if (idx >= 0) {
    let code = content.substring(idx);
    const parts = [];
    let i = code.indexOf('"') + 1;
    while (i < code.length) {
      const end = code.indexOf('"', i);
      if (end < 0) break;
      if (code[end-1] !== '\\') {
        parts.push(code.substring(i, end));
        const nextPlus = code.indexOf('+', end);
        const nextQuote = code.indexOf('"', end + 1);
        if (nextPlus < 0 || nextQuote < 0 || nextPlus > nextQuote + 5) break;
        i = nextQuote + 1;
      } else {
        i = end + 1;
      }
    }
    const b64 = parts.join('');
    console.log('LotteOn b64 total length:', b64.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    writeFileSync('ref-lotteon-decoded.js', decoded);
    console.log('Written ref-lotteon-decoded.js, length:', decoded.length);
  } else {
    console.log('LotteOn: no var found');
    // Try direct base64 decode of the first quoted string
    const firstQuote = content.indexOf('"');
    const lines = content.split('\n').slice(0, 5);
    console.log('First lines:', lines);
  }
} catch(e) { console.error('LotteOn error:', e.message); }
