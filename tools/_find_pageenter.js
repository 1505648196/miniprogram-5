const fs = require('fs');
const path = require('path');
const out = [];
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) {
      if (p.includes('miniprogram_npm') || p.includes('node_modules')) continue;
      walk(p);
    } else if (p.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8');
      const lines = s.split('\n');
      lines.forEach((l, i) => {
        if (/pageEnter|track\.pageEnter|\.track\(/.test(l)) {
          out.push(`${p}:${i + 1}: ${l.trim().slice(0, 80)}`);
        }
      });
    }
  }
}
walk('miniprogram');
console.log(out.join('\n'));
console.log('\nTOTAL:', out.length);
