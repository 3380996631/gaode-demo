/**
 * UI 层自检：`node selftest.js`
 *
 * ⚠️ **为什么这一层单独一个文件**：`coord/geo/gps/imu/fuse/export` 都是纯函数，
 *    自检写在文件末尾、`node src/x.js` 就能跑。`ui.js` 不行 —— 它整个就是 DOM。
 *    所以这里给一个最小 DOM 桩，把**真正会出错的那部分逻辑**跑起来：
 *      · 整个模块图能不能 import（import 名字写错在这里响）
 *      · ui.js 选中的 id 在 index.html 里存不存在
 *      · 序号是不是按 index 重算、首尾行有没有删除按钮
 *      · activeRowIndex 有没有跟着增删走（plan 点名的「两份状态指同一事物」那处）
 *
 * 抓不到的：任何要真 AMap / 真浏览器的行为 —— 那些只能按 plan 第十一章在真机上过。
 */
import fs from 'node:fs';
import { CONFIG, missingConfig } from './config.js';

let failed = 0;
const assert = (ok, msg) => {
  if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
};

// ── 最小 DOM 桩 ────────────────────────────────────────

const ids = new Set([...fs.readFileSync('index.html', 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const els = new Map();
const badSelectors = [];

function makeEl(sel) {
  return {
    sel, dataset: {}, style: {}, hidden: false, textContent: '', innerHTML: '', value: '', className: '',
    classList: { add() {}, remove() {} },
    addEventListener() {},
    closest: () => null,
  };
}

globalThis.document = {
  querySelector(sel) {
    const m = /^#([\w-]+)$/.exec(sel);
    if (!m || !ids.has(m[1])) badSelectors.push(sel);
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => makeEl('a'),
};
globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const html = (sel) => els.get(sel)?.innerHTML ?? '';

// ── ① 模块图 ───────────────────────────────────────────

const ui = await import('./src/ui.js');
await import('./src/main.js');                       // 顺带验证 main 的整个依赖树
await new Promise((r) => setTimeout(r, 20));          // 等 boot() 跑完

assert(badSelectors.length === 0,
  badSelectors.length ? `ui.js 选中了 index.html 里不存在的：${badSelectors.join(', ')}` : '模块图 import 通过，选中的 id 全都在');
// 启动失败必须是一条带码的提示，不是白屏。
// node 里没有 AMapLoader，boot() 会走到 amap.js 的 C00001 —— 正好验证「加载失败也响」。
assert(els.get('#status').textContent.includes('C00001'),
  'JSAPI 加载失败 → 状态栏出 C00001，页面照常渲染（不是白屏）');

// ⚠️ `securityJsCode` 留空**不是缺配** —— 老 Key 本来就不需要安全密钥。
//    在这里判它缺失，会把「本来能跑的老 Key」判成 B00100，**报一个不存在的错**。
const savedKey = CONFIG.key;
CONFIG.key = '';
assert(missingConfig().join() === 'key', '缺 Key → 只报 key 这一项');
CONFIG.key = savedKey;
assert(missingConfig().length === 0, 'Key 已填 + securityJsCode 留空 → 不算缺配，boot 继续往下走');

// ── ② 序号与删除按钮 ───────────────────────────────────

ui.initUI({});
assert(ui.getPlaces().length === 2, '默认就是起点 + 终点两行，没有「两点模式」这条路径');

ui.addWaypointAt(1);                                  // 插在起点与终点之间
assert(ui.getPlaces().length === 3, '加途经点 = 数组变长');
assert(/<span class="seq">1<\/span>[\s\S]*<span class="seq">2<\/span>[\s\S]*<span class="seq">3<\/span>/.test(html('#places')),
  '序号按 index 重算（1 2 3，不是 1 3 2）');
assert((html('#places').match(/data-act="del"/g) ?? []).length === 1, '只有中间行有删除按钮');
assert(html('#places').includes('途经点') && html('#places').includes('终点'), '中间行叫途经点，末行仍叫终点');

// 首尾不可删：places 必须恒 ≥ 2
ui.removePlaceAt(0);
ui.removePlaceAt(2);
assert(ui.getPlaces().length === 3, '起点/终点行删不掉');

// ── ③ activeRowIndex 跟着增删走 ────────────────────────
// 不管就会出鬼：删掉第 2 行后，原本的第 3 行变成新第 2 行，而 active 还指着旧的 ——
// 点地图的地址就会填进错误的行，**不报错**。

ui.setActive(2);
ui.removePlaceAt(1);
assert(ui.getActive() === 1, '删掉前面的行 → active 减 1（地址不会填错行）');

ui.addWaypointAt(1);                                  // 补到 4 行，才删得掉「中间那行」
ui.addWaypointAt(1);
ui.setActive(2);
ui.removePlaceAt(2);
assert(ui.getActive() === null, '删掉 active 自己 → active 清空（而不是指向别人）');

ui.setActive(0);
ui.addWaypointAt(1);
assert(ui.getActive() === 0, '在 active 之后插入 → active 不动');

ui.setActive(1);
ui.addWaypointAt(1);
assert(ui.getActive() === 2, '在 active 之前插入 → active 跟着后移');

// ── ④ 按钮上的预估请求数 ───────────────────────────────
// 按钮文案与 A00105 的上限必须是**同一个数**，否则拦截线和用户看到的不一致

const n = ui.getPlaces().length;
assert(els.get('#plan').textContent.includes(`(${n - 1})`),
  `规划按钮显示段数 = 点数 - 1（${n} 点 → ${n - 1} 段，实得「${els.get('#plan').textContent}」）`);
assert(els.get('#compare').textContent.includes(`(${(n - 1) * CONFIG.compareAxes.length})`),
  `对比按钮显示 段数 × 列数（实得「${els.get('#compare').textContent}」）`);

// ── ⑤ 渲染归一结构 ─────────────────────────────────────

ui.renderPlan({
  mode: 'driving', totalDistance: 7300, totalTime: 960,
  plans: [{ index: 0, distance: 7300, time: 960, segments: [{
    title: '第 1 段：A → B', distance: 7300, time: 960, path: [],
    steps: [{ instruction: '沿福中三路行驶300米右转', distance: 300 }],
  }] }],
});
assert(html('#summary').includes('7.3 公里') && html('#summary').includes('16 分钟'), '概要显示距离与耗时');
assert(html('#steps').includes('沿福中三路行驶300米右转'), '逐段说明被渲染（与导出读同一份 steps）');

// 对比：一格失败不能塌掉整张表
ui.renderComparison({
  entries: [
    { label: '骑行', mode: 'riding', result: { totalDistance: 5100, totalTime: 1920, plans: [] } },
    { label: '驾车·躲避拥堵', mode: 'driving', error: new Error('boom') },
    { label: '驾车·最快捷', mode: 'driving', result: { totalDistance: 7300, totalTime: 1080, plans: [] } },
  ],
  bestTimeIndex: 2, bestDistanceIndex: 0,
});
const table = html('#compare-table');
assert(table.includes('无结果') && table.includes('骑行') && table.includes('驾车·最快捷'),
  '一格失败 → 那格显示「无结果」，其余照常（allSettled，整表不塌）');
assert((table.match(/★/g) ?? []).length === 2, '耗时最优与距离最优各打一个★，打在不同的列上');
assert(table.includes('disabled'), '无结果那列的「画它」被禁用');

// ── ⑦ 策略名必须是 REST 真名（跨文件一致性） ────────────
// ⚠️ 高德对**无效** strategy 既不报错也不提示，静默回落到默认策略（实测 strategy=4 / 999
//    都返回 status=1 OK）。所以「配置里写错一个策略名」的现象是：对比表两列永远渲染成
//    同一条，**零报错**。这条错只能靠我们自己在发请求前拦。
//    这里验的是**真实的那两份文件**（config.js 的 compareAxes、index.html 的下拉选项），
//    不是造出来的样例 —— 单测 amaprest.js 自己的表是查不出「调用方写错了」的。

const amaprest = await import('./src/amaprest.js');

const badAxes = CONFIG.compareAxes.filter((a) => {
  try { amaprest.strategyOf(a.mode, a.policy); return false; } catch { return true; }
});
assert(badAxes.length === 0,
  badAxes.length
    ? `compareAxes 里有 REST 认不出的策略名（会当场抛 B02100）：${badAxes.map((a) => `${a.mode}/${a.policy}`).join('、')}`
    : 'compareAxes 的策略名都是 REST v5 真名');

// 骑行 v4 **没有 strategy 参数**，那一列写了 policy 就是个不起作用的字段 ——
// 留着比删掉更糟：下一个人会以为骑行也能选策略。
assert(CONFIG.compareAxes.every((a) => a.mode !== 'riding' || a.policy == null),
  '骑行列不带 policy（v4 只认 key/origin/destination）');

const policyValues = [...fs.readFileSync('index.html', 'utf8')
  .matchAll(/<select id="policy">([\s\S]*?)<\/select>/g)]
  .flatMap((m) => [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]));
const badOpts = policyValues.filter((v) => {
  try { amaprest.strategyOf('driving', v); return false; } catch { return true; }
});
assert(policyValues.length > 0 && badOpts.length === 0,
  badOpts.length
    ? `index.html 的 #policy 里有 REST 认不出的值：${badOpts.join('、')}（用户一选就抛 B02100）`
    : `#policy 下拉的 ${policyValues.length} 个值都是 REST v5 真名`);

if (failed) throw new Error(`selftest.js 失败 ${failed} 项`);
console.log('selftest.js 通过');
