/**
 * GPS（NEO-M10）读取与质量门限。**全应用唯一碰 GPS 的地方。**
 *
 * 不碰 DOM，不认识 AMap，**不做融合** —— 融合在 `fuse.js`。
 *
 * ⚠️ 本文件产出的 `Fix.source` 恒为 `'gps'`，坐标**已经转成 GCJ-02**。
 *    上层永远不需要自己判断该用哪个坐标系（`lnglat` 给显示、`rawLnglat` 给导出）。
 */
import { CONFIG } from '../config.js';
import { AppError, ERR } from './errors.js';
import { wgs84ToGcj02 } from './coord.js';
import { selfcheck } from './selfcheck.js';

const KNOTS_TO_MPS = 0.514444;

// ── 单句解析 ──────────────────────────────────────────

/**
 * NMEA 单句 → `{type, fields}`。GGA/GSA/RMC **共用同一个分词与校验**。
 * @param {string} sentence 形如 `$GNRMC,123519,A,4807.038,N,...*6A`
 * @returns {{type:string, talker:string, fields:string[]}|{error:AppError}|null}
 *   null = 不是 NMEA 句（噪声行）；`{error}` = 校验失败
 */
export function parseNmea(sentence) {
  const s = String(sentence).trim();
  if (!s.startsWith('$') && !s.startsWith('!')) return null;
  const star = s.lastIndexOf('*');
  if (star < 0) return null;

  const body = s.slice(1, star);
  const given = parseInt(s.slice(star + 1, star + 3), 16);
  if (Number.isNaN(given)) return null;

  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  if (sum !== given) return { error: new AppError(ERR.NMEA_CHECKSUM_FAILED, { sentence: s }) };

  const [head, ...fields] = body.split(',');
  return { type: head.slice(2), talker: head.slice(0, 2), fields };
}

/** '2232.5858' + 'N' → 22.5431。经度是 dddmm.mmmm（3 位度），纬度是 ddmm.mmmm（2 位度）。 */
function dmToDeg(v, hemi) {
  if (!v) return NaN;
  const dot = v.indexOf('.');
  const degLen = dot < 0 ? v.length - 2 : dot - 2;
  const d = Number(v.slice(0, degLen)) + Number(v.slice(degLen)) / 60;
  return hemi === 'S' || hemi === 'W' ? -d : d;
}

const num = (v) => (v === '' || v == null ? NaN : Number(v));

/**
 * GGA 字段：0 时刻 / 1 纬度 / 2 N-S / 3 经度 / 4 E-W / 5 **定位状态** / 6 卫星数 / 7 HDOP
 * ⚠️ 索引整体比 RMC 早一位 —— 纬度在 f[1] 而不是 f[2]。错一位的后果是
 *    `dmToDeg('N', …)` 得到 NaN，整个 Fix 被静默丢弃（现象：怎么都定不上位）。
 */
function parseGga(f) {
  return {
    utc: f[0],
    lat: dmToDeg(f[1], f[2]),
    lng: dmToDeg(f[3], f[4]),
    fixQuality: Number(f[5]),      // 0 未定位 / 1 SPS / 2 GNSS SPS / 3 PPS
    sats: num(f[6]),
    hdop: num(f[7]),
  };
}

/** GSA：**模式 2 在第 2 字段**（1 未定位 / 2 2D / 3 3D） */
function parseGsa(f) {
  return {
    mode1: f[0],                   // M 手动 / A 自动
    mode2: Number(f[1]),
    sats: f.slice(2, 14).filter((x) => x !== '').length,
    pdop: num(f[14]),
    hdop: num(f[15]),
    vdop: num(f[16]),
  };
}

/** RMC：**使用状态在第 2 字段、定位模式在末字段**，速度是节、航向是度 */
function parseRmc(f) {
  return {
    utc: f[0],
    status: f[1],                  // A 已使用 / V 未使用
    lat: dmToDeg(f[2], f[3]),
    lng: dmToDeg(f[4], f[5]),
    speedKnots: num(f[6]),
    course: num(f[7]),
    mode: f[11],                   // A 自动 / N 未定位 / D DGPS / E DR
  };
}

