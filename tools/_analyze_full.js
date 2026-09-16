/**
 * TDesign 组件依赖全量扫描 + 安全删除
 * 扫描每个组件目录内【所有文件】的引用（不只主文件）：
 *  - .json  usingComponents（相对 ../xxx 与绝对 /miniprogram_npm/tdesign-miniprogram/xxx）
 *  - .js    import/require 相对路径
 *  - .wxss  @import 相对路径
 *  - .wxml  src/include 相对路径
 *  - .wxs   引用
 * 闭包算法：从页面注册组件出发，追踪所有传递依赖；其余 = 可删。
 * 嵌套的 miniprogram_npm/（tslib/dayjs/marked/tinycolor2）强制保留。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'miniprogram');
const base = path.join(root, 'miniprogram_npm', 'tdesign-miniprogram');
const MODE = process.argv[2] || 'scan'; // scan | delete

// 1. 页面/自定义组件直接注册的 TDesign 组件
const directlyUsed = new Set();
function collectDirectRefs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) collectDirectRefs(p);
    else if (f.endsWith('.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const uc = j.usingComponents || {};
        for (const k in uc) {
          const m = String(uc[k]).match(/tdesign-miniprogram\/([^/]+)\//);
          if (m) directlyUsed.add(m[1]);
        }
      } catch (e) {}
    }
  }
}
collectDirectRefs(path.join(root, 'pages'));
collectDirectRefs(path.join(root, 'components'));
collectDirectRefs(root); // app.json（如有全局注册）

// 2. 每个组件目录的依赖 = 该目录下所有文件里出现的引用
const allDirs = fs.readdirSync(base).filter((d) => {
  try { return fs.statSync(path.join(base, d)).isDirectory(); } catch (e) { return false; }
});
const dirSet = new Set(allDirs);

function extractRefsFromCode(code) {
  const deps = new Set();
  let m;
  // 相对路径 ../xxx/ 或 ../../xxx/（取最后一段组件名）
  const reRel = /(?:\.\.\/)+([a-zA-Z0-9_-]+)\//g;
  while ((m = reRel.exec(code)) !== null) deps.add(m[1]);
  // 绝对路径 tdesign-miniprogram/xxx/
  const reAbs = /tdesign-miniprogram\/([a-zA-Z0-9_-]+)\//g;
  while ((m = reAbs.exec(code)) !== null) deps.add(m[1]);
  return deps;
}

function depsOfDir(d) {
  const deps = new Set();
  const dirPath = path.join(base, d);
  (function walk(cur) {
    for (const f of fs.readdirSync(cur)) {
      const p = path.join(cur, f);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(js|json|wxss|wxml|wxs)$/.test(f)) {
        try {
          for (const dep of extractRefsFromCode(fs.readFileSync(p, 'utf8'))) deps.add(dep);
        } catch (e) {}
      }
    }
  })(dirPath);
  return deps;
}

const depMap = {};
for (const d of allDirs) depMap[d] = depsOfDir(d);

// 3. 闭包
const needed = new Set(directlyUsed);
let changed = true;
while (changed) {
  changed = false;
  for (const d of [...needed]) {
    for (const dep of depMap[d] || []) {
      if (!needed.has(dep) && dirSet.has(dep)) { needed.add(dep); changed = true; }
    }
  }
}

// 4. 可删 = 全部 - 需要 - 强制保留
const keep = new Set([...needed, 'miniprogram_npm']);
const deletable = allDirs.filter((d) => !keep.has(d)).sort();

function dirSize(d) {
  let t = 0;
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) t += dirSize(p);
    else t += s.size;
  }
  return t;
}

console.log('=== 页面注册（去死注册后）：' + directlyUsed.size + ' 个 ===');
console.log([...directlyUsed].sort().join(' '));
console.log('');
console.log('=== 闭包保留（含传递依赖）：' + needed.size + ' 个 ===');
console.log([...needed].sort().join(' '));
console.log('');
let total = 0;
console.log('=== 可删（' + deletable.length + ' 个）===');
for (const d of deletable) {
  const s = dirSize(path.join(base, d));
  total += s;
  console.log((s / 1024).toFixed(1) + 'KB  ' + d);
}
console.log('');
console.log('可删合计: ' + (total / 1024).toFixed(1) + 'KB  →  删后 miniprogram_npm ≈ ' +
  ((dirSize(base) - total) / 1024).toFixed(0) + 'KB');

if (MODE === 'delete') {
  let n = 0;
  for (const d of deletable) {
    fs.rmSync(path.join(base, d), { recursive: true, force: true });
    n++;
  }
  console.log('');
  console.log('已删除 ' + n + ' 个组件目录。');
}
