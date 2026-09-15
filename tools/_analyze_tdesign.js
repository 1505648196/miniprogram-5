const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'miniprogram');
const comps = new Set();

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (f.endsWith('.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const uc = j.usingComponents || {};
        for (const k in uc) {
          const v = uc[k];
          const m = v.match(/tdesign-miniprogram\/([^/]+)\//);
          if (m) comps.add(m[1]);
        }
      } catch (e) {}
    }
  }
}
walk(path.join(root, 'pages'));
walk(path.join(root, 'components'));

const base = path.join(root, 'miniprogram_npm', 'tdesign-miniprogram');
const all = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
const unused = all.filter((d) => !comps.has(d));

// 组件内部依赖：解析组件 json 的 usingComponents（含相对路径 ../xxx）
// 把相对路径解析成组件目录名
const deps = new Set();
for (const d of all) {
  const jp = path.join(base, d, d + '.json');
  if (fs.existsSync(jp)) {
    try {
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      const uc = j.usingComponents || {};
      for (const k in uc) {
        let v = uc[k];
        // 相对路径 ../common/index → common
        if (v && v.startsWith('../')) {
          const seg = v.replace(/^\.\.\//, '').split('/')[0];
          deps.add(seg);
        }
        // 绝对 /tdesign-miniprogram/xxx → xxx
        const m = String(v).match(/tdesign-miniprogram\/([^/]+)\//);
        if (m) deps.add(m[1]);
      }
    } catch (e) {}
  }
}

// 必须保留的基础组件（即使没被直接引用，也被相对路径依赖）
const safeDelete = unused.filter((d) => !deps.has(d));
console.log('被其他组件内部依赖的目录：');
console.log([...deps].sort().join(' '));
console.log('');
console.log('可安全删除共 ' + safeDelete.length + ' 个：');
console.log(safeDelete.join(' '));

let total = 0;
function size(d) {
  let t = 0;
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) t += size(p);
    else t += s.size;
  }
  return t;
}
for (const d of safeDelete) total += size(path.join(base, d));
console.log('');
console.log('可删除总大小: ' + (total / 1024).toFixed(1) + 'KB');
