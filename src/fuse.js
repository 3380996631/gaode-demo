/**
 * 定位融合层 —— **全应用唯一的定位出口**（`getFix()` 在这里）。
 *
 * 职责切得很干净：
 *   `gps.js`  NMEA → 原始定位点      **不融合**
 *   `imu.js`  IMU  → 增量 + 静止判定  **不融合、不认识 GPS**
 *   `fuse.js` 上面两个 → `Fix`        **不解析任何协议**
 *
 * 只有本文件依赖那两个，反过来不行。
 *
 * ⚠️ **当前是「直通 + 本地后处理」，不是真正的融合**（融合深度见 plan TODO#1）。
 *    这不是留着以后填的空架子 —— 它把依赖方向定死，等算法到位，
 *    上层（`plan.js` / `ui.js` / `main.js`）**一行不动**。
 *
 * 现在做的是第五章那三层滤噪里的第 2、3 层（静止检测、速度门控野值剔除）。
 * 第 1 层（投影到路线）在 `plan.js` 的 `projectOntoRoute()` —— 它需要路线，那是业务层的事。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR } from './errors.js';
import { distMeters } from './geo.js';
import { createNmeaSource, isFixUsable } from './gps.js';
import { createImuSource, isStatic } from './imu.js';
import { selfcheck } from './selfcheck.js';

/** IMU 多久没数据就认为它不在了，退回 GPS 速度判据【毫秒】 */
const IMU_STALE_MS = 1000;

let _nmea = null;
let _imu = null;
let _onFix = null;
let _onError = null;
let _now = Date.now;

let _fix = null;          // 对外暴露的定位（可能被冻结）
let _prev = null;         // 上一个通过门限的定位 —— 野值剔除的基准
let _imuStatic = false;
let _imuAt = 0;           // 最近一次 IMU 采样的时刻

/**
 * 装配定位源。**唯一创建两个 source 的地方。**
 *
 * 数据进来的方式与传输无关 —— `pushNmea` / `pushImu` 吃的是**字节或文本**，
 * 串口（Web Serial）还是回放文件，本层不关心也看不见（TODO#2）。
 *
 * @param {Object} o
 * @param {(fix:object)=>void} o.onFix    每个可用定位点一次
 * @param {(e:Error)=>void} [o.onError]   A/C 类非致命告警（坏句、跳变、超量程…）
 * @param {()=>number} [o.now]            取时钟。**只有自检会改它**
 */
export function startFusion({ onFix, onError, now = Date.now } = {}) {
  stopFusion();
  _onFix = onFix;
  _onError = onError;
  _now = now;
  const err = (e) => _onError?.(e);
  _nmea = createNmeaSource({ onFix: accept, onError: err });
  _imu = createImuSource({
    onError: err,
    now,
    onSample: (s) => {
      // 超量程那段本来就不可信，`isStatic` 会因为角速度巨大而自己返回 false，不用另判
      _imuStatic = isStatic(s.gyro, s.accel);
      _imuAt = now();
    },
  });
}

export function stopFusion() {
  _nmea = _imu = _onFix = _onError = null;
  _fix = _prev = null;
  _imuStatic = false;
  _imuAt = 0;
  _now = Date.now;
}

/** @param {string|Uint8Array} chunk NMEA 文本或字节 */
export const pushNmea = (chunk) => _nmea?.push(chunk);

/** @param {Uint8Array|number[]} bytes IMU 原始字节 */
export const pushImu = (bytes) => _imu?.push(bytes);

/**
 * **全应用唯一的定位入口。** 换定位模块、改融合深度、退回浏览器定位，
 * 都只改这一个函数的内部，上层一行不动。
 *
 * @returns {Object|null} null = 当前无可用定位。**这是常态不是异常** ——
 *   冷启动头 35 秒每秒都会发生，用异常表达会让调用方到处写 try/catch。
 */
export const getFix = () => _fix;

/** 最近一次定位是否静止（用于冻结位置 + 不参与偏航判定）。 */
export const isStaticNow = () => (_fix ? isStaticFor(_fix) : false);

// ── 内部 ──────────────────────────────────────────────

/**
 * 静止判据。**有 IMU 就以 IMU 为准，没有才退回 GPS 速度。**
 *
 * 为什么 IMU 严格更好：GPS 速度是**相邻位置差商推出来的**，静止时位置噪声会让
 * 它读出「0.3 m/s」这种虚高的值；IMU 输出就是零。而且 200Hz vs 1~5Hz，即时无延迟。
 * 桌面调试 / 地面站没接 IMU 时，速度回退让软件照样能跑。
 */
function isStaticFor(fix) {
  if (_imuAt && _now() - _imuAt < IMU_STALE_MS) return _imuStatic;
  return Number.isFinite(fix.speed) && fix.speed < CONFIG.gps.staticSpeed;
}

