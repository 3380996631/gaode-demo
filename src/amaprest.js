/**
 * 高德 **Web服务 REST** 封装 —— **全应用唯一发 HTTP 的地方**。
 *
 * 与 `amap.js` 的分工：那边操作 `AMapLoader` 挂上来的全局对象（只管渲染），
 * 这边是 `fetch` + JSON。**本文件不认识 `AMap` 这个全局**，`amap.js` 也一个服务请求都不发。
 *
 * 为什么不用 JSAPI 的 `AMap.Driving` / `AMap.Riding` / `AMap.Geocoder`：
 * 手里的 Key 是「**Web服务**」平台，调这三个**一律**返回 `USERKEY_PLAT_NOMATCH`。
 * 而同一个 Key 调 REST 的五个接口全部成功。2026-09-30 实测，见 plan 的 Context 修订。
 *
 * 不碰 DOM，返回原始数值/纯对象，**不做格式化**。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR } from './errors.js';
import { selfcheck } from './selfcheck.js';

const BASE = 'https://restapi.amap.com';
// 车上网络会飘。**不做超时 = 一个请求吊死，界面永远转圈且不报错**。
const TIMEOUT_MS = 10000;

// ── 请求 ──────────────────────────────────────────────

/**
 * 三种信封 → `{ok, code, info}`。
 *
 * ⚠️ **三个接口不共用一套信封**：
 *      v3/v5   `{status:'1'|'0', info, infocode}`  —— `status` 是**字符串**
 *      v4 骑行  `{errcode:0|10001, errmsg}`        —— `errcode` 是**数字**，且**没有 status 字段**
 *    但 `infocode` 与 `errcode` 是**同一套编号**（无效 Key 时两者都返回 `10001`），
 *    所以压平之后，错误分类只需按数字做一次，三个接口共用。
 */
export function envelope(json) {
  const v3 = json.status != null;
  return {
    ok: v3 ? json.status === '1' : json.errcode === 0,
    code: Number(v3 ? json.infocode : json.errcode),
    info: (v3 ? json.info : json.errmsg) ?? '',
  };
}

/**
 * 发一次高德 REST 请求。成功返回**原始 JSON**，失败抛 `AppError`。
 *
 * ⚠️ **高德的「业务失败」是 HTTP 200 + body 里的错误码**，不是 4xx/5xx。
 *    所以 `res.ok` 只挡网络层，业务层靠 `envelope()` 判 —— 两者都要查。
 *
 * @param {string} path   例 '/v3/geocode/geo'
 * @param {object} params 业务参数（key 自动带上）
 * @param {object} def    兜底错误码：**表外的码一律不猜**，按调用方给的 def 透出
 */