// ── 三句合一 ──────────────────────────────────────────

/** 定位类型：RMC 的 DR 最优先（它意味着正在推算），其次 DGPS，最后看 GGA */
function qualityOf(gga, rmc) {
  if (rmc?.mode === 'E') return 'dr';
  if (rmc?.mode === 'D') return 'dgps';
  if (gga?.fixQuality === 3) return 'pps';
  if (gga?.fixQuality === 2) return 'gnss';
  return 'sps';
}

/**
 * 把最近一次 GGA / GSA / RMC 合成一个 `Fix`。
 *
 * ⚠️ **三处的状态字段必须全部检查**，少查一个的后果是：小车在未定位时就开始导航，
 *    起点是上一次的残留坐标或 0,0（几内亚湾），而且**不报错**。
 *
 * @returns {Object|null} null = 当前不可用（未定位 / 数据未使用）
 */
export function combineFix({ gga, gsa, rmc }) {
  if (!gga && !rmc) return null;

  // RMC：使用状态 + 定位模式
  if (rmc && rmc.status !== 'A') return null;
  if (rmc && rmc.mode === 'N') return null;
  // GGA：定位状态 0 = 未定位或不可用
  if (gga && !(gga.fixQuality >= 1)) return null;
  // GSA：模式 2 为 1 = 未定位（2D/3D 都可用，只做平面导航）
  if (gsa && gsa.mode2 === 1) return null;

  const lat = gga?.lat ?? rmc?.lat;
  const lng = gga?.lng ?? rmc?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const rawLnglat = [lng, lat];                       // WGS84
  return {
    lnglat: wgs84ToGcj02(rawLnglat),                  // ⚠️ 进来就转好，上层不用管
    rawLnglat,
    hdop: gga?.hdop ?? gsa?.hdop ?? NaN,
    sats: gga?.sats ?? gsa?.sats ?? NaN,
    speed: (rmc?.speedKnots ?? NaN) * KNOTS_TO_MPS,   // 米/秒（RMC 第 7 字段是节）
    course: rmc?.course ?? NaN,                       // 度（RMC 第 8 字段）
    quality: qualityOf(gga, rmc),
    source: 'gps',
    utc: gga?.utc ?? rmc?.utc ?? '',
    timestamp: Date.now(),
  };
}

// ── 质量门限 ──────────────────────────────────────────

/**
 * 这个点能不能参与**偏航判定**。
 *
 * 不满足的点**仍然可以显示**（让用户看到自己在哪），只是不参与判定 ——
 * 定位差的时候，它说你偏航了，多半是它自己在飘。
 */
export function isFixUsable(fix) {
  if (!fix) return false;
  if (fix.quality === 'dr') return false;                    // 推算的精度差，不用于偏航判定
  if (!(fix.hdop > 0) || fix.hdop > CONFIG.gps.hdopMax) return false;
  if (!(fix.sats >= CONFIG.gps.satsMin)) return false;
  return true;
}

// ── 流读取器 ──────────────────────────────────────────

/**
 * 吃字节流或文本行，吐 `Fix`。
 *
 * 三种语句各自到达，**只在带位置的那两种（GGA/RMC）到达时才尝试合成**，
 * 并用 utc+坐标去重 —— 否则 5Hz 下 GGA 和 RMC 会各产一个点，一半是重复的。
 *
 * @param {Object} o
 * @param {(fix:object)=>void} o.onFix
 * @param {(e:Error)=>void} [o.onError]
 */
