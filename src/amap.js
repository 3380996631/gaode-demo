/**
 * 高德 JSAPI **渲染层**。**全应用唯一构造 AMap 对象的地方**。
 *
 * ⚠️ **一个服务请求都不发，也不碰 `fetch`。** 凡是要「问高德要数据」的
 *    （地理编码、骑行/驾车规划）全在 `amaprest.js` —— 因为手里的 Key 是「Web服务」平台，
 *    调 `AMap.Driving` / `AMap.Riding` / `AMap.Geocoder` **一律** `USERKEY_PLAT_NOMATCH`。
 *    本文件只留 `AMap.Map` / `Marker` / `Polyline` / `TileLayer.Traffic` 这些**渲染**类。
 *
 * 名字刻意与 `amaprest.js` 差 4 个字符，就是为了 import 错了能一眼看出来。
 * 不碰 DOM，返回原始数值/纯对象，**不做格式化**。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR } from './errors.js';
import { selfcheck } from './selfcheck.js';

let AMap = null;                    // 加载后的全局类集合
let _map = null;
const _plugins = new Set();          // 已加载的插件，重复调 ensurePlugin 不重复请求
let _routeOverlays = [];             // 本次结果（线 + 起点终点标记）—— clearOverlays 清的就是这些
let _trafficLayer = null;
let _carMarker = null;               // 小车图标（导航时才有）
let _trackLine = null;               // 实际轨迹（与规划线不同色）

/** 地图配色。骑行走非机动车道、驾车走机动车道，颜色沿用高德的习惯区分。 */
export const COLOR = { riding: '#fa8c16', driving: '#1890ff', track: '#52c41a', deviated: '#f5222d' };

/**
 * 高德的失败信息 → 一行字。
 *
 * ⚠️ **不能直接 `String(r)`**：路径规划与地理编码失败时高德给的是**对象**
 *    （`{ info: 'INVALID_USER_SCODE', infocode: '10009' }`），String 一下就成了
 *    `[object Object]` —— 错误码里唯一能定位原因的那一格当场作废，
 *    屏幕上只剩「路线规划失败」四个字，还得去猜是 Key 错了、配额满了，还是真的没路。
 */
function errInfo(r) {
  if (r == null) return '无返回';
  if (typeof r !== 'object') return String(r);
  const known = [r.info, r.infocode, r.message].filter(Boolean).join(' / ');
  if (known) return known;
  // 认不出的对象也要能看 —— String({}) 只会给 `[object Object]`，等于没说
  try { return JSON.stringify(r); } catch { return '无法序列化的失败信息'; }
}

// ── 加载 ──────────────────────────────────────────────

/**
 * 加载 JSAPI 并建图。**必须在 index.html 里先引 `https://webapi.amap.com/loader.js`**。
 * @param {string|HTMLElement} container
 */
export async function initAMap(container) {
  if (!window.AMapLoader) throw new AppError(ERR.LOAD_FAILED, { info: 'loader.js 未引入' });

  // ⚠️ 必须在 load 之前。**为空时一个字都不写** —— 老 Key 本来就不需要安全密钥，
  //    塞一个空的进去等于主动声明「我有 scode 但它是空的」，反而可能被高德拒掉。
  //    空 = 从来没听说过这东西，正是老 Key 期望的状态。
  if (CONFIG.securityJsCode) {
    window._AMapSecurityConfig = { securityJsCode: CONFIG.securityJsCode };
  }

  AMap = await window.AMapLoader.load({
    key: CONFIG.key,
    version: '2.0',
    // ⚠️ 预加载列表里**只放这两个**。任一插件名有问题，load 会整个 reject → 整张地图白屏。
    //    其余一律走 ensurePlugin() 按需加载，把「名字写错」降级为「该功能不可用」。
    plugins: ['AMap.Scale', 'AMap.ToolBar'],
  }).catch((e) => {
    // 高德把原因写在 e.message / e.info 里（INVALID_USER_KEY / INVALID_USER_SCODE / …）。
    // 不透出去的话状态栏只有一句「加载失败」，非得开 F12 才知道该去改 Key 还是补安全密钥。
    throw new AppError(ERR.LOAD_FAILED, { info: errInfo(e) }, e);
  });

  AMap.getConfig().appname = 'amap-jsapi-skill';   // skill 铁律，必须在 new AMap.Map 之前

  _map = new AMap.Map(container, {
    zoom: 13,
    center: [114.06, 22.55],
    viewMode: '2D',
    mapStyle: 'amap://styles/dark',                // 小车屏幕：深色高对比
    zooms: [3, 19],
  });
  _map.addControl(new AMap.Scale());
  return _map;
}

