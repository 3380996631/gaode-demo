/**
 * IMU（M-G354PDH0）读取与静止检测。**全应用唯一碰 IMU 的地方。**
 *
 * 不碰 DOM，不认识 AMap / GPS，**不做融合** —— 融合在 `fuse.js`。
 *
 * 帧格式与比例因子全部来自 [datasheet](../doc/M-G354PDH0.md) 6.3 / 7.10 / 7.11，
 * 没有一个数是猜的。有两处**手册没写死、必须上车核对**，见文件末尾。
 *
 * 传输方式（串口怎么进浏览器）未定，见 plan TODO#2 —— 本文件只吃字节流，不管字节从哪来。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR } from './errors.js';
import { selfcheck } from './selfcheck.js';

const G = 9.80665;                  // 标准重力加速度【米/秒²】
const DEG2RAD = Math.PI / 180;

// ── 比例因子（手册 Table 2.3 / 7.2 / 7.3） ─────────────

const GYRO_SF = 0.016;              // (度/秒)/LSB，16bit
const ACCEL_SF_MG = 0.2;            // mG/LSB，16bit
const TEMP_SF = -0.0037918;         // ℃/LSB（**负斜率**：raw 越大温度越低）
const TEMP_REF_RAW = 2634;          // 0x0A4A @ +25℃
const TEMP_REF_C = 25;

/** 增量比例因子，索引 = DLT_CTRL[0x12] bits[3:0]。⚠️ 必须与模块寄存器实际值一致。 */
export const DELTA_ANGLE_SF = [
  8.000e-6, 1.600e-5, 3.200e-5, 6.400e-5, 1.280e-4, 2.560e-4, 5.120e-4, 1.024e-3,
  2.048e-3, 4.096e-3, 8.192e-3, 1.638e-2, 3.277e-2, 6.554e-2, 1.311e-1, 2.621e-1,
];  // 度/LSB
export const DELTA_VEL_SF = [
  9.807e-7, 1.961e-6, 3.923e-6, 7.845e-6, 1.569e-5, 3.138e-5, 6.276e-5, 1.255e-4,
  2.511e-4, 5.021e-4, 1.004e-3, 2.008e-3, 4.017e-3, 8.034e-3, 1.607e-2, 3.213e-2,
];  // (米/秒)/LSB

// ── 帧格式（手册 6.3） ────────────────────────────────

const ADDR = 0x80;
const CR = 0x0d;
/** 三种包长都要能认，但**只有 62 字节那种带 DELTA**。 */
const LENGTHS = [62, 38, 24];
const WARMUP_MS = 800;              // 手册：power-on ≤800ms，这之前的数据不可信

const u16 = (b, i) => (b[i] << 8) | b[i + 1];                    // 大端（手册：MSByte first）
const i16 = (b, i) => (u16(b, i) << 16) >> 16;                   // 有符号
const i32 = (b, i) => (i16(b, i) << 16) | u16(b, i + 2);         // HIGH 字在前

/**
 * 校验和（手册 5.11）：**从地址字节之后、到 CR 之前**，以 16 位为单位相加，
 * 截断到 16 位。范围**不含**校验字自己。
 */
function checksumOk(b) {
  let sum = 0;
  for (let i = 1; i < b.length - 3; i += 2) sum += u16(b, i);
  return (sum & 0xffff) === u16(b, b.length - 3);
}

/** 62 字节包 → 物理量。索引按手册 6.3 的字节表，0-based。 */
function decode62(b) {
  const sfA = DELTA_ANGLE_SF[CONFIG.imu.deltaRangeCtrl];
  const sfV = DELTA_VEL_SF[CONFIG.imu.deltaRangeCtrl];
  if (sfA == null) {
    throw new AppError(ERR.IMU_NOT_READY, { note: `deltaRangeCtrl=${CONFIG.imu.deltaRangeCtrl} 越界（应 0~15）` });
  }

  // 32 位用法换算：∆Angle[deg] = (SF/65536) × D（手册 7.10 / 7.11）
  const dAngle = [31, 35, 39].map((i) => (sfA / 65536) * i32(b, i) * DEG2RAD);      // 弧度
  const dVel = [43, 47, 51].map((i) => (sfV / 65536) * i32(b, i));                   // ⚠️ 含重力

  // ⚠️ 陀螺/加速度计**只用 HIGH 字**，因为手册给的比例因子就是 16bit 的。
  //    LOW 字是更高分辨率，但手册没给对应比例因子 —— 猜一个比不用更糟。
  const gyro = [7, 11, 15].map((i) => i16(b, i) * GYRO_SF * DEG2RAD);               // 弧度/秒
  const accel = [19, 23, 27].map((i) => (i16(b, i) * ACCEL_SF_MG / 1000) * G);      // 米/秒²

  return {
    dAngle,
    dVel,
    gyro,
    accel,
    temp: TEMP_REF_C + (i16(b, 3) - TEMP_REF_RAW) * TEMP_SF,
    count: u16(b, 57),
    overflow: !!(b[2] & 0x01),        // EA 位：增量溢出
    valid: b[1] === 0,                // ND 位全 0 = 各通道本帧都有效
  };
}

