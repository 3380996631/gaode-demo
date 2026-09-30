/**
 * 导出：归一结构 → 四种格式 + 下载。
 *
 * **归一结构的第二个消费者**（第一个是 `ui.js` 的 `renderPlan`）。
 * 新增一种格式 = 加一个 build 函数，**不碰任何取数逻辑**。
 *
 * ⚠️ **除 txt 外，全部必须转 WGS84。**
 *    GPX 与 GeoJSON 的标准坐标系是 WGS84（GeoJSON 依 RFC 7946 明确规定），
 *    高德返回的是 GCJ-02。直接写进去会得到一条整体平移几十到几百米的轨迹 ——
 *    文件完全合法、导入不报错，但**小车走的是错的路**。
 *    ⚠️ 反向：**地图显示必须保持 GCJ-02**，在地图上喂 WGS84 反而会偏。两条路是反的。
 *
 * 取数与序列化分离：本文件只读 `RouteResult` / `Place`，不请求、不认识 AMap。
 */
import { gcj02ToWgs84 } from './coord.js';
import { formatDistance, formatTime } from './format.js';
import { AppError, ERR } from './errors.js';
import { selfcheck } from './selfcheck.js';

/** @param {import('./plan.js').RouteResult} route */
const track = (route) => route.plans[0]?.segments.flatMap((s) => s.path) ?? [];
const steps = (route) => route.plans[0]?.segments.flatMap((s) => s.steps) ?? [];

const WGS = (p) => gcj02ToWgs84(p);
const r6 = (n) => Number(n.toFixed(6));         // ≈0.1 米，够且不糊

// ── txt：给人看，**不含坐标、不做转换** ────────────────

function buildTxt(route, places) {
  const L = [];
  L.push(`出行方式：${route.mode === 'riding' ? '骑行' : '驾车'}`);
  L.push(`总距离：${formatDistance(route.totalDistance)}`);
  L.push(`总耗时：${formatTime(route.totalTime)}`);
  if (route.warning) L.push(`⚠️ ${route.warning.msg}`);
  L.push('', '地点');
  places.forEach((p, i) => L.push(`  ${i + 1}. ${placeName(p, i, places.length)}`));
  L.push('', '分段说明');
  for (const seg of route.plans[0]?.segments ?? []) {
    L.push(`  ${seg.title}（${formatDistance(seg.distance)} / ${formatTime(seg.time)}）`);
    for (const s of seg.steps) L.push(`    · ${s.instruction}  [${formatDistance(s.distance)}]`);
  }
  return L.join('\n');
}

const placeName = (p, i, n) =>
  p.text?.trim() || `${i === 0 ? '起点' : i === n - 1 ? '终点' : `途经点 ${i}`}（无名称）`;

// ── GPX：户外设备 / QGIS，**WGS84** ────────────────────

