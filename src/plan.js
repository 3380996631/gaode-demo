/**
 * 业务编排：地点 → 路线 → 聚合结果 → 偏航判定 → 导航会话。
 *
 * **不碰 DOM，不出现任何 AMap 对象。** 取数走 `amaprest.js`（REST），
 * 地图渲染走 `amap.js`（JSAPI）—— 而本文件**根本不认识后者**。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR, report } from './errors.js';
import { distMeters, projectPointToSegment } from './geo.js';
import * as amaprest from './amaprest.js';

/**
 * @typedef {Object} Place
 * @property {string} text        用户输入的地名（拖拽后变成坐标文本）
 * @property {number[]|null} lnglat  [lng, lat] GCJ-02；有值时跳过地理编码
 *
 * @typedef {Object} Segment
 * @property {string}   title      '第 1 段：深圳北站 → 市民中心'
 * @property {number}   distance   【米】
 * @property {number}   time       【秒】
 * @property {number[][]} path     [[lng, lat], …] **GCJ-02**（导出时才转 WGS84）
 * @property {Step[]}   steps
 *
 * @typedef {Object} Step
 * @property {string} instruction  '沿福中三路行驶565米右转'
 * @property {number} distance     【米】
 *
 * Fix（定位点，**fuse.js 的出口**）的字段定义在 `fuse.js`。这里只用到一个约定：
 * `usable` —— 质量门限，由 `fuse.js` 贴（源自 `gps.js` 的 `isFixUsable`）。
 * **不达标的点仍然显示，但不参与偏航判定** —— 定位差的时候它说你偏航了，多半是它自己在飘。
 *
 * @typedef {Object} RouteResult
 * @property {'riding'|'driving'} mode
 * @property {number} totalDistance 【米】—— 原始数值，不是 '15.2 公里'
 * @property {number} totalTime     【秒】
 * @property {import('./errors.js').ERR[keyof typeof ERR]} [warning] 非致命告警（如 C02100）
 * @property {Plan[]} plans
 *
 * @typedef {Object} Plan
 * @property {number} index
 * @property {number} distance 【米】
 * @property {number} time     【秒】
 * @property {Segment[]} segments
 */

// ── 校验（先于任何请求，一处定义） ─────────────────────

/**
 * 校验并返回预估请求数。任一道不过就抛，**一个请求都不发**。
 * @returns {number} 预估请求数（按钮文案与 A00105 用的是同一个数）
 */
export function validatePlaces(places, mode, axes = CONFIG.compareAxes) {
  if (!places || places.length < 2) throw new AppError(ERR.TOO_FEW_PLACES, {});
  places.forEach((p, i) => {
    if (!p.text?.trim() && !p.lnglat) throw new AppError(ERR.EMPTY_PLACE, { index: i + 1 });
  });
  if (mode !== 'riding' && mode !== 'driving') throw new AppError(ERR.MODE_NOT_SUPPORTED, { mode });
  // 策略名打错要**在请求发出去之前**响 —— 高德对无效 strategy 既不报错也不提示，
  // 静默回落默认策略（实测 strategy=4 / 999 都返回 status=1 OK），见 amaprest.strategyOf。
  axes.forEach((a) => { if (a.mode) amaprest.strategyOf(a.mode, a.policy); });
  const n = estimateRequests(places, axes);
  if (n > CONFIG.nav.requestLimit) {
    throw new AppError(ERR.REQUEST_LIMIT, { n, max: CONFIG.nav.requestLimit });
  }
  return n;
}

/** 纯函数：要发几次请求。**规划与对比共用**。 */
export function estimateRequests(places, axes = CONFIG.compareAxes) {
  return Math.max(0, places.length - 1) * axes.length;
}

// ── 规划 ──────────────────────────────────────────────

/**
 * 文字地名 → 坐标。已有坐标的跳过（GPS / 地图点选过的）。
 *
 * ⚠️ **串行，不并发** —— 原来是 `Promise.all(places.map(...))`，一次扇出 N 个地理编码。
 *    高德按**账号**限 QPS，并发几个就可能撞上 `10021 CUQPS_HAS_EXCEEDED_THE_LIMIT`，
 *    而它是**部分失败**（官方原文：「限流阈值内的请求依旧会正常返回」）——
 *    表现为「有的地点解析出来了、有的莫名其妙报错」，是最难查的那类故障。
 *
 *    地理编码是**一次性**成本（回填后不再发，见 main.js 的 `resolve()`），
 *    串行慢不了多少，但把这一整类故障消掉了。而且串行 = 顺序确定 = 报错时报的是
 *    **第一个**坏地名，而不是「哪个先回来算哪个」。
 *
 * ponytail: 不做退避重试 —— 扇出没了，这个码就不该再出现；真出现就该看见它（C00102），
 *           而不是被重试盖住。哪天确有需要再加。
 */