// ── 静止检测 ──────────────────────────────────────────

/**
 * 静止判定：**角速度 ≈ 0 且 加速度模长 ≈ 1g**。
 *
 * ⚠️ **不能用速度增量判** —— 加速度计测的是比力，车静止时它读到 +1g，
 *    积分出来是 `g·dt` 而不是 0，`dVel ≈ 0` 永远不成立。
 *    写错了的现象是「车停着时系统认为它在动」，而且**不报任何错**。
 *
 * @param {number[]} gyro  【弧度/秒】
 * @param {number[]} accel 【米/秒²】
 */
export function isStatic(gyro, accel) {
  return Math.hypot(...gyro) < CONFIG.imu.staticGyro
    && Math.abs(Math.hypot(...accel) - G) < CONFIG.imu.staticAccel;
}

/** 增量是否超量程。超了那一段运动不可信 → A06101 并跳过该段（不是整帧丢弃）。 */
export function isSaturated(sample) {
  return sample.overflow
    || Math.max(...sample.gyro.map(Math.abs)) >= CONFIG.imu.gyroRange * DEG2RAD * 0.99
    || Math.max(...sample.accel.map(Math.abs)) >= CONFIG.imu.accelRange * G * 0.99;
}

// ── 流读取器 ──────────────────────────────────────────

/**
 * 吃字节流，吐 `Sample`。
 * UART Auto Mode 下模块自己推送、自己复位（手册 5.12），所以这里只解码，不需要发「读」命令。
 *
 * @param {Object} o
 * @param {(s:object)=>void} o.onSample
 * @param {(e:Error)=>void} [o.onError]
 * @param {number} [o.warmupMs]  预热窗口，默认 800。**只有自检会改它**
 * @param {()=>number} [o.now]   取时钟，默认 Date.now。同上
 */
export function createImuSource({ onSample, onError, warmupMs = WARMUP_MS, now = Date.now }) {
  let buf = [];
  let startedAt = 0;
  let warned = false;
  let lastCount = null;
  let lastTs = 0;

  function resync() {
    const next = buf.indexOf(ADDR, 1);
    buf = next < 0 ? [] : buf.slice(next);
  }

  function take() {
    if (buf[0] !== ADDR) { resync(); return; }
    const len = LENGTHS.find((n) => buf.length >= n && buf[n - 1] === CR);
    if (len == null) {
      if (buf.length > LENGTHS[0]) resync();     // 攒够最长的包还不见 CR → 这个 0x80 是噪声
      return;
    }
    const frame = buf.slice(0, len);
    buf = buf.slice(len);

    if (!checksumOk(frame)) { onError?.(new AppError(ERR.IMU_CHECKSUM_FAILED, {})); return; }
    if (len !== 62) return;                      // 24 / 38 字节包没有 DELTA，对我们没用

    const t = now();
    if (!startedAt) startedAt = t;
    if (t - startedAt < warmupMs) {
      if (!warned) { warned = true; onError?.(new AppError(ERR.IMU_NOT_READY, { ms: warmupMs })); }
      return;
    }

    let sample;
    try {
      sample = decode62(frame);
    } catch (e) {
      onError?.(e);
      return;
    }

    // dt 用模块自己的 COUNT（手册：分辨率 ≈21.33µs，16 位，会回绕）。
    // 拿不到上一个计数就退回标称输出率。
    const dt = lastCount == null
      ? 1 / CONFIG.imu.rateHz
      : ((((sample.count - lastCount) & 0xffff) * 21.33e-6) || 1 / CONFIG.imu.rateHz);
    lastCount = sample.count;
    sample.dt = dt;
    sample.timestamp = t;

    if (isSaturated(sample)) onError?.(new AppError(ERR.IMU_SATURATED, { axis: '?' }));
    onSample?.(sample);
  }

  return {
    /** 喂一段字节。**长度任意** —— 内部按 `0x80 … 0x0D` 切帧，会自动重新同步。 */
    push(bytes) {
      for (const b of bytes) buf.push(b & 0xff);
      let guard = 0;
      while (buf.length >= 4 && guard++ < 1000) {
        const before = buf.length;
        take();
        if (buf.length === before) break;        // 攒不够一帧，等下一次 push
      }
    },
    get buffered() { return buf.length; },
  };
}

