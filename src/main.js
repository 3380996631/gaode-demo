/**
 * 入口：读配置 → 装配各层 → 启动。**不含业务规则** ——
 * 校验在 `plan.js`，取数在 `amaprest.js`（REST），渲染在 `amap.js`（JSAPI）/ `ui.js`，
 * 这里只负责把它们接起来。
 */
import { CONFIG, missingConfig } from '../config.js';
import * as amap from './amap.js';
import * as amaprest from './amaprest.js';
import * as plan from './plan.js';
import * as ui from './ui.js';
import * as store from './store.js';
import { exportRoute } from './export.js';
import { AppError, ERR, report } from './errors.js';
import { startFusion, getFix, isStaticNow, pushNmea, pushImu } from './fuse.js';

let session = null;        // 导航会话；null = 未在导航
let comparison = null;     // 最后一次对比结果（「画它」要它）
let trackPath = [];        // 实际轨迹，**只存内存**（1Hz 跑一小时 3600 个点，写 localStorage 没意义）
let gpsState = '';         // 只在变化时写状态栏，否则每帧刷屏

// ── 规划 ──────────────────────────────────────────────

/** 只规划一列：预估请求数 = 段数。对比才要 ×列数 —— 上限得按**真实**要发的数算。 */
const PLAN_ONLY = [{}];

async function doPlan() {
  await run(async () => {
    const resolved = await resolve(PLAN_ONLY);
    const route = await plan.planRoute(resolved, ui.getMode(), ui.getPolicy());
    showRoute(route);
    saveHistory();
    ui.setStatus(`已规划 ${ui.getMode() === 'riding' ? '骑行' : '驾车'}路线`, 'ok');
  });
}

/** 校验 → 地理编码回填。回填后再规划**不再发编码请求**。 */
async function resolve(axes) {
  const places = ui.getPlaces();
  plan.validatePlaces(places, ui.getMode(), axes);   // A00100 / A00104 / A00106 / A00105，不过则零请求
  const resolved = await plan.resolvePlaces(places);
  ui.setPlaces(resolved);
  return resolved;
}

function showRoute(route, { fit = true } = {}) {
  amap.clearOverlays();                          // 只清线 + 标记，**不动路况图层**（那是底图）
  const path = route.plans[0]?.segments.flatMap((s) => s.path) ?? [];
  amap.drawPolyline(path, amap.COLOR[route.mode]);
  amap.addStopMarkers(ui.getPlaces(), onDragEnd);
  if (fit) amap.fitView();
  // 骑行没有路况概念，挂上去纯属持续烧瓦片
  amap.ensureTrafficLayer(route.mode === 'driving').catch(report);
  ui.renderPlan(route);
  // ⚠️ warning 是 ERR 里的**定义对象**（{code,msg}），不是 AppError —— 不能走 showError
  if (route.warning) ui.setStatus(`[${route.warning.code}] ${route.warning.msg}`, 'warn');
}

// ── 对比 ──────────────────────────────────────────────

async function doCompare() {
  await run(async () => {
    const resolved = await resolve(CONFIG.compareAxes);
    comparison = await plan.compareRoutes(resolved, CONFIG.compareAxes);
    ui.renderComparison(comparison);
    // 「哪条最好」是 plan.js 算好的，视图层不算
    pickColumn(comparison.bestTimeIndex);
    ui.setStatus(`已对比 ${comparison.entries.length} 个方案`, 'ok');
  });
}

function pickColumn(i) {
  const e = comparison?.entries?.[i];
  if (!e?.result) return;
  showRoute(e.result, { fit: false });
}

// ── 导航 ──────────────────────────────────────────────

async function doNav() {
  await run(async () => {
    const resolved = await resolve(PLAN_ONLY);
    stopNav();
    trackPath = [];
    amap.clearTrack();
    session = plan.createNavSession({
      places: resolved,
      mode: ui.getMode(),
      policy: ui.getPolicy(),
      onUpdate: onNavUpdate,
      onRoute: (r) => showRoute(r, { fit: false }),   // 刷新/重算：整体替换，不闪
    });
    await session.start();
    ui.setNavigating(true);
    ui.setStatus('导航中', 'ok');
  });
}