export async function resolvePlaces(places) {
  const out = [];
  for (const p of places) {
    // 统一走坐标形式，不回填关键字：若把 GPS 的坐标塞回地名让高德二次地理编码，
    // 起点会偏移到「地址对应的点」而非「小车实际所在的位置」。
    out.push(p.lnglat ? p : { ...p, lnglat: await amaprest.geocode(p.text) });
  }
  return out;
}

const label = (p, i) =>
  p.text?.trim() || (p.lnglat ? `${p.lnglat[0].toFixed(4)},${p.lnglat[1].toFixed(4)}` : `第 ${i + 1} 点`);

/**
 * 选路与聚合：循环 `planSegment` 再汇总。**不构造任何 AMap 对象。**
 *
 * 逐段串联而不是用 v5 驾车自带的 `waypoints` —— 只有驾车有那个参数，用了 `planRoute`
 * 就要分两条路径，高复用直接破功；而且省下的配额很小（规划是一次性成本）。详见 plan 第六章。
 *
 * @param {string} policy **策略名**（`config.compareAxes` 里写的那种），本函数内部解码成数字
 */
export async function planRoute(places, mode, policy) {
  // ⚠️ **解码放在循环之前**：名字写错当场抛 B02100，一个请求都不发。
  //    放到循环里则会「先发一段、再报错」，前一段白烧。
  const strategy = amaprest.strategyOf(mode, policy);
  const segments = [];
  for (let i = 0; i < places.length - 1; i++) {
    try {
      const seg = await amaprest.planSegment(places[i], places[i + 1], mode, strategy);
      seg.title = `第 ${i + 1} 段：${label(places[i], i)} → ${label(places[i + 1], i + 1)}`;
      segments.push(seg);
    } catch (e) {
      // 中间某段失败不放弃整条路线：已算出的段照样画。只有第一段就失败才真的没东西可画。
      if (!segments.length) throw e;
      report(new AppError(ERR.ROUTE_PARTIAL, { index: i + 1 }, e));
      return { ...amaprest.mergeSegments(segments, mode), warning: ERR.ROUTE_PARTIAL };
    }
  }
  return amaprest.mergeSegments(segments, mode);
}

// ── 对比 ──────────────────────────────────────────────

/**
 * 按对比轴扇出多次 `planRoute`。**用 `allSettled`，一格塌不了整张表。**
 * @returns {Promise<import('./errors.js').AppError|Comparison>} 全失败才抛
 */
export async function compareRoutes(places, axes = CONFIG.compareAxes) {
  const settled = await Promise.allSettled(
    axes.map((axis) => planRoute(places, axis.mode, axis.policy)),
  );
  const entries = axes.map((axis, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') return { ...axis, result: r.value };
    report(r.reason);
    return { ...axis, error: r.reason };
  });
  if (entries.every((e) => !e.result)) throw entries[0].error;
  return { entries, ...pickBest(entries) };
}

/** 「哪条最好」是业务判断 —— 写进 ui.js 等于让视图层定义什么叫「好」。 */
export function pickBest(entries) {
  const ok = entries.map((e, i) => [e, i]).filter(([e]) => e.result);
  if (!ok.length) return {};
  const by = (get) => ok.reduce((a, b) => (get(b[0]) < get(a[0]) ? b : a))[1];
  return {
    bestTimeIndex: by((e) => e.result.totalTime),
    bestDistanceIndex: by((e) => e.result.totalDistance),
  };
}

// ── 路线投影：一次计算，三个出口 ────────────────────────

// 路线折线扁平化与累计里程只跟路线有关，跟定位点无关 —— 缓存住，别每个定位点重算一遍。
// （10km 路线能有几千个点，5Hz × 每点两次投影，不缓存会白烧 CPU。）
const _geomCache = new WeakMap();

