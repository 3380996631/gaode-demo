/**
 * 平面几何基元：距离与点到线段投影。纯函数，无依赖。
 *
 * ⚠️ 只管**几何**，不管坐标系。坐标转换在 `coord.js`，业务判定在 `plan.js`。
 *
 * 为什么单独一个文件而不是塞进 `plan.js`：有**两个层**要它 ——
 * `fuse.js`（野值剔除要算位移）与 `plan.js`（到终点判定 + 路线投影）。
 * `fuse.js` 在服务层，**不能反向依赖业务层**，所以基元必须落在更底下。
 *
 * 所有计算用等距圆柱近似（局部平面）。在几十公里的尺度内误差 <0.1%，
 * 而我们的判定阈值是「米」级 —— 足够。
 */

import { selfcheck } from './selfcheck.js';

const R = 6371008.8;      // 地球平均半径【米】
const RAD = Math.PI / 180;

/** 两点距离【米】 */
export function distMeters(a, b) {
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return R * Math.hypot((b[0] - a[0]) * RAD * Math.cos(lat), (b[1] - a[1]) * RAD);
}

/** 以 origin 为原点，把 p 投到局部平面【米】。x 向东，y 向北。 */
function toLocal(p, origin) {
  return [
    (p[0] - origin[0]) * RAD * Math.cos(origin[1] * RAD) * R,
    (p[1] - origin[1]) * RAD * R,
  ];
}

/** 局部平面坐标【米】转回经纬度 */
function fromLocal([x, y], origin) {
  return [
    origin[0] + x / (R * RAD * Math.cos(origin[1] * RAD)),
    origin[1] + y / (R * RAD),
  ];
}

/**
 * 把 p 投影到线段 a→b 上。
 * @returns {{point:number[], t:number, dist:number}}
 *   point 投影点 [lng,lat]；t 在线段上的比例（已夹到 [0,1]）；dist 垂距【米】
 */
export function projectPointToSegment(p, a, b) {
  const A = [0, 0];                    // a 是原点
  const B = toLocal(b, a);
  const P = toLocal(p, a);
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((P[0]) * dx + (P[1]) * dy) / len2, 0, 1);
  const q = [t * dx, t * dy];
  return { point: fromLocal(q, a), t, dist: Math.hypot(P[0] - q[0], P[1] - q[1]) };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ── 自检：`node src/geo.js` ────────────────────────────────
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };
  const near = (a, b, tol) => Math.abs(a - b) < tol;

  // 深圳：纬度 22.54 处，0.001° 经度 ≈ 102.6m，0.001° 纬度 ≈ 111.2m
  const a = [114.0, 22.5];
  const b = [114.001, 22.5];

  assert(near(distMeters(a, b), 102.6, 1), `东西向 0.001° ≈ 102.6m（实测 ${distMeters(a, b).toFixed(1)}）`);
  assert(near(distMeters(a, [114.0, 22.501]), 111.2, 1), '南北向 0.001° ≈ 111.2m');
  assert(distMeters(a, a) === 0, '同一点距离为 0');

  // 垂足落在线段中点
  const r = projectPointToSegment([114.0005, 22.501], a, b);
  assert(near(r.t, 0.5, 0.01), `垂足在线段中点（t=${r.t.toFixed(3)}）`);
  assert(near(r.dist, 111.2, 1), `垂距 ≈ 111.2m（实测 ${r.dist.toFixed(1)}）`);
  assert(near(r.point[1], 22.5, 1e-6), '投影点落在线上（纬度回到 22.5）');

  // 线段外 → 夹到端点
  const far = projectPointToSegment([113.9, 22.5], a, b);
  assert(far.t === 0 && near(far.point[0], a[0], 1e-9), '起点之外投影夹到 a 端');
  const far2 = projectPointToSegment([114.01, 22.5], a, b);
  assert(far2.t === 1 && near(far2.point[0], b[0], 1e-9), '终点之外投影夹到 b 端');

  // 退化线段（a === b）不许除零
  const deg = projectPointToSegment([114.001, 22.5], a, a);
  assert(Number.isFinite(deg.dist) && near(deg.dist, 102.6, 1), '退化线段不除零');

  if (failed) throw new Error(`geo.js 自检失败 ${failed} 项`);
  console.log('geo.js 自检通过');
}

selfcheck(demo, import.meta.url);