export function createNmeaSource({ onFix, onError }) {
  const latest = { gga: null, gsa: null, rmc: null };
  let text = '';
  let lastKey = null;
  let lastHadSpeed = true;

  function feed(line) {
    const r = parseNmea(line);
    if (!r) return;
    if (r.error) { onError?.(r.error); return; }        // 坏句不中断，后续正常句照常解析

    switch (r.type) {
      case 'GGA': latest.gga = parseGga(r.fields); break;
      case 'GSA': latest.gsa = parseGsa(r.fields); break;
      case 'RMC': latest.rmc = parseRmc(r.fields); break;
      default: return;                                    // GSV / ZDA / TXT 与我们无关
    }
    if (r.type === 'GSA') return;                         // GSA 不带位置，不触发合成

    // ⚠️ 两个带位置的语句**必须同一个历元**才能合成。GGA 先到，此时 latest.rmc
    //    还停在**上一历元** —— 直接合成会得到「新位置 + 旧速度/航向」，而且下一句
    //    RMC 到达时被去重吞掉，于是速度**永远慢一拍**，第一帧干脆是 NaN。
    //    不报错，只是速度和航向悄悄错位。等到两者对上再合。
    if (latest.gga && latest.rmc && latest.gga.utc !== latest.rmc.utc) return;

    const fix = combineFix(latest);
    if (!fix) return;

    // 一个历元只产一次 —— 除非**上联那帧是残缺的**（只有 GGA、还没有速度/航向），
    // 那本历元的 RMC 补到位时让它再产一次，算升级不算重复。
    // 冷启动第一帧必然走这条路：RMC 还没来过。不补的话速度和航向就一直是 NaN。
    const key = `${fix.utc}|${fix.rawLnglat[0]},${fix.rawLnglat[1]}`;
    if (key === lastKey && lastHadSpeed) return;
    lastKey = key;
    lastHadSpeed = Number.isFinite(fix.speed);
    onFix(fix);
  }

  return {
    /** @param {string|Uint8Array} chunk */
    push(chunk) {
      text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      const lines = text.split(/\r?\n/);
      text = lines.pop() ?? '';                          // 最后一段可能是半句，留着
      for (const line of lines) if (line) feed(line);
    },
  };
}