function routeGeometry(route) {
  let g = _geomCache.get(route);
  if (!g) {
    const path = route.plans.flatMap((pl) => pl.segments.flatMap((s) => s.path));
    const cum = new Array(path.length).fill(0);
    for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + distMeters(path[i - 1], path[i]);
    g = { path, cum, total: cum[cum.length - 1] ?? 0 };
    _geomCache.set(route, g);
  }
  return g;
}

/**
 * 点到折线投影。**一次计算三个出口**：
 *   `distance` 偏航判定 / `snapped` 小车图标位置 / `progress` 导航进度
 * 三者同源，所以屏幕上不可能出现「图标在线左边、进度却说走过了」这类矛盾。
 *
 * @returns {{distance:number, snapped:number[], progress:number, ratio:number, total:number}|null}
 */
export function projectOntoRoute(fix, route) {
  const { path, cum, total } = routeGeometry(route);
  if (!path.length) return null;
  const p = fix.lnglat ?? fix;

  let best = null;
  for (let i = 0; i < path.length - 1; i++) {
    const r = projectPointToSegment(p, path[i], path[i + 1]);
    if (!best || r.dist < best.distance) {
      best = { distance: r.dist, snapped: r.point, progress: cum[i] + (cum[i + 1] - cum[i]) * r.t };
    }
  }
  if (!best) {                                  // 路径只有一个点
    return { distance: distMeters(p, path[0]), snapped: path[0], progress: 0, ratio: 0, total: 0 };
  }
  best.total = total;
  best.ratio = total ? best.progress / total : 0;
  return best;
}

// ── 偏航判定：三层去抖 ─────────────────────────────────

/**
 * 去抖状态机。三层缺一不可：
 *   ① 阈值 > 定位精度   ② 连续 N 点确认   ③ 重算冷却
 * 外加兜底：单次导航重算上限。
 *
 * ⚠️ 不去抖的话 GPS 噪声本身就是一台请求生成器 —— 阈值小于漂移时，车停着不动
 * 也能每秒触发一次重算（3600 次/小时），而且**不报任何错**。
 */
export function createDeviationChecker() {
  let streak = [];
  let lastRerouteAt = 0;
  let count = 0;

  return {
    /** @param proj projectOntoRoute 的结果（外面已经算过，避免重复计算） */
    check(fix, proj, isStatic = false) {
      const { deviationThreshold: thr, deviationStreak: need, rerouteCooldownMs: cd, rerouteLimit } = CONFIG.nav;

      // 静止 → 位置冻结，不参与判定。这是第 1 层去抖之外的第二道保险。
      if (isStatic) { streak = []; return { action: 'static', proj }; }

      if (!proj || proj.distance < thr) { streak = []; return { action: 'none', proj }; }

      streak.push(fix);
      if (streak.length < need) return { action: 'pending', streak: streak.length, proj };

      if (Date.now() - lastRerouteAt < cd) return { action: 'cooldown', proj };

      if (count >= rerouteLimit) {
        return { action: 'limit', error: new AppError(ERR.REROUTE_LIMIT, { n: count }), proj };
      }

      // ⚠️ 重算起点**不用投影点** —— 投影点落在旧路线上，而我们正是因为离开了旧路线才要重算。
      //    也不用单个原始点 —— 辅路离主路可能只有 8 米，会吸附到对向车道。
      //    用这 N 个已经通过「确认是真偏航」筛选的点取均值，缓冲区是现成的，零额外成本。
      const origin = meanLngLat(streak);
      streak = [];
      lastRerouteAt = Date.now();
      count++;
      return {
        action: 'reroute',
        origin,
        count,
        proj,
        error: new AppError(ERR.OFF_ROUTE, { distance: Math.round(proj.distance) }),
      };
    },
    reset() { streak = []; lastRerouteAt = 0; count = 0; },
    get count() { return count; },
  };
}

const meanLngLat = (fixes) => [
  fixes.reduce((s, f) => s + f.lnglat[0], 0) / fixes.length,
  fixes.reduce((s, f) => s + f.lnglat[1], 0) / fixes.length,
];

/** 到终点判定。**不用「最后一个航点」判** —— 轨迹点是否恰好落在终点上是运气。 */
export function checkArrival(fix, dest, radius = CONFIG.nav.arriveRadius) {
  return distMeters(fix.lnglat ?? fix, dest.lnglat ?? dest) < radius;
}

// ── 导航会话 ──────────────────────────────────────────