/** 'AMap.TileLayer.Traffic' → window.AMap.TileLayer.Traffic，用来核实插件真的挂上来了 */
function ctor(name) {
  return name.split('.').reduce((o, k) => o?.[k], window);
}

/** 按需加载插件。**内部缓存已加载集合**，重复调用不重复请求。 */
export function ensurePlugin(names) {
  const list = [].concat(names);
  const need = list.filter((n) => !_plugins.has(n));
  if (!need.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    AMap.plugin(need, () => {
      // AMap.plugin 对错名字不一定报错，所以自己核一遍类有没有真的挂上来
      const missing = need.filter((n) => !ctor(n));
      if (missing.length) return reject(new AppError(ERR.PLUGIN_FAILED, { plugin: missing.join('、') }));
      need.forEach((n) => _plugins.add(n));
      resolve();
    });
  });
}

// ── 绘制 ──────────────────────────────────────────────

/** `{lnglat}` 或 `[lng,lat]` → `[lng,lat]`。标记的入参两种形态都收。 */
const toLngLat = (x) => x?.lnglat ?? x;

function addOverlay(o) {
  _map.add(o);
  _routeOverlays.push(o);
  return o;
}

/** 画一条线。对比切换、拖拽重绘、串联各段、导航轨迹**共用这一个**。 */
export function drawPolyline(path, color = COLOR.driving, { weight = 6, dashed = false, keep = false } = {}) {
  const line = new AMap.Polyline({
    path,
    strokeColor: color,
    strokeWeight: weight,
    strokeOpacity: 0.9,
    lineJoin: 'round',
    lineCap: 'round',
    strokeStyle: dashed ? 'dashed' : 'solid',
    strokeDasharray: dashed ? [10, 6] : undefined,
    zIndex: 50,                                        // 压在路况图层（默认 4）之上
  });
  if (keep) { _map.add(line); return line; }           // keep=true：导航轨迹这类不被 clearOverlays 清的
  return addOverlay(line);
}

/** 起/途/终标记。设为可拖拽，**返回数组，引用与 places 一一对应**。 */
export function addStopMarkers(places, onDragEnd) {
  return places.map((place, i) => {
    const kind = i === 0 ? '起' : i === places.length - 1 ? '终' : '途';
    const color = i === 0 ? '#52c41a' : i === places.length - 1 ? '#f5222d' : '#1890ff';
    const marker = new AMap.Marker({
      position: toLngLat(place),
      draggable: true,
      anchor: 'bottom-center',
      zIndex: 100,
      content: `<div class="pin" style="--pin:${color}"><span>${kind}</span></div>`,
    });
    marker.on('dragend', (e) => onDragEnd?.(i, [e.lnglat.lng, e.lnglat.lat]));
    return addOverlay(marker);
  });
}

/** 重算前统一清线 + 清标记。**不动路况图层，也不动轨迹**（那是底图 / 诊断通道，不是本次结果）。 */
export function clearOverlays() {
  if (_routeOverlays.length) {
    _map.remove(_routeOverlays);
    _routeOverlays = [];
  }
}