function stopNav() {
  session?.stop();
  session = null;
  ui.setNavigating(false);
}

function onNavUpdate(p) {
  switch (p.kind) {
    case 'move': onMove(p); break;
    case 'dr':
      // GPS 失锁转推算：精度在衰减，**必须明示**
      amap.moveCar(p.fix.lnglat, p.fix.course || 0);
      ui.setStatus(`[${ERR.GPS_LOST_DR.code}] ${ERR.GPS_LOST_DR.msg}`, 'warn');
      break;
    case 'offroute':
      ui.showError(p.error);                        // A05102 已偏离路线 N 米
      break;
    case 'reroute':
      ui.setStatus(`已按当前位置重算（第 ${session?.rerouteCount ?? 0} 次）`, 'ok');
      break;
    case 'refresh':
      ui.setStatus('路况已刷新', 'ok');
      break;
    case 'arrived':
      ui.setStatus('已到达终点', 'ok');
      stopNav();
      break;
    case 'error':
      report(p.error);
      ui.showError(p.error);                        // 如 A05103 重算次数上限、C02101 刷新失败
      break;
  }
}

function onMove({ fix, proj }) {
  // ⚠️ 轨迹要真相，图标要稳定：轨迹用**原始点**（调 GPS 与去抖参数的唯一凭据），
  //    图标用**吸附点**（滤掉横向噪声，给人看的）。两者都用吸附点等于把诊断通道也滤了。
  trackPath.push(fix.lnglat);
  amap.drawTrack(trackPath);
  amap.moveCar(proj && CONFIG.gps.snapToRoute ? proj.snapped : fix.lnglat, fix.course || 0);
  ui.setProgress(proj?.ratio ?? null);
}

// ── 定位 ──────────────────────────────────────────────

function onFix(fix) {
  if (!session) amap.moveCar(fix.lnglat, fix.course || 0);   // 导航中由 onMove 接管，避免每帧画两次
  syncGpsStatus(fix);
  session?.push(fix, { isStatic: isStaticNow() });
}

/** 定位状态只在**变化时**写状态栏 —— 5Hz 下每帧写会把别的提示冲掉。 */
function syncGpsStatus(fix) {
  const s = fix.usable ? 'ok' : 'poor';
  if (s === gpsState) return;
  gpsState = s;
  if (s === 'ok') ui.setStatus(`定位正常（${fix.sats} 星，HDOP ${fix.hdop}）`, 'ok');
  else ui.setStatus(`[${ERR.GPS_HDOP_POOR.code}] 定位精度不足（HDOP ${fix.hdop}），该点不参与偏航判定`, 'warn');
}

/** 「定位」按钮：把车载 GPS 的当前位置填进第 i 行 —— **零高德请求**。 */
function locate(i) {
  const fix = getFix();
  if (!fix) return ui.showError(new AppError(ERR.NO_FIX, {}));
  const places = ui.getPlaces();
  places[i].lnglat = fix.lnglat;
  // 不回填逆地理编码地址：白烧一次请求，坐标本身已经说明这是哪来的
  places[i].text = `当前位置 ${fix.lnglat[0].toFixed(5)}, ${fix.lnglat[1].toFixed(5)}`;
  ui.setPlaces(places);
  markDirty();
}

async function onMapClick(lnglat) {
  const i = ui.getActive();
  // ⚠️ 没选行就发逆编码 = 白烧一次请求。**先拦，再发。**
  if (i == null) return ui.showError(new AppError(ERR.NO_ACTIVE_ROW, {}));
  const addr = await amaprest.reverseGeocode(lnglat);      // 失败返回 null，不抛
  const places = ui.getPlaces();
  places[i].lnglat = lnglat;
  places[i].text = addr ?? `${lnglat[0].toFixed(5)}, ${lnglat[1].toFixed(5)}`;
  ui.setPlaces(places);
  markDirty();
}

function onDragEnd(i, lnglat) {
  ui.setPlaceLngLat(i, lnglat);                            // 只改本地，**不发请求**
  markDirty();
}