function buildGpx(route, places) {
  const name = `guide-map ${route.mode}`;
  const wpt = places.map((p, i) =>
    `  <wpt lat="${r6(WGS(p.lnglat)[1])}" lon="${r6(WGS(p.lnglat)[0])}"><name>${esc(placeName(p, i, places.length))}</name></wpt>`);
  const pts = track(route).map((p) => {
    const [lng, lat] = WGS(p);
    return `      <trkpt lat="${r6(lat)}" lon="${r6(lng)}"/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="guide-map" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name></metadata>`,
    ...wpt,
    '  <trk>',
    `    <name>${esc(name)}</name>`,
    '    <trkseg>',
    ...pts,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ].join('\n');
}

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ── GeoJSON：通用 GIS，**WGS84**（RFC 7946） ───────────

function buildGeoJSON(route, places) {
  const line = track(route).map((p) => { const [lng, lat] = WGS(p); return [r6(lng), r6(lat)]; });
  return JSON.stringify({
    type: 'FeatureCollection',
    // RFC 7946 规定 GeoJSON 就是 WGS84，所以这里**不需要** crs 字段（写了反而过时）
    features: [
      {
        type: 'Feature',
        properties: { mode: route.mode, totalDistance: route.totalDistance, totalTime: route.totalTime },
        geometry: { type: 'LineString', coordinates: line },
      },
      ...places.map((p, i) => {
        const [lng, lat] = WGS(p.lnglat);
        return {
          type: 'Feature',
          properties: { seq: i + 1, name: placeName(p, i, places.length) },
          geometry: { type: 'Point', coordinates: [r6(lng), r6(lat)] },
        };
      }),
    ],
  }, null, 2);
}

// ── 机器 JSON：**给小车程序消费** ──────────────────────

function buildJson(route, places) {
  return JSON.stringify({
    schema: 'guide-map.route.v1',
    // ⚠️ 必须写明 —— 这是给机器读的文件，坐标系不能靠约定，要靠自描述。
    //    小车程序拿到就能自己判断要不要转换。
    crs: 'WGS84',
    mode: route.mode,
    totalDistance: route.totalDistance,
    totalTime: route.totalTime,
    waypoints: places.map((p, i) => {
      const [lng, lat] = WGS(p.lnglat);
      return { seq: i + 1, lng: r6(lng), lat: r6(lat), name: placeName(p, i, places.length) };
    }),
    track: track(route).map((p) => { const [lng, lat] = WGS(p); return [r6(lng), r6(lat)]; }),
    steps: steps(route).map((s, i) => ({ seq: i + 1, instruction: s.instruction, distance: s.distance })),
  }, null, 2);
}

// ── 出口 ──────────────────────────────────────────────

export const FORMATS = {
  txt:     { ext: 'txt',     mime: 'text/plain;charset=utf-8',        build: buildTxt },
  gpx:     { ext: 'gpx',     mime: 'application/gpx+xml;charset=utf-8', build: buildGpx },
  geojson: { ext: 'geojson', mime: 'application/geo+json;charset=utf-8', build: buildGeoJSON },
  json:    { ext: 'json',    mime: 'application/json;charset=utf-8',  build: buildJson },
};

/**
 * @param {import('./plan.js').RouteResult} route
 * @param {import('./plan.js').Place[]} places
 * @param {keyof typeof FORMATS} format
 * @returns {{text:string, filename:string, mime:string}}
 */
export function serialize(route, places, format) {
  const f = FORMATS[format];
  if (!f) throw new AppError(ERR.EXPORT_FORMAT_UNKNOWN, { format });
  return {
    text: f.build(route, places),
    mime: f.mime,
    filename: `guide-map-${route.mode}-${stamp()}.${f.ext}`,
  };
}

/** 序列化 + 下载，一步到位。四种格式**共用同一个下载机制**。 */
export function exportRoute(route, places, format) {
  download(serialize(route, places, format));
}

/** Blob → objectURL → <a download> → revoke。零依赖。 */
export function download({ text, filename, mime }) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 立刻 revoke 会让 Firefox 拿不到内容；下一个宏任务再放
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 2026-09-30_1423 —— 文件名里不能有冒号 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── 自检：`node src/export.js` ────────────────────────────
// 只跑纯序列化那半 —— download() 碰 DOM，在 node 里跑不了。
function demo() {
  let failed = 0;
  const assert = (ok, msg) => {
    if (ok) { console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); failed++; }
  };

  const A = [114.062294, 22.540383];      // GCJ-02（跟高德给的一样）
  const B = [114.063114, 22.540383];
  const route = {
    mode: 'driving', totalDistance: 7300, totalTime: 960,
    plans: [{ index: 0, distance: 7300, time: 960, segments: [{
      title: '第 1 段：起 → 终', distance: 7300, time: 960,
      path: [A, B],
      steps: [{ instruction: '沿福中三路行驶300米右转', distance: 300 }],
    }] }],
  };
  const places = [
    { text: '深圳北站', lnglat: A },
    { text: '<危险&名称>', lnglat: B },     // 故意带 XML/JSON 元字符
  ];

  // ① txt：不能出现坐标数字，也不能出现「°」
  const txt = serialize(route, places, 'txt').text;
  assert(txt.includes('驾车') && txt.includes('7.3 公里') && txt.includes('16 分钟'), 'txt 有人看的距离与耗时');
  assert(txt.includes('沿福中三路行驶300米右转'), 'txt 含逐段文字说明');
  assert(!/\d{2,3}\.\d{4}/.test(txt), 'txt **不含坐标**（没做转换，也不该有）');

  for (const fmt of ['gpx', 'geojson', 'json']) {
    assert(serialize(route, places, fmt).filename.endsWith(`.${fmt}`), `${fmt} 扩展名正确`);
  }

  // ② ⚠️ 坐标必须已经转成 WGS84 —— 拿 GCJ-02 直接写会整体平移，且文件合法不报错
  const wp = JSON.parse(serialize(route, places, 'json').text).waypoints[0];
  assert(wp.lng < A[0] && Math.abs(wp.lng - A[0]) < 0.01,
    `机器 JSON 的航点已转 WGS84（${wp.lng} < GCJ 的 ${A[0]}）`);
  // 容差取 1e-6：文件里是 r6 舍入过的（≈0.1 米），用 1e-9 比的是舍入误差不是转换
  assert(Math.abs(wp.lng - gcj02ToWgs84(A)[0]) < 1e-6 && Math.abs(wp.lat - gcj02ToWgs84(A)[1]) < 1e-6,
    '转出来的正是 gcj02ToWgs84 的结果');

  const gpxLng = Number(serialize(route, places, 'gpx').text.match(/<wpt lat="([\d.]+)" lon="([\d.]+)"/)[2]);
  assert(Math.abs(gpxLng - wp.lng) < 1e-6, 'GPX 与机器 JSON 转的是同一个坐标系');

  // ③ 机器 JSON 必须自描述坐标系
  const j = JSON.parse(serialize(route, places, 'json').text);
  assert(j.schema === 'guide-map.route.v1' && j.crs === 'WGS84', '机器 JSON 带 schema 与 crs');
  assert(j.track.length === 2 && j.waypoints.length === 2 && j.steps.length === 1, '机器 JSON 三段数据齐全');

  // ④ GeoJSON 走 RFC 7946：经纬度顺序是 [lng, lat]，且不需要 crs 字段
  const g = JSON.parse(serialize(route, places, 'geojson').text);
  assert(g.type === 'FeatureCollection' && !g.crs, 'GeoJSON 不带过时的 crs 字段');
  assert(g.features[0].geometry.type === 'LineString' && g.features[0].geometry.coordinates.length === 2, 'GeoJSON 有 LineString');
  assert(Math.abs(g.features[0].geometry.coordinates[0][0] - wp.lng) < 1e-6, 'GeoJSON 坐标与机器 JSON 一致');

  // ⑤ 元字符必须被转义，否则 GPX 是个坏 XML
  const gpx = serialize(route, places, 'gpx').text;
  assert(gpx.includes('&lt;危险&amp;名称&gt;') && !gpx.includes('<危险'), 'GPX 地名转义了 < & >');

  assert(serialize(route, places, 'txt').mime.startsWith('text/plain'), 'mime 类型正确');

  if (failed) throw new Error(`export.js 自检失败 ${failed} 项`);
  console.log('export.js 自检通过');
}

selfcheck(demo, import.meta.url);