/** GPS 定位点通过门限后的落点 */
function accept(fix) {
  fix.timestamp = _now();                 // 时钟以本层为准，两个源共用一个时间基
  fix.usable = isFixUsable(fix);          // 质量门限：不达标的点仍显示，但不参与偏航判定

  // ── 第 3 层：速度门控野值剔除 ──
  // 用「这一步最远能走多远」当门限，跳变超过就丢弃。约 10 行，代价是要记住上一个点。
  if (_prev) {
    // 下限一个 GPS 采样周期：连发两点时 dt→0 会让门限退化成 0，把真点也一起毙掉。
    // ⚠️ 是 gps.rateHz 不是 imu.rateHz —— 门限比的是定位点，IMU 不产 Fix
    const dt = Math.max((fix.timestamp - _prev.timestamp) / 1000, 1 / CONFIG.gps.rateHz);
    const moved = distMeters(_prev.lnglat, fix.lnglat);
    if (moved > CONFIG.gps.maxSpeed * dt) {
      // ⚠️ 丢弃它，但时间基照常前进（位置不动）—— 否则门限会随时间无界放宽
      _prev = { ..._prev, timestamp: fix.timestamp };
      _onError?.(new AppError(ERR.GPS_OUTLIER, { distance: Math.round(moved) }));
      return;
    }
  }

  // ── 第 2 层：静止冻结 ──
  // 只钉住位置，HDOP / 卫星数 / 速度照常刷新 —— 状态栏才有东西可显。
  // 干掉的是点名的头号误报源：等红灯时原地漂。
  if (_prev && isStaticFor(fix)) {
    fix.lnglat = _prev.lnglat;
    fix.rawLnglat = _prev.rawLnglat;
  }

  _prev = fix;
  _fix = fix;
  _onFix?.(fix);
}

// ── 自检：`node src/fuse.js` ────────────────────────────
// ⚠️ IMU 那条支路（isStatic）在 imu.js 自检里；这里只覆盖它的**接线边界**
//    ——「IMU 没数据时退回 GPS 速度判据」是这条支路上唯一可能接错的地方。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  // 造 NMEA：手抄度数→度分格式太容易错，直接按公式生成
  const dm = (v) => {
    const d = Math.floor(Math.abs(v));
    return String(d).padStart(2, '0') + ((Math.abs(v) - d) * 60).toFixed(4).padStart(7, '0');
  };
  const withSum = (body) => {
    let s = 0;
    for (let i = 0; i < body.length; i++) s ^= body.charCodeAt(i);
    return `$${body}*${s.toString(16).toUpperCase().padStart(2, '0')}`;
  };
  /** @param speedKnots 0.1 节以下会被速度回退判成静止 */
  const sentences = (lng, lat, speedKnots, utc) => [
    withSum(`GNGGA,${utc},${dm(lat)},N,${dm(lng)},E,1,08,0.9,545.4,M,46.9,M,,`),
    withSum(`GNRMC,${utc},A,${dm(lat)},N,${dm(lng)},E,${speedKnots},173.29,230394,003.1,W,A`),
    '',
  ];

  let t = 1_700_000_000_000;
  let errors = [];
  const fits = [];
  startFusion({ onFix: (f) => fits.push(f), onError: (e) => errors.push(e), now: () => t });
  const land = (lng, lat, kn = 6.082, utc = '123519.00') => {
    pushNmea(sentences(lng, lat, kn, utc).join('\r\n'));
  };

  const A = [114.05788, 22.54310];

  // ① 第一个点无条件通过（没有基准可比）
  // ⚠️ 帧数用**增量**断言，不用绝对值：冷启动第一个历元会「先残缺后补全」产 2 帧
  //    （见 gps.js 自检），这里测的是门限与冻结，不该被它带偏。
  land(...A);
  assert(fits.length >= 1, '第一个定位点被接受');
  assert(getFix()?.source === 'gps', 'source 是 gps（融合深度①，还只是直通）');
  assert(getFix()?.usable === true, 'HDOP 0.9 / 8 星 → usable');

  // ② 500 米跳变必须被丢掉 —— 但时间基照常前进
  const n1 = fits.length;
  t += 200;
  land(114.06275, 22.54310, 6.082, '123520.00');
  assert(fits.length === n1, '500 米跳变被丢弃（不产 Fix）');
  assert(errors.at(-1)?.code === ERR.GPS_OUTLIER.code, `跳变落 A05105（实得 ${errors.at(-1)?.code}）`);
  assert(Math.abs(getFix().lnglat[0] - A[0] - 0.0044) < 0.002, 'getFix() 位置没被跳变带跑');

  // ③ 正常步进（200ms 走 2 米，门限 = 15m/s × 0.2s = 3m）照常通过
  const n2 = fits.length;
  t += 200;
  land(114.0579, 22.54310, 6.082, '123521.00');
  assert(fits.length > n2, '正常步进 2 米通过门限');

  // ④ 静止冻结：速度为 0.1 节 → 回退判据认定静止 → 位置钉住
  const before = [...getFix().lnglat];
  const n3 = fits.length;
  t += 1000;                                     // 门限 15m/s × 1s = 15m，10 米的位移才过得去
  land(114.05800, 22.54310, 0.1, '123522.00');
  assert(fits.length > n3, '低速点仍产 Fix（能显示，只是不参与判定）');
  assert(getFix().lnglat[0] === before[0] && getFix().lnglat[1] === before[1],
    '静止 → 位置冻结（钉住上一个坐标，不是新坐标）');
  assert(getFix().speed < CONFIG.gps.staticSpeed, '速度字段照常刷新（状态栏有东西可显）');

  // ⑤ IMU 一旦有数据就以它为准 —— 这里只验「喂噪声不炸」，判据本身在 imu.js 自检里
  const n = errors.length;
  pushImu([0x80, 1, 2, 3, 0x0d]);
  assert(errors.length >= n, 'pushImu 吃噪声不抛（校验失败落 C06100）');

  // ⑥ 收工后不留状态
  stopFusion();
  assert(getFix() === null, 'stopFusion 后 getFix() 为 null');

  if (failed) throw new Error(`fuse.js 自检失败 ${failed} 项`);
  console.log('fuse.js 自检通过');
}

selfcheck(demo, import.meta.url);