function markDirty() {
  // 旧线**保留不擦** —— 它表明「这是上次的结果」，重算成功后整体替换
  ui.setStatus('地点已改动，点「开始规划」更新路线', 'warn');
}

// ── 导出 ──────────────────────────────────────────────

function exportAs(fmt) {
  const route = ui.getResult();
  if (!route) return ui.setStatus('先规划一条路线再导出', 'warn');
  try {
    exportRoute(route, ui.getPlaces(), fmt);
    ui.setStatus(`已导出 ${fmt.toUpperCase()}`, 'ok');
  } catch (e) {
    report(e);
    ui.showError(e);
  }
}

// ── 历史 ──────────────────────────────────────────────

function saveHistory() {
  const places = ui.getPlaces();
  try {
    store.addHistory({
      id: String(Date.now()),
      name: places.map((p) => p.text).filter(Boolean).slice(0, 2).join(' → ') || '未命名',
      mode: ui.getMode(),
      policy: ui.getPolicy(),          // 对比时用户可能选了某条策略，恢复时要能还原
      places,                           // 只存输入，不存路线结果 —— 存了会过期
      createdAt: Date.now(),
    });
    ui.renderHistory(store.loadHistory());
  } catch (e) {
    report(e);
    ui.showError(e);                    // B04102 配额满
  }
}

function historyLoad(id) {
  const h = store.loadHistory().find((x) => x.id === id);
  if (!h) return;
  ui.setPlaces(h.places.map((p) => ({ text: p.text, lnglat: p.lnglat })));
  ui.setMode(h.mode);
  ui.setPolicy(h.policy);
  markDirty();                          // 恢复了输入，路线还没算
}

function historyDelete(id) {
  store.removeHistory(id);
  ui.renderHistory(store.loadHistory());
}

// ── 工具 ──────────────────────────────────────────────

/** 所有异步入口统一收口：report 落 console，showError 落状态栏。 */
async function run(fn) {
  try {
    await fn();
  } catch (e) {
    report(e);
    ui.showError(e);
  }
}

// ── 启动 ──────────────────────────────────────────────

ui.initUI({
  plan: doPlan,
  compare: doCompare,
  nav: doNav,
  stopNav,
  exportAs,
  locate,
  pick: () => ui.setStatus('点地图选点，地址会填进选中的那一行'),
  pickColumn,
  historyLoad,
  historyDelete,
});

// 界面绑完事件才算「起来了」—— index.html 里那段启动诊断看的就是这个标记。
// 放在 initUI **之后**：它之前抛异常（比如选错 id）页面同样是死的，那时也该报警。
window.__guideMapBooted = true;

(async function boot() {
  const miss = missingConfig();
  if (miss.length) {
    // ⚠️ 缺 Key 是 B00100 + 一句提示，**不是白屏**
    return ui.showError(new AppError(ERR.KEY_MISSING, { missing: miss.join('、') }));
  }

  // 定位源先起 —— **与地图无关**。地图挂了（Key 错、插件加载失败）也得能调 GPS，
  // 否则一白屏就再也分不清是 Key 的问题还是接线的问题。
  // **传输方式未定**（plan TODO#2）：传感器怎么进浏览器还没选型，所以这里只把
  // 「喂字节」的入口挂出去 —— 接 Web Serial / Node 代理 / 回放文件都不改上层。
  startFusion({
    onFix,
    onError: (e) => { report(e); if (e.code[0] !== 'A') ui.showError(e); },
  });
  // 控制台自测：window.guideMap.feedNmea('$GNRMC,...\r\n')
  // ponytail: 真车要的是 Web Serial 接管这两行，见 plan TODO#2
  window.guideMap = { feedNmea: pushNmea, feedImu: pushImu, getFix };

  ui.renderHistory(store.loadHistory());
  ui.setStatus(`[${ERR.NO_FIX.code}] ${ERR.NO_FIX.msg}`, 'warn');   // 冷启动最多等 35 秒

  try {
    await amap.initAMap('map');
  } catch (e) {
    report(e);
    return ui.showError(e);              // C00001 加载失败
  }
  amap.onMapClick((lnglat) => run(() => onMapClick(lnglat)));
})();