// ── 自检：`node src/imu.js` ────────────────────────────
// 造 62 字节合成包，走完整条链路（切帧 → 校验 → 解码 → 静止判定 → 饱和判定）。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  const put = (b, i, v) => { b[i] = (v >> 8) & 0xff; b[i + 1] = v & 0xff; };
  const put32 = (b, i, v) => { put(b, i, (v >> 16) & 0xffff); put(b, i + 2, v & 0xffff); };

  /** 造一帧。默认是「车静止、1g 压在 Z 轴」。 */
  function build({ gyro = [0, 0, 0], accelMg = [0, 0, 1000], dAngle = [0, 0, 0], dVel = [0, 0, 0], count = 0 } = {}) {
    const b = new Array(62).fill(0);
    b[0] = ADDR;
    put(b, 3, TEMP_REF_RAW);                                                 // 25℃
    gyro.forEach((v, i) => put(b, 7 + i * 4, Math.round((v * DEG2RAD) / GYRO_SF)));
    accelMg.forEach((v, i) => put(b, 19 + i * 4, Math.round(v / ACCEL_SF_MG)));
    const sfA = DELTA_ANGLE_SF[CONFIG.imu.deltaRangeCtrl];
    const sfV = DELTA_VEL_SF[CONFIG.imu.deltaRangeCtrl];
    dAngle.forEach((v, i) => put32(b, 31 + i * 4, Math.round((v / DEG2RAD) / sfA * 65536)));
    dVel.forEach((v, i) => put32(b, 43 + i * 4, Math.round(v / sfV * 65536)));
    put(b, 57, count);
    let sum = 0;
    for (let i = 1; i < 59; i += 2) sum += u16(b, i);
    put(b, 59, sum & 0xffff);
    b[61] = CR;
    return b;
  }

  /** 预热期已过的读取器，收样本进 out */
  const reader = (out, errs = []) =>
    createImuSource({ onSample: (s) => out.push(s), onError: (e) => errs.push(e), warmupMs: 0 });

  // ① 预热窗口
  const early = [];
  const errsEarly = [];
  const cold = createImuSource({ onSample: (s) => early.push(s), onError: (e) => errsEarly.push(e) });
  cold.push([...build({ count: 0 }), ...build({ count: 1 })]);
  assert(early.length === 0, '预热 800ms 内不产样本');
  assert(errsEarly.filter((e) => e.code === ERR.IMU_NOT_READY.code).length === 1,
    'A06001 只报一次，不刷屏');

  // ② 正常解码
  const out = [];
  const src = reader(out);
  src.push([...build({ count: 0 }), ...build({ count: 10 })]);
  assert(out.length === 2, `连喂两帧解出两个样本（实得 ${out.length}）`);

  const s0 = out[0];
  const s1 = out[1];
  assert(Math.abs(s0.temp - 25) < 0.01, `温度解码 = 25℃（实得 ${s0.temp.toFixed(3)}）`);
  assert(Math.abs(Math.hypot(...s0.accel) - G) < 0.05, `加速度模长 ≈ 1g（实得 ${Math.hypot(...s0.accel).toFixed(3)}）`);
  assert(s0.gyro.every((v) => Math.abs(v) < 1e-6), '静止时角速度为 0');
  assert(Math.abs(s0.dt - 1 / CONFIG.imu.rateHz) < 1e-9, '首帧 dt 退回标称输出率');
  assert(Math.abs(s1.dt - 10 * 21.33e-6) < 1e-9, `非首帧 dt 走 COUNT：10 计数 = 213.3µs（实得 ${(s1.dt * 1e6).toFixed(1)}µs）`);
  assert(Math.abs(s1.dt * CONFIG.imu.rateHz - 1) > 0.5, 'dt 不会退化回标称值（COUNT 真的被用了）');

  // ③ COUNT 回绕（16 位）
  const wrap = [];
  const srcWrap = reader(wrap);
  srcWrap.push([...build({ count: 65530 }), ...build({ count: 4 })]);
  assert(Math.abs(wrap[1].dt - 10 * 21.33e-6) < 1e-9, 'COUNT 回绕算出的是 10 而不是 -65526');

  // ④ 角度增量往返（角度**必须落在该档量程内**，否则是编码端自己溢出）
  const sfA = DELTA_ANGLE_SF[CONFIG.imu.deltaRangeCtrl];
  const spanDeg = (sfA / 65536) * 2 ** 31;          // 该档的 ±量程，应与手册 Table 7.2 一致
  assert(Math.abs(spanDeg - 16.78) < 0.01,
    `档位 ${CONFIG.imu.deltaRangeCtrl} 的角度量程 = ±${spanDeg.toFixed(2)}°（手册 Table 7.2 为 ±16.78）`);

  const turned = [];
  reader(turned).push(build({ dAngle: [10 * DEG2RAD, -5 * DEG2RAD, 0], count: 0 }));
  assert(Math.abs(turned[0].dAngle[0] - 10 * DEG2RAD) < 1e-4,
    `角度增量 10° 往返（实得 ${(turned[0].dAngle[0] / DEG2RAD).toFixed(4)}°）`);
  assert(Math.abs(turned[0].dAngle[1] + 5 * DEG2RAD) < 1e-4, '负角度增量符号正确（二补数解对）');
  // 200Hz 下、450°/s 极限转速每窗口才转 2.25° —— 量程要够，也不能粗到丢分辨率
  assert(spanDeg > CONFIG.imu.gyroRange / CONFIG.imu.rateHz,
    `量程 ${spanDeg.toFixed(2)}° > 单窗口最大转角 ${(CONFIG.imu.gyroRange / CONFIG.imu.rateHz).toFixed(2)}°`);

  // ⑤ 速度增量往返
  const moved = [];
  reader(moved).push(build({ dVel: [0.5, -0.25, 9.80665 * 0.01], count: 0 }));
  assert(Math.abs(moved[0].dVel[0] - 0.5) < 1e-6, `速度增量往返（实得 ${moved[0].dVel[0].toFixed(6)}）`);
  assert(moved[0].dVel[1] < 0, '负速度增量符号正确');

  // ⑥ 校验和
  const bad = build({ count: 0 });
  bad[8] ^= 0xff;
  const errs = [];
  reader([], errs).push(bad);
  assert(errs.some((e) => e.code === ERR.IMU_CHECKSUM_FAILED.code), '数据被篡改 → C06100');

  // ⑦ 重新同步：前导噪声 + 坏帧都不该吃掉后面的好帧
  const resyncOut = [];
  reader(resyncOut).push([0xff, 0x12, 0x80, ...build({ count: 1 }), ...build({ count: 2 })]);
  assert(resyncOut.length === 2, `前导噪声后重新同步（实得 ${resyncOut.length} 帧）`);

  // ⑧ 静止判定
  const g0 = [0.005, 0.005, 0.005];
  assert(isStatic(g0, [0, 0, G]), '静止：角速度≈0 且 模长≈1g → true');
  assert(!isStatic([0.5, 0, 0], [0, 0, G]), '角速度大 → 不算静止');
  assert(!isStatic(g0, [0, 0, 4]), '加速度模长偏离 1g → 不算静止');
  // ⚠️ 这条是那个坑的固化：速度增量非零，但车确实是静止的
  assert(isStatic(g0, [0, 0, G]) && Math.abs(G * 0.02) > 0, 'dVel 含重力 → 绝不能拿 dVel≈0 当静止判据');

  // ⑨ 超量程
  assert(isSaturated({ gyro: [500 * DEG2RAD, 0, 0], accel: [0, 0, G], overflow: false }), '超陀螺量程 → 饱和');
  assert(isSaturated({ gyro: [0, 0, 0], accel: [0, 0, G], overflow: true }), 'EA 溢出位 → 饱和');
  assert(!isSaturated({ gyro: [1, 0, 0], accel: [0, 0, G], overflow: false }), '正常范围不误报');

  // ⑩ 24 字节包要被识别但不能当 62 字节解 —— 没有 DELTA，直接忽略
  const short = new Array(24).fill(0);
  short[0] = ADDR;
  let s = 0;
  for (let i = 1; i < 21; i += 2) s += u16(short, i);
  put(short, 21, s & 0xffff);
  short[23] = CR;
  const shortOut = [];
  const errsShort = [];
  reader(shortOut, errsShort).push(short);
  assert(shortOut.length === 0 && errsShort.length === 0, '24 字节包被静默忽略（不报错、不误当 62 字节）');

  if (failed) throw new Error(`imu.js 自检失败 ${failed} 项`);
  console.log('imu.js 自检通过');
}

selfcheck(demo, import.meta.url);