/** 挂/摘实时路况图层。受 CONFIG.nav.showTrafficLayer 控制，**骑行时应当关掉**。 */
export async function ensureTrafficLayer(on) {
  if (!on || !CONFIG.nav.showTrafficLayer) {
    if (_trafficLayer) { _map.remove(_trafficLayer); _trafficLayer = null; }
    return;
  }
  if (_trafficLayer) return;
  await ensurePlugin('AMap.TileLayer.Traffic');
  // ⚠️ 独立图层类，不是 Driving 的 showTraffic（那个只在传了 map 时才生效，而我们刻意不传）
  _trafficLayer = new AMap.TileLayer.Traffic({ autoRefresh: true, zIndex: 4 });
  _map.add(_trafficLayer);
}

/** 视野收拢。不传则对所有覆盖物自适应。 */
export function fitView(overlays) {
  _map.setFitView(overlays ?? null, false, [80, 80, 80, 80]);
}

export function setCenter(lnglat, zoom) {
  _map.setCenter(lnglat);
  if (zoom) _map.setZoom(zoom);
}

// ── 导航专用 ──────────────────────────────────────────

/** 小车图标。只建一次，之后靠 `moveCar` 移动 —— 反复 new 会闪，也会漏监听器。 */
export function moveCar(lnglat, heading = 0) {
  const html = `<div class="car"><div class="car-arrow" style="transform:rotate(${heading}deg)"></div></div>`;
  if (!_carMarker) {
    _carMarker = new AMap.Marker({ position: lnglat, anchor: 'center', zIndex: 200, content: html });
    _map.add(_carMarker);
  } else {
    _carMarker.setPosition(lnglat);
    _carMarker.setContent(html);
  }
}

export function removeCar() {
  if (_carMarker) { _map.remove(_carMarker); _carMarker = null; }
}

/** 实际轨迹。**用原始定位点画，不用吸附点** —— 这是调 GPS 与去抖参数的唯一凭据。 */
export function drawTrack(path) {
  if (!_trackLine) {
    _trackLine = new AMap.Polyline({
      path, strokeColor: COLOR.track, strokeWeight: 4, strokeOpacity: 0.8,
      strokeStyle: 'dashed', strokeDasharray: [6, 6], zIndex: 40,
    });
    _map.add(_trackLine);
  } else {
    _trackLine.setPath(path);
  }
}

export function clearTrack() {
  if (_trackLine) { _map.remove(_trackLine); _trackLine = null; }
}

export function onMapClick(cb) {
  _map.on('click', (e) => cb([e.lnglat.lng, e.lnglat.lat]));
}

export const isReady = () => !!_map;

// ── 自检：`node src/amap.js` ────────────────────────────
// 只测**不碰 window 的那部分**（errInfo 是纯函数）。真正的 AMap 行为要连网、要有 Key，
// 只能按 plan 第十一章在真机上过。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  // ⚠️ 回归断言。高德失败时给的是**对象**，`String()` 一下就成了 `[object Object]` ——
  //    屏幕上只剩「路线规划失败」几个字，缺安全密钥、配额用尽、真没路，三者分不出来。
  const o = errInfo({ info: 'INVALID_USER_SCODE', infocode: '10009' });
  assert(o === 'INVALID_USER_SCODE / 10009', `对象形式的失败信息被拆出来（实得「${o}」）`);
  assert(errInfo('INVALID_USER_KEY') === 'INVALID_USER_KEY', '字符串形式原样透出');
  assert(errInfo(null) === '无返回' && errInfo(undefined) === '无返回', '空返回有兜底文案');
  assert(errInfo({ whatever: 1 }) === '{"whatever":1}', '认不出的对象退化为 JSON，而不是 [object Object]');
  const cyc = {}; cyc.self = cyc;
  assert(errInfo(cyc) === '无法序列化的失败信息', '循环引用不会把错误路径本身炸掉');

  if (failed) throw new Error(`amap.js 自检失败 ${failed} 项`);
  console.log('amap.js 自检通过');
}

selfcheck(demo, import.meta.url);