async function request(path, params, def) {
  const q = new URLSearchParams({ key: CONFIG.key, ...params });
  let res;
  try {
    res = await fetch(`${BASE}${path}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new AppError(ERR.NETWORK_FAILED, {
      info: e?.name === 'TimeoutError' ? `超时 ${TIMEOUT_MS}ms` : String(e?.message ?? e),
    }, e);
  }
  if (!res.ok) throw new AppError(ERR.NETWORK_FAILED, { info: `HTTP ${res.status}` });

  let json;
  try { json = await res.json(); } catch { throw new AppError(ERR.NETWORK_FAILED, { info: '响应不是 JSON' }); }

  const { ok, code, info } = envelope(json);
  if (ok) return json;
  throw new AppError(classify(code) ?? def, { info, code });
}

/**
 * 按**数字码**分类。只列官方 `info 状态表` 里写死的码，**表外的一律返回 `null`**。
 *
 * ⚠️ 猜错分类比不分类更糟：会把「我们的 bug」报成「高德在抽风」，然后让人去等它自己好。
 */
const CONFIG_FAULT = new Set([            // → B00102：我们这边配错了，等它自己好是白等
  10001,  // INVALID_USER_KEY         Key 不正确或过期
  10002,  // SERVICE_NOT_AVAILABLE    没有权限用该服务，或接口路径拼错
  10005,  // INVALID_USER_IP          IP 白名单
  10006,  // INVALID_USER_DOMAIN      绑定域名无效
  10007,  // INVALID_USER_SIGNATURE   数字签名未通过
  10008,  // INVALID_USER_SCODE       MD5 安全码未通过
  10009,  // USERKEY_PLAT_NOMATCH     ★ key 与绑定平台不符（本次踩的就是它）
  10010,  // IP_QUERY_OVER_LIMIT      官方原文「封停后**无法自动恢复**」
  10012,  // INSUFFICIENT_PRIVILEGES  权限不足
  10013,  // USER_KEY_RECYCLED        Key 被删除
  10041,  // NO_EFFECTIVE_INTERFACE   接口权限过期
  40000,  // QUOTA_PLAN_RUN_OUT       余额耗尽
  40002,  // SERVICE_EXPIRED          购买服务到期
]);
const OUR_BUG = new Set([                 // → B00103：请求由本程序构造，是代码缺陷
  20000,  // INVALID_PARAMS           参数值非法
  20001,  // MISSING_REQUIRED_PARAMS  缺必填参数
  20002,  // ILLEGAL_REQUEST          请求方式非法
]);
const QUOTA = new Set([                   // → C00102：配额/限流/高德忙，**会自愈**
  10003,  // DAILY_QUERY_OVER_LIMIT   官方：次日 0:00 自动解封
  10004,  // ACCESS_TOO_FREQUENT      官方：下一分钟自动解封
  10014, 10015, 10016, 10019, 10020,
  10021,  // CUQPS_HAS_EXCEEDED_THE_LIMIT  账号某服务 QPS 超限（★ 见 plan 第七章的并发扇出）
  10029, 10044, 10045,
]);
const NO_ROUTE = new Set([                // → A02001：高德**说清了原因**，别把它当「高德挂了」
  20800,  // OUT_OF_SERVICE           起点/终点不在中国大陆
  20801,  // NO_ROADS_IN_CITY         该区域附近没有可通行道路
  20802,  // OUT_OF_SERVICE           起点不在服务区
  20803,  // TOO_FAR                   起终点距离过远
]);

/**
 * 码 → 错误码定义。**`3xxxx` 故意不归类** ——
 * 官方对整族的说明是「建议先检查传入参数是否正确」，但实测：**查一个不存在的地址也返回 `30001`**，
 * 也就是「用户打错一个字」和「我们传了坏坐标」返回同一个码。分不清就不能替调用方做判断，
 * 所以它落回调用方的 `def`，由**唯一知道语境的那一层**翻译（见 `geocode`）。
 */
export function classify(code) {
  return CONFIG_FAULT.has(code) ? ERR.AMAP_CREDENTIAL
    : OUR_BUG.has(code) ? ERR.AMAP_REQUEST_INVALID
      : QUOTA.has(code) ? ERR.AMAP_QUOTA
        : NO_ROUTE.has(code) ? ERR.ROUTE_NO_RESULT
          : null;
}

// ── 地理编码 / 逆地理编码 ──────────────────────────────

/**
 * `[lng,lat]` → `'lng,lat'`。**三个接口的起终点格式只此一处**。
 * 文档要求 ≤6 位小数（实测 7 位也收，但不赌它）。
 */
export const coordToParam = ([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`;

/**
 * 地址 → `[lng,lat]`。查不到抛 `A01001`。
 *
 * ⚠️ **查不到的地址不是「空结果」，是 `status=0 + 30001`**（实测）。
 *    走到这条路已经过 `validatePlaces`，`text` 保证非空 —— 所以到这个码上只剩一种解释：
 *    这个名字高德不认识。必须在这里翻译，否则用户把地名打错一个字，屏幕上会显示
 *    「高德服务响应失败 ENGINE_RESPONSE_DATA_ERROR」——**告诉他一件他没法处理的事**。
 */
export async function geocode(text, city = CONFIG.gps.city) {
  let json;
  try {
    json = await request('/v3/geocode/geo', { address: text, city }, ERR.GEO_REQUEST_FAILED);
  } catch (e) {
    if (e.detail?.code >= 30000 && e.detail.code < 40000) {
      throw new AppError(ERR.GEO_NOT_FOUND, { text }, e);
    }
    throw e;
  }
  const loc = json.geocodes?.[0]?.location;
  if (!loc) throw new AppError(ERR.GEO_NOT_FOUND, { text });      // 真的空结果也要拦
  return loc.split(',').map(Number);                             // '116.39,39.90' → [116.39, 39.90]
}

/**
 * 坐标 → 地址。**失败返回 `null`，不抛** —— 回填地址是锦上添花，不该阻断选点。
 *
 * ⚠️ 实测：坐标在**境外**时 `status=1 OK`，但 `formatted_address` 是 **`[]` 空数组**。
 *    地理编码文档把这条写成通则：「返回值存在时以**字符串**返回，不存在时以**数组**返回」
 *    —— **所有字段都这样**，不只这一个。不做类型判断就会把 `'[]'` 当地址填进输入框。
 */
export async function reverseGeocode(lnglat) {
  try {
    const json = await request('/v3/geocode/regeo', { location: coordToParam(lnglat) }, ERR.GEO_REQUEST_FAILED);
    const addr = json.regeocode?.formatted_address;
    return typeof addr === 'string' && addr ? addr : null;
  } catch {
    return null;
  }
}

// ── 策略 ──────────────────────────────────────────────

/**
 * 策略表：**名 ↔ 数字，各 mode 一张**。
 *
 * ⚠️ 这套数字与 `AMap.DrivingPolicy` **毫无关系**，别混：
 *      JSAPI  `REAL_TRAFFIC`   = 4  →  v5 REST「躲避拥堵」= **33**
 *      JSAPI  `LEAST_TIME`     = 0  →  v5 REST「速度优先」= 0    （这个碰巧一样）
 *      JSAPI  `LEAST_DISTANCE` = 2  →  v5 REST 的 2 是「**常规最快**」，
 *                                      v5 **没有任何一个策略叫「最短距离」**
 *    把 JSAPI 常量原样搬过来 = 静默失效（见 `strategyOf`）。
 *
 * 给全 17 项而不是给一半：这是一张**数据表**，不是逻辑。给一半的话 `config.js` 就表达不出
 * 高德支持什么，用户还得回翻文档 —— 与「自解释」冲突。而且半张表**反而制造静默失败**：
 * 表里没有的名字会被抛出来（安全），但用户会以为「高德不支持」，实际是他拼错了。
 */
const STRATEGY = {
  driving: {                                        // /v5/direction/driving
    LEAST_TIME: 0,                                  // 速度优先（不一定距离最短）
    LEAST_FEE: 1,                                   // 费用优先，不走收费路段
    FASTEST: 2,                                     // 常规最快，综合距离/耗时
    RECOMMENDED: 32,                                // 默认，同高德地图 APP
    AVOID_CONGESTION: 33,                           // 躲避拥堵
    HIGHWAY_FIRST: 34,                              // 高速优先
    NO_HIGHWAY: 35,                                 // 不走高速
    LESS_FEE: 36,                                   // 少收费
    MAIN_ROAD_FIRST: 37,                            // 大路优先
    FASTEST_ONLY: 38,                               // 速度最快
    AVOID_CONGESTION_HIGHWAY: 39,                   // 躲避拥堵＋高速优先
    AVOID_CONGESTION_NO_HIGHWAY: 40,                // 躲避拥堵＋不走高速
    AVOID_CONGESTION_LESS_FEE: 41,                  // 躲避拥堵＋少收费
    LESS_FEE_NO_HIGHWAY: 42,                        // 少收费＋不走高速
    AVOID_CONGESTION_LESS_FEE_NO_HIGHWAY: 43,       // 躲避拥堵＋少收费＋不走高速
    AVOID_CONGESTION_MAIN_ROAD: 44,                 // 躲避拥堵＋大路优先
    AVOID_CONGESTION_FASTEST: 45,                   // 躲避拥堵＋速度最快
  },
  riding: {},   // ⚠️ v4 骑行**没有 strategy 参数** —— 表空着，传名字给它直接抛 B02100
};

/**
 * 策略名 → 数字。`null`/空 返回 `null`（= 不发该参数）。
 *
 * ⚠️ **校验必须在这里，不能指望高德报错** —— 实测：
 *      `strategy=4`   （JSAPI 的 REAL_TRAFFIC，v5 未定义）→ `status=1 OK`，结果**与默认策略完全相同**
 *      `strategy=999` （明确越界）                        → `status=1 OK`
 *    v5 对无效 strategy **既不报错也不提示，静默回落到默认**。于是配置里写错一个策略名，
 *    得到的是「一条看起来完全正常、但不是你要的」路线，零报错 ——
 *    对比表里「驾车·躲避拥堵」和「驾车·最快捷」两列会**永远渲染成同一条**。
 */
export function strategyOf(mode, name) {
  if (name == null || name === '') return null;
  const n = STRATEGY[mode]?.[name];
  if (n == null) throw new AppError(ERR.ROUTE_POLICY_UNKNOWN, { policy: name, mode });
  return n;
}

/** 该策略是否「看路况」。周期性刷新的**唯一**开关 —— 见 plan 第七章。 */
const TRAFFIC_AWARE = new Set([32, 33, 39, 40, 41, 43, 44, 45]);   // 含「躲避拥堵」语义的全部
export const isTrafficAware = (n) => TRAFFIC_AWARE.has(n);

// ── 规划 ──────────────────────────────────────────────

/**
 * `'116.48,39.99;116.48,39.99'` → `[[lng,lat], …]`。v5/v4 的 polyline 都是这个格式。
 *
 * ⚠️ **空串必须挡掉**：`''.split(';')` 得 `['']`，再 `Number('')` 得 `0` ——
 * 会凭空造出一个 `(0,0)` 点，把地图拽到几内亚湾。这是「不报错的错」的又一例。
 */
export const parsePolyline = (s) =>
  !s ? [] : String(s).split(';').filter(Boolean).map((p) => p.split(',').map(Number));

/**
 * 高德原始 JSON → **Segment**（一段路的距离/耗时/路径/文字）。
 * `title` 由 `plan.js` 补 —— 只有它知道这一段是哪两个地点。
 *
 * ⚠️ **两个接口的类型和位置都不一样**：
 *      驾车 v5：`route.paths[0]`，`distance` 是**字符串**，耗时藏在 `cost.duration`（还需 show_fields 带 cost）
 *      骑行 v4：`data.paths[0]`，`distance`/`duration` 是**数字**，耗时直接挂在 path 上
 *    **每个数一律 `Number()`**，不要指望类型一致 —— 拿字符串做 `+` 会变成拼接
 *    （`'4559' + '1096'` → `'45591096'`），距离显示成天文数字，而**不会有任何报错**。
 */
function normalize(json, mode) {
  const path = (mode === 'driving' ? json.route?.paths : json.data?.paths)?.[0];
  if (!path) {
    throw new AppError(ERR.ROUTE_NO_RESULT, { info: json.info ?? json.errmsg ?? '路径为空' });
  }
  const steps = path.steps ?? [];
  const points = steps.flatMap((s) => parsePolyline(s.polyline));
  // 有 status=1 但一根线都没有：字段取错（如 v5 漏了 show_fields）就是这个现象 —— 线画不出来，页面不报错。
  if (!points.length) {
    throw new AppError(ERR.ROUTE_NO_RESULT, { info: `${mode} 的 polyline 全为空（v5 驾车要 show_fields=cost,polyline）` });
  }
  return {
    distance: Number(path.distance),
    time: Number(mode === 'driving' ? path.cost?.duration : path.duration),
    path: points,
    steps: steps.map((s) => ({
      instruction: s.instruction ?? '',
      distance: Number(s.step_distance ?? s.distance ?? 0),
    })),
  };
}

// ⚠️ v5 不加这个参数，**既没有 polyline 也没有 duration**（实测：path 只剩 distance/restriction/steps，
//    steps 只剩 instruction/orientation/step_distance）—— 线画不出来、ETA 是空的，**而且不报错**。
//    实测 `navi` 不需要：instruction 是基础字段，不在 show_fields 管辖内。
const DRIVING_FIELDS = 'cost,polyline';

/**
 * 单段规划。**全应用唯一发路径请求的地方。**
 * @param {object} a 起点 `{lnglat}`
 * @param {object} b 终点 `{lnglat}`
 * @param {'riding'|'driving'} mode
 * @param {number|null} [strategy] **数字**（`strategyOf` 解出来的），不是名字
 * @returns {Promise<object>} 不含 `title` 的一段
 */
export async function planSegment(a, b, mode, strategy) {
  const origin = coordToParam(toLngLat(a));
  const destination = coordToParam(toLngLat(b));

  if (mode === 'driving') {
    const json = await request('/v5/direction/driving',
      // 显式传 32（v5 文档写的默认策略），不靠服务端默认 —— 免得高德改默认值我们静默跟着变
      { origin, destination, strategy: strategy ?? 32, show_fields: DRIVING_FIELDS },
      ERR.ROUTE_FAILED);
    return normalize(json, mode);
  }
  if (mode === 'riding') {
    // v4 **只认 key/origin/destination**：没有 strategy，没有 show_fields
    const json = await request('/v4/direction/bicycling', { origin, destination }, ERR.ROUTE_FAILED);
    return normalize(json, mode);
  }
  throw new AppError(ERR.MODE_NOT_SUPPORTED, {});                 // A00106，防御性
}

const toLngLat = (x) => x?.lnglat ?? x;

/**
 * 分段结果 → `RouteResult`。总距离/总耗时 = 各段之和。
 * ⚠️ `RouteResult` **只在这里被构造**。
 */
export function mergeSegments(segments, mode) {
  const totalDistance = segments.reduce((s, x) => s + x.distance, 0);
  const totalTime = segments.reduce((s, x) => s + x.time, 0);
  return {
    mode,
    totalDistance,
    totalTime,
    plans: [{ index: 0, distance: totalDistance, time: totalTime, segments }],
  };
}

// ── 自检：`node src/amaprest.js` ────────────────────────
// 只测**纯函数**（不连网）：信封、分类、策略、坐标串、polyline。
// 真接口的行为要 Key、要网络，只能按 plan 第十一章在真机上过。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  // ⚠️ 三套信封。取错判据的现象是「成功的被判成失败」或反过来 —— 后者更糟：
  //    v4 骑行没有 status 字段，按 `status === '1'` 判会得到 undefined === '1' → false，
  //    于是**每一条骑行路线都报失败**。
  assert(envelope({ status: '1', info: 'OK', infocode: '10000' }).ok, 'v3/v5 成功：status 是字符串 "1"');
  assert(!envelope({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }).ok, 'v3/v5 失败');
  assert(envelope({ errcode: 0, data: {} }).ok, 'v4 骑行成功：errcode 是数字 0，且**没有 status 字段**');
  const v4 = envelope({ errcode: 10001, errmsg: 'INVALID_USER_KEY' });
  assert(!v4.ok && v4.code === 10001 && v4.info === 'INVALID_USER_KEY', 'v4 失败取 errmsg');

  // 数字码是**跨 v3/v5/v4 唯一稳定**的契约。分类错了 = 让人去等一个等不好的错。
  assert(classify(10009)?.code === 'B00102', '10009 平台不符 → B00102（配置错，等不好）');
  assert(classify(10001)?.code === 'B00102', '10001 Key 无效 → B00102');
  assert(classify(20000)?.code === 'B00103', '20000 参数非法 → B00103（我们的 bug）');
  assert(classify(10021)?.code === 'C00102', '10021 QPS 超限 → C00102（会自愈）');
  assert(classify(10003)?.code === 'C00102', '10003 日配额 → C00102');
  assert(classify(20800)?.code === 'A02001', '20800 起终点不在大陆 → A02001（高德说清了原因）');
  // ⚠️ 3xxxx 必须留空 —— 实测「地址查不到」也返回 30001，分不清是谁的错，只能交给调用方
  assert(classify(30001) === null, '30001 不归类（同一码既表示地址不存在也表示参数非法）');
  assert(classify(99999) === null, '表外的码一律不猜');

  // 策略：名字 ↔ 数字。**v5 对无效 strategy 静默回落默认**，所以写错只能是「我们抛」。
  assert(strategyOf('driving', 'AVOID_CONGESTION') === 33, 'AVOID_CONGESTION = 33（不是 JSAPI 的 4）');
  assert(strategyOf('driving', 'LEAST_TIME') === 0, 'LEAST_TIME = 0（这个碰巧与 JSAPI 一样）');
  assert(strategyOf('driving', 'RECOMMENDED') === 32, 'RECOMMENDED = 32（v5 默认）');
  assert(strategyOf('driving', null) === null && strategyOf('driving', '') === null, '空策略 = 不发该参数');
  for (const bad of ['REAL_TRAFFIC', 'LEAST_DISTANCE', 'NOPE']) {
    try { strategyOf('driving', bad); assert(false, `${bad} 必须抛`); }
    catch (e) { assert(e.code === 'B02100', `${bad} 抛 B02100（JSAPI 的名字在 REST 里不存在）`); }
  }
  try { strategyOf('riding', 'FASTEST'); assert(false, '骑行有策略必须抛'); }
  catch (e) { assert(e.code === 'B02100', '骑行 v4 没有 strategy 参数 → 任何名字都抛 B02100'); }
  assert(isTrafficAware(33) && isTrafficAware(32) && !isTrafficAware(0) && !isTrafficAware(35),
    '路况型策略：含「躲避拥堵」语义的才是（0 速度优先、35 不走高速 不是）');

  assert(coordToParam([116.3974631, 39.9091871]) === '116.397463,39.909187', '坐标串固定 6 位小数');
  assert(coordToParam([116, 39.9]) === '116.000000,39.900000', '整数也补齐 6 位');

  // ⚠️ 空串是这里最容易埋的雷：''.split(';') → [''] → Number('') → 0 → 凭空一个 (0,0) 点
  assert(parsePolyline('').length === 0, "parsePolyline('') 得 []（不是 [[0,0]]，那会把地图拽到几内亚湾）");
  assert(parsePolyline(undefined).length === 0, 'polyline 缺失同样是 []');
  assert(JSON.stringify(parsePolyline('116.4,39.9;116.5,39.8')) === '[[116.4,39.9],[116.5,39.8]]',
    '正常串解析成 [[lng,lat], …]');

  if (failed) throw new Error(`amaprest.js 自检失败 ${failed} 项`);
  console.log('amaprest.js 自检通过');
}

selfcheck(demo, import.meta.url);
