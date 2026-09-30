/**
 * WGS84 ↔ GCJ-02 **双向**转换。纯函数，无依赖。
 *
 * 两个方向都有真实调用方，缺一不可：
 *   GPS 模块 (WGS84) ──wgs84ToGcj02──► 高德地图显示 (GCJ-02)   ← 每次定位都走
 *   高德地图 (GCJ-02) ──gcj02ToWgs84──► 导出航点给小车 (WGS84)  ← 每次导出都走
 *
 * ⚠️ 不转会得到「不报错的错」：
 *   GPS → 地图  图标恒定偏移几十~几百米，看起来像 GPS 坏了
 *   地图 → 导出 GPX/GeoJSON 整体平移，文件合法、导入不报错，但小车走的是错的路
 *
 * 标准近似算法，反向用迭代求到 ~1cm。对 CEP 2.5m 的 GPS 足够 ——
 * **反向转换的误差不该成为新的误差源**。
 */

import { selfcheck } from './selfcheck.js';

const PI = Math.PI;
const RAD = PI / 180;
const A = 6378245.0;                   // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323;     // 第一偏心率平方

/** 中国大陆粗略包围盒之外不做偏移（港澳台与境外不适用 GCJ-02） */
function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

/** 该点的 GCJ-02 偏移量【度】 */
function delta(lng, lat) {
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat * RAD;
  const magic = 1 - EE * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  // ⚠️ 分母里的 PI 是 Math.PI，不是 RAD。写成 RAD 会让偏移量放大 57 倍
  //    —— 而往返自检照样通过（错的正向函数也能被迭代反解），只能靠量级断言抓。
  return [
    (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI),
    (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI),
  ];
}

/** @param {number[]} p [lng, lat] WGS84  @returns {number[]} [lng, lat] GCJ-02 */
export function wgs84ToGcj02([lng, lat]) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const [dLng, dLat] = delta(lng, lat);
  return [lng + dLng, lat + dLat];
}

/** @param {number[]} p [lng, lat] GCJ-02  @returns {number[]} [lng, lat] WGS84 */
export function gcj02ToWgs84([lng, lat]) {
  if (outOfChina(lng, lat)) return [lng, lat];
  // 正向没有解析反函数，迭代逼近。1e-7 度 ≈ 1cm，三次内基本收敛。
  let wLng = lng;
  let wLat = lat;
  for (let i = 0; i < 10; i++) {
    const [gLng, gLat] = wgs84ToGcj02([wLng, wLat]);
    const dLng = gLng - lng;
    const dLat = gLat - lat;
    wLng -= dLng;
    wLat -= dLat;
    if (Math.abs(dLng) < 1e-7 && Math.abs(dLat) < 1e-7) break;
  }
  return [wLng, wLat];
}

/** 坐标数组批量转（路径用） */
export const mapPath = (path, fn) => path.map(fn);

// ── 自检：`node src/coord.js` ──────────────────────────────
// 用「往返一致性 + 偏移量量级」两条断言，不依赖外部真值。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  const wgs = [114.057868, 22.543099];             // 深圳，WGS84
  const gcj = wgs84ToGcj02(wgs);
  const back = gcj02ToWgs84(gcj);

  // ⚠️ 这两条断言抓的是不同的 bug，缺一不可：
  //   「量级」抓实现写错（比如分母把 PI 写成 RAD）—— 往返断言对这种情况是瞎的
  //   「往返」抓反向迭代不收敛
  // ⚠️ 只断言**量级**，不断言符号 —— 偏移的方向随经纬度变化
  //    （华南的纬度偏移是负的，华北是正的），写死符号会误报。
  for (const [name, p] of [['深圳', wgs], ['北京', [116.397428, 39.90923]]]) {
    const g = wgs84ToGcj02(p);
    const dLng = g[0] - p[0];
    const dLat = g[1] - p[1];
    assert(Math.abs(dLng) > 0.002 && Math.abs(dLng) < 0.008,
      `${name} 经度偏移量级正确（${dLng >= 0 ? '+' : ''}${dLng.toFixed(5)}°）`);
    assert(Math.abs(dLat) > 0.0005 && Math.abs(dLat) < 0.006,
      `${name} 纬度偏移量级正确（${dLat >= 0 ? '+' : ''}${dLat.toFixed(5)}°）`);
  }
  assert(Math.abs(back[0] - wgs[0]) < 1e-5 && Math.abs(back[1] - wgs[1]) < 1e-5, '往返回到原点（<1e-5° ≈ 1m）');

  const tokyo = [139.7671, 35.6812];
  assert(
    gcj02ToWgs84(wgs84ToGcj02(tokyo))[0] === tokyo[0],
    '境外坐标原样透过（不做偏移）',
  );

  // 路径批量转换：整条线不许有一个点漏转
  const path = mapPath([wgs, [114.06, 22.55], [114.07, 22.56]], wgs84ToGcj02);
  assert(path.length === 3 && path.every((p, i) => p[0] !== [wgs, [114.06, 22.55], [114.07, 22.56]][i][0]),
    'mapPath 逐点转换（不是恒等映射）');

  if (failed) throw new Error(`coord.js 自检失败 ${failed} 项`);
  console.log('coord.js 自检通过');
}

selfcheck(demo, import.meta.url);