// ── 自检：`node src/gps.js` ────────────────────────────
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };
  const near = (a, b, tol) => Math.abs(a - b) < tol;

  /** 给句子正文补上正确的校验和 —— 测试不该依赖手抄的星号后两位 */
  const withSum = (body) => {
    let s = 0;
    for (let i = 0; i < body.length; i++) s ^= body.charCodeAt(i);
    return `$${body}*${s.toString(16).toUpperCase().padStart(2, '0')}`;
  };

  // 深圳，静止/低速：22°32.5858′N 114°03.4728′E，速度 6.082 节，航向 173.29°
  const gga = withSum('GNGGA,123519.00,2232.5858,N,11403.4728,E,1,08,0.9,545.4,M,46.9,M,,');
  const gsa = withSum('GNGSA,A,3,04,05,09,12,24,25,29,31,,,,,1.8,1.0,1.5');
  const rmc = withSum('GNRMC,123519.00,A,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,A');

  // ① 分词与校验
  const p = parseNmea(rmc);
  assert(p.type === 'RMC' && p.talker === 'GN', '解析出 RMC 句与 talker');
  assert(parseNmea('$GNRMC,bogus*00').error?.code === ERR.NMEA_CHECKSUM_FAILED.code, '坏校验 → C05100');
  assert(parseNmea('随便一行噪声') === null, '非 NMEA 行返回 null（不报错）');
  assert(parseNmea('$GNRMC,123519.00,A,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,A') === null,
    '缺 * 校验字段的行被忽略');

  // ② 度数换算
  const fix = combineFix({
    gga: parseGga(parseNmea(gga).fields),
    gsa: parseGsa(parseNmea(gsa).fields),
    rmc: parseRmc(p.fields),
  });
  assert(fix, 'GGA + GSA + RMC 全正常时应产出 Fix');
  assert(near(fix.rawLnglat[0], 114.05788, 1e-4), `经度 dddmm.mmmm 换算（实得 ${fix.rawLnglat[0].toFixed(5)}）`);
  assert(near(fix.rawLnglat[1], 22.54310, 1e-4), `纬度 ddmm.mmmm 换算（实得 ${fix.rawLnglat[1].toFixed(5)}）`);

  // ③ 速度与航向（plan 验证表里点名的那条）
  assert(near(fix.speed, 3.13, 0.01), `RMC 6.082 节 → ${fix.speed.toFixed(3)} 米/秒`);
  assert(near(fix.course, 173.29, 0.01), `RMC 航向 ${fix.course} 度`);
  assert(fix.quality === 'sps' && fix.source === 'gps', '定位类型 sps，来源 gps');

  // ④ 坐标必须已经转成 GCJ-02（不转就是恒定偏移，且不报错）
  const dLng = fix.lnglat[0] - fix.rawLnglat[0];
  assert(near(dLng, 0.0044, 0.002), `lnglat 已转 GCJ-02（偏移 ${dLng.toFixed(5)}°，不是 0）`);
  assert(fix.lnglat[0] !== fix.rawLnglat[0] || fix.lnglat[1] !== fix.rawLnglat[1], 'lnglat ≠ rawLnglat');

  // ⑤ 三处状态字段，逐个必须被消费
  const mk = (over) => combineFix({
    gga: parseGga(parseNmea(over.gga ?? gga).fields),
    gsa: parseGsa(parseNmea(over.gsa ?? gsa).fields),
    rmc: parseRmc(parseNmea(over.rmc ?? rmc).fields),
  });
  assert(mk({}) !== null, '全正常 → 有 Fix');
  assert(mk({ gga: withSum('GNGGA,123519.00,2232.5858,N,11403.4728,E,0,08,0.9,545.4,M,46.9,M,,') }) === null,
    'GGA 定位状态 0 → 丢弃（未定位时不进入导航）');
  assert(mk({ gsa: withSum('GNGSA,A,1,04,05,09,12,24,25,29,31,,,,,1.8,1.0,1.5') }) === null,
    'GSA 模式2 = 1（未定位）→ 丢弃');
  assert(mk({ rmc: withSum('GNRMC,123519.00,V,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,A') }) === null,
    'RMC 使用状态 V → 丢弃');
  assert(mk({ rmc: withSum('GNRMC,123519.00,A,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,N') }) === null,
    'RMC 定位模式 N → 丢弃');

  // ⑥ 各定位类型
  assert(mk({ rmc: withSum('GNRMC,123519.00,A,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,D') }).quality === 'dgps',
    'RMC 模式 D → dgps');
  assert(mk({ rmc: withSum('GNRMC,123519.00,A,2232.5858,N,11403.4728,E,6.082,173.29,230394,003.1,W,E') }).quality === 'dr',
    'RMC 模式 E → dr（精度差，不用于偏航判定）');
  assert(mk({ gga: withSum('GNGGA,123519.00,2232.5858,N,11403.4728,E,3,08,0.9,545.4,M,46.9,M,,') }).quality === 'pps',
    'GGA 状态 3 → pps');
  // GSA 2D 可用（只做平面导航）
  assert(mk({ gsa: withSum('GNGSA,A,2,04,05,09,12,,,,,,,,1.8,1.0,1.5') }) !== null, 'GSA 2D 定位仍可用');

  // ⑦ 质量门限
  assert(isFixUsable(mk({})), 'HDOP 0.9 / 8 星 → 可用');
  assert(!isFixUsable(mk({ gga: withSum('GNGGA,123519.00,2232.5858,N,11403.4728,E,1,08,3.5,545.4,M,46.9,M,,') })),
    'HDOP 3.5 超门限 → 不参与偏航判定');
  assert(!isFixUsable(mk({ gga: withSum('GNGGA,123519.00,2232.5858,N,11403.4728,E,1,04,0.9,545.4,M,46.9,M,,') })),
    '只有 4 颗星 → 不参与偏航判定');

  // ⑧ 流读取器：分片到达、一个历元不产两个**位置**
  const fixes = [];
  const errs = [];
  const src = createNmeaSource({ onFix: (f) => fixes.push(f), onError: (e) => errs.push(e) });
  src.push([gga, gsa, rmc].join('\r\n') + '\r\n');

  // ⚠️ 冷启动第一个历元必然「先残缺、后补全」：GGA 到的时候 RMC 还没来过，
  //    所以先产一帧只有位置没有速度的。**断言的是位置不重复，不是只调一次 onFix。**
  assert(fixes.length === 2, `冷启动历元产 2 帧：残缺帧 + 补全帧（实得 ${fixes.length}）`);
  assert(fixes[0].rawLnglat.join() === fixes[1].rawLnglat.join(), '两帧是同一个位置（一个历元，不是两个点）');
  assert(!Number.isFinite(fixes[0].speed), '第一帧只有 GGA → 速度未知（NaN，不是伪造的 0）');

  // ⚠️ 补全帧必须是**同一个历元**的合成，不是「新 GGA + 上一历元 RMC」。
  //    合错的现象：速度/航向永远慢一拍，第一帧是 NaN —— 不报错，只是悄悄错位。
  assert(near(fixes[1].speed, 3.13, 0.01),
    `补全帧用的是同历元 RMC（speed=${fixes[1].speed.toFixed(3)}，不是 NaN 也不是上一帧的值）`);
  assert(near(fixes[1].course, 173.29, 0.01), '航向同样来自同历元');

  // 跨历元：先来一句新 GGA，此时 RMC 还停在上一历元 —— 不许合成
  const fixes15 = [];
  const src15 = createNmeaSource({ onFix: (f) => fixes15.push(f), onError: () => {} });
  src15.push([gga, gsa, rmc].join('\r\n') + '\r\n');
  const n = fixes15.length;
  src15.push(withSum('GNGGA,123520.00,2232.5858,N,11403.4728,E,1,08,0.9,545.4,M,46.9,M,,') + '\r\n');
  assert(fixes15.length === n, '新 GGA 到了但 RMC 还是上一历元 → 一句都不产');
  src15.push(withSum('GNRMC,123520.00,A,2232.5858,N,11403.4728,E,0.5,180.00,230394,003.1,W,A') + '\r\n');
  assert(fixes15.length === n + 1, 'RMC 跟上后补合一次');
  assert(near(fixes15.at(-1).speed, 0.5 * 0.514444, 0.001),
    `新历元帧拿到的是本历元速度（${fixes15.at(-1).speed.toFixed(3)} 米/秒），不是上一帧的 3.13`);

  // 半句要跨 push 拼起来
  const fixes2 = [];
  const src2 = createNmeaSource({ onFix: (f) => fixes2.push(f), onError: () => {} });
  src2.push(gga.slice(0, 20));
  assert(fixes2.length === 0, '半句不产 Fix');
  src2.push(gga.slice(20) + '\n' + gsa + '\n' + rmc + '\n');
  assert(fixes2.length === 2 && near(fixes2.at(-1).rawLnglat[1], 22.5431, 1e-4),
    '跨 chunk 的句子被正确拼接（拼出来的历元照常合成）');

  // 坏句不中断
  const fixes3 = [];
  const errs3 = [];
  const src3 = createNmeaSource({ onFix: (f) => fixes3.push(f), onError: (e) => errs3.push(e) });
  src3.push('$GNGGA,broken*00\n' + gga + '\n' + gsa + '\n' + rmc + '\n');
  assert(errs3.length === 1 && errs3[0].code === ERR.NMEA_CHECKSUM_FAILED.code,
    `坏句报 C05100（实得 ${errs3[0]?.code}）`);
  assert(fixes3.length === 2 && near(fixes3.at(-1).speed, 3.13, 0.01),
    '坏句不中断，后续正常句照常解析出完整历元');

  // 未定位时不产 Fix（导航不会用残留坐标起步）
  const fixes4 = [];
  const src4 = createNmeaSource({ onFix: (f) => fixes4.push(f), onError: () => {} });
  src4.push(withSum('GNGGA,123519.00,,,,,0,00,,,M,,M,,') + '\n');
  assert(fixes4.length === 0, '未定位时（GGA 状态 0 且无坐标）不产 Fix → 界面显示 A05001');

  // ⑨ 美国经度是负的（W 半球）
  const us = withSum('GNRMC,123519.00,A,3747.0000,N,12225.0000,W,0.0,0.0,230394,,,A');
  const usFix = combineFix({ gga: null, gsa: null, rmc: parseRmc(parseNmea(us).fields) });
  assert(usFix.rawLnglat[0] < 0 && usFix.rawLnglat[1] > 0, 'W 半球经度为负、N 半球纬度为正');

  if (failed) throw new Error(`gps.js 自检失败 ${failed} 项`);
  console.log('gps.js 自检通过');
}

selfcheck(demo, import.meta.url);
