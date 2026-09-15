const fs = require('fs');
const path = require('path');

// 查小程序端所有 wx.cloud.callFunction 调用了哪些云函数
const ROOT = 'miniprogram';
const calls = new Map();

function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const fp = path.join(d, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) {
      if (/miniprogram_npm|node_modules/.test(f)) continue;
      walk(fp);
    } else {
      if (!/\.js$/.test(f)) continue;
      const src = fs.readFileSync(fp, 'utf8');
      const re = /name:\s*['"`]([a-zA-Z0-9_-]+)['"`]/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        calls.set(m[1], (calls.get(m[1]) || 0) + 1);
      }
    }
  }
}
walk(ROOT);

console.log('小程序端调用的云函数及次数：');
[...calls.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([name, count]) => {
    const mark = /recruitWxAutoAI|TestRecruit/.test(name) ? ' ⚠️ AI 相关' : '';
    console.log(`  ${name.padEnd(28)} ${count} 次${mark}`);
  });