/**
 * 导航的生命周期：起手规划 → 跟随 → (刷新 | 重算) → 到达。
 * **拥有全部定时器**，ui.js 只渲染它推上来的东西。
 *
 * @param {Object} o
 * @param {Place[]} o.places
 * @param {'riding'|'driving'} o.mode
 * @param {number|string} [o.policy]
 * @param {(patch:object)=>void} o.onUpdate  状态推送：{kind:'start'|'move'|'refresh'|'reroute'|'offroute'|'arrived'|'dr'|'error', …}
 * @param {(route:RouteResult)=>void} o.onRoute  路线变了（重绘用）
 */
export function createNavSession({ places, mode, policy, onUpdate, onRoute }) {
  let route = null;
  let timer = null;
  let stopped = false;
  let arrived = false;
  let rerouteCount = 0;
  const dev = createDeviationChecker();

  const emit = (patch) => { if (!stopped) onUpdate?.(patch); };

  function swap(next, kind) {
    route = next;
    onRoute?.(route);
    emit({ kind, route });
  }

  async function reroute(origin) {
    try {
      const next = await planRoute([{ text: '', lnglat: origin }, places[places.length - 1]], mode, policy);
      swap(next, 'reroute');
    } catch (e) {
      report(e);
      emit({ kind: 'error', error: e });
    }
  }

  // 周期性刷新：**只有驾车且策略看路况才做**。骑行没有实时路况，刷新只会得到
  // 一条一模一样的路线，纯烧配额。
  //
  // ⚠️ 「看路况」认的是 **REST 的 strategy 数字**（含「躲避拥堵」语义的 32/33/39~45），
  //    不是 JSAPI 的常量名 —— `isTrafficAware` 收数字，所以这里必须过一次 `strategyOf`。
  function scheduleRefresh() {
    if (stopped) return;
    if (mode !== 'driving' || !CONFIG.nav.drivingRefreshMs) return;
    if (!amaprest.isTrafficAware(amaprest.strategyOf(mode, policy))) return;
    // ⚠️ 自调度，不用 setInterval —— 上一次结束了才计下一次，慢刷新不会叠加请求
    timer = setTimeout(async () => {
      try {
        swap(await planRoute(places, mode, policy), 'refresh');
      } catch (e) {
        // ⚠️ 刷新失败**不清空当前路线** —— 已经算出来的东西不该因为一次失败就丢掉
        const err = new AppError(ERR.REFRESH_FAILED, {}, e);
        report(err);
        emit({ kind: 'error', error: err });
      } finally {
        scheduleRefresh();
      }
    }, CONFIG.nav.drivingRefreshMs);
  }

  return {
    get route() { return route; },
    get rerouteCount() { return rerouteCount; },

    async start() {
      swap(await planRoute(places, mode, policy), 'start');
      scheduleRefresh();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      dev.reset();
    },

    /**
     * 每个新定位点调一次。
     * @param {Object} fix
     * @param {{isStatic?:boolean}} [o]
     */
    async push(fix, { isStatic = false } = {}) {
      if (stopped || !fix) return;
      // ⚠️ 推算期间（source:'dr'）**不判偏航** —— 拿一个正在漂的推算位置说「我偏航了」，
      //    会把推算误差和真偏航混为一谈。等 GPS 回来再判。
      if (fix.source === 'dr') { emit({ kind: 'dr', fix }); return; }
      if (!route) { emit({ kind: 'move', fix, proj: null }); return; }

      const proj = projectOntoRoute(fix, route);
      emit({ kind: 'move', fix, proj });

      if (!arrived && checkArrival(fix, places[places.length - 1])) {
        arrived = true;
        clearTimeout(timer);
        timer = null;
        emit({ kind: 'arrived', fix });
        return;
      }

      // 静止与「定位质量不达标」对偏航判定是同一件事：**这个点说了不算**。
      // 状态栏那边照常显示它，只是不拿它去判偏航、不拿它去烧配额。
      const r = dev.check(fix, proj, isStatic || fix.usable === false);
      if (r.action === 'reroute') {
        rerouteCount = r.count;
        emit({ kind: 'offroute', error: r.error, proj: r.proj, origin: r.origin });
        // 刷新与重算共用同一个冷却：两者都改「当前路线」，同时发生会互相覆盖
        clearTimeout(timer);
        timer = null;
        await reroute(r.origin);
        scheduleRefresh();
      } else if (r.action === 'limit') {
        emit({ kind: 'error', error: r.error });
      }
    },
  };
}
