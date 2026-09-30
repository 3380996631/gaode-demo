/**
 * 视图层：DOM 渲染 + 事件绑定。
 *
 * **不直接调用 AMap，也不直接调用 GPS**，更不写任何业务判断 ——
 * 「哪条路线最好」「要发几个请求」都在 `plan.js` 里算好，这里只负责画出来。
 *
 * 它拥有的是**视图状态**：`places` 数组、当前选中行、出行方式。
 * 路线、对比、导航会话归 `main.js`。
 */
import { CONFIG } from '../config.js';
import { estimateRequests } from './plan.js';
import { formatDistance, formatTime } from './format.js';

const qs = (sel) => document.querySelector(sel);

/** `places` 是**这一个数组**，没有「两点模式」这条代码路径 —— 两点只是它的长度 2。 */
const S = {
  places: [{ text: '', lnglat: null }, { text: '', lnglat: null }],
  mode: 'driving',
  active: null,
  handlers: {},
  lastResult: null,       // 导出要它，避免再算一次
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 初始化 ────────────────────────────────────────────

/**
 * @param {Object} handlers 全部由 main.js 提供；ui.js 只负责「什么时候叫」
 * @param {()=>void} handlers.plan  @param {()=>void} handlers.compare
 * @param {()=>void} handlers.nav   @param {()=>void} handlers.stopNav
 * @param {(fmt:string)=>void} handlers.exportAs
 * @param {(i:number)=>void} handlers.locate   GPS 定位到第 i 行
 * @param {(i:number)=>void} handlers.pick     进入地图选点，目标第 i 行
 * @param {(i:number)=>void} handlers.dirty    地点被改（拖拽/改字），旧路线过期
 * @param {(i:number)=>void} handlers.pickColumn 对比表「画它」
 * @param {(id:string)=>void} handlers.historyLoad
 * @param {(id:string)=>void} handlers.historyDelete
 */
export function initUI(handlers) {
  S.handlers = handlers;

  // 事件委托：一个监听器管所有行。行是整块重渲染的，逐行绑必然漏监听器。
  qs('#places').addEventListener('click', onPlacesClick);
  qs('#places').addEventListener('input', onPlacesInput);
  qs('#compare-table').addEventListener('click', onCompareClick);
  qs('#history').addEventListener('click', onHistoryClick);

  qs('#add-wpt').addEventListener('click', () => addWaypointAt(S.places.length - 1));
  qs('#plan').addEventListener('click', () => S.handlers.plan?.());
  qs('#compare').addEventListener('click', () => S.handlers.compare?.());
  qs('#nav').addEventListener('click', () => S.handlers.nav?.());
  qs('#stop-nav').addEventListener('click', () => S.handlers.stopNav?.());
  document.querySelectorAll('[data-export]').forEach((b) =>
    b.addEventListener('click', () => S.handlers.exportAs?.(b.dataset.export)));

  qs('#mode').addEventListener('change', (e) => {
    S.mode = e.target.value;                 // 切出行方式**不动 places**，行数与内容一律不变
    renderPlaceRows();
    S.handlers.dirty?.();
  });
  qs('#policy').addEventListener('change', () => S.handlers.dirty?.());

  renderPlaceRows();
}

// ── 读状态 ────────────────────────────────────────────

export const getPlaces = () => S.places;
export const getMode = () => S.mode;
export const getActive = () => S.active;
/** 骑行没有策略（`Riding` 只有 0/2，含义还有两份文档打架），所以只在驾车时取值 */
export const getPolicy = () => (S.mode === 'driving' ? qs('#policy').value || undefined : undefined);
export const getResult = () => S.lastResult;

// ── 改状态 ────────────────────────────────────────────

/** 地理编码回填坐标 —— 回填后**再规划不会再发编码请求**。 */
export function setPlaces(places) {
  S.places = places;
  renderPlaceRows();
}

/** 拖拽结束：只改本地坐标，**不发任何请求**（那会给每个拖过的点各烧一次配额）。 */
export function setPlaceLngLat(i, lnglat) {
  const p = S.places[i];
  if (!p) return;
  p.lnglat = lnglat;
  // 不回填逆地理编码的地址 —— 想看就点该行「选点」手动来一次
  p.text = `${lnglat[0].toFixed(5)}, ${lnglat[1].toFixed(5)}`;
  renderPlaceRows();
}

export function setActive(i) {
  S.active = i;
  renderPlaceRows();
}

/** 恢复历史时用。切出行方式**不动 places**。 */
export function setMode(mode) {
  S.mode = mode === 'riding' ? 'riding' : 'driving';
  qs('#mode').value = S.mode;
  renderPlaceRows();
}

/** @param {number|string} [v] 历史里存的策略（骑行时没有，传 undefined 即忽略） */
export function setPolicy(v) {
  if (v != null) qs('#policy').value = v;
}

/** 先改数组，再修正 active —— 否则点地图的地址会填进错误的行（不报错，只是填错地方）。 */
export function addWaypointAt(i) {
  S.places.splice(i, 0, { text: '', lnglat: null });
  if (S.active != null && S.active >= i) S.active++;
  renderPlaceRows();
}

export function removePlaceAt(i) {
  if (i <= 0 || i >= S.places.length - 1) return;   // 首尾不可删，places 恒 ≥ 2
  S.places.splice(i, 1);
  if (S.active === i) S.active = null;
  else if (S.active != null && S.active > i) S.active--;
  renderPlaceRows();
}

// ── 渲染 ──────────────────────────────────────────────

export function renderPlaceRows() {
  const n = S.places.length;
  qs('#places').innerHTML = S.places.map((p, i) => {
    const kind = i === 0 ? '起点' : i === n - 1 ? '终点' : '途经点';
    return `<div class="place${S.active === i ? ' active' : ''}" data-i="${i}">
      <span class="seq">${i + 1}</span>
      <span class="kind">${kind}</span>
      <input class="text" data-i="${i}" value="${esc(p.text)}" placeholder="输入地名，或用地图选点">
      ${i === 0 ? '<button data-act="locate" data-i="0">定位</button>' : ''}
      <button data-act="pick" data-i="${i}">选点</button>
      ${i > 0 && i < n - 1 ? `<button data-act="del" data-i="${i}">✕</button>` : ''}
    </div>`;
  }).join('');

  // 预估请求数直接写在按钮上 —— 按钮文案与 A00105 的上限用的是同一个数
  const seg = Math.max(0, n - 1);
  qs('#plan').textContent = `开始规划 (${seg})`;
  qs('#compare').textContent = `方案对比 (${estimateRequests(S.places, CONFIG.compareAxes)})`;
  qs('#policy-wrap').hidden = S.mode !== 'driving';
}

/** 骑行与驾车**共用同一个渲染函数** —— 归一结构只有一个形状。 */
export function renderPlan(route) {
  S.lastResult = route;
  const warn = route.warning ? ' · 部分路段缺失' : '';
  qs('#summary').innerHTML =
    `<span class="big">${formatDistance(route.totalDistance)}</span>
     <span class="sub">${formatTime(route.totalTime)} · ${route.mode === 'riding' ? '骑行' : '驾车'}${warn}</span>`;

  // 屏幕文字列表与导出读的是**同一份 `steps` 数据**，不可能对不上
  qs('#steps').innerHTML = (route.plans[0]?.segments ?? []).map((seg) => `
    <h3>${esc(seg.title)}</h3>
    <ul>${seg.steps.map((s) =>
      `<li>${esc(s.instruction)} <small>[${formatDistance(s.distance)}]</small></li>`).join('')}</ul>`).join('');
}

export function clearResult() {
  S.lastResult = null;
  qs('#summary').innerHTML = '';
  qs('#steps').innerHTML = '';
  qs('#compare-table').hidden = true;
  setProgress(null);
}

export function renderComparison(cmp) {
  const { entries, bestTimeIndex, bestDistanceIndex } = cmp;

  const rows = [
    ['总耗时', bestTimeIndex, (e) => formatTime(e.result.totalTime)],
    ['总距离', bestDistanceIndex, (e) => formatDistance(e.result.totalDistance)],
  ];

  qs('#compare-table').innerHTML = `<table>
    <tr><th></th>${entries.map((e) => `<th>${esc(e.label)}</th>`).join('')}</tr>
    ${rows.map(([name, best, get]) => `<tr><td>${name}</td>${entries.map((e, i) =>
      e.result ? `<td class="${i === best ? 'best' : ''}">${i === best ? '★ ' : ''}${get(e)}</td>`
               : '<td class="none">无结果</td>').join('')}</tr>`).join('')}
    <tr><td></td>${entries.map((e, i) =>
      `<td><button data-pick="${i}" ${e.result ? '' : 'disabled'}>画它</button></td>`).join('')}</tr>
  </table>`;
  qs('#compare-table').hidden = false;
}

export function renderHistory(list) {
  qs('#history').innerHTML = list.length
    ? `<h3>历史</h3>${list.map((h) => `<div class="item">
        <b data-load="${esc(h.id)}">${esc(h.name)}</b>
        <small>${h.mode === 'riding' ? '骑行' : '驾车'}</small>
        <button data-del="${esc(h.id)}">✕</button>
      </div>`).join('')}`
    : '';
}

// ── 状态栏：错误码唯一的落脚处 ─────────────────────────

/** @param {'info'|'ok'|'warn'|'error'} [level] */
export function setStatus(text, level = 'info') {
  const p = qs('#status');
  p.textContent = text ?? '';
  p.className = level === 'info' ? '' : level;
}

/** ⚠️ 只认 `err.code` 做分支，**不解析 message 文本** —— message 给人看，code 给程序看。 */
export function showError(err) {
  if (!err) return;
  setStatus(`[${err.code ?? '?????'}] ${err.message ?? err}`, err.code?.[0] === 'A' ? 'warn' : 'error');
}

/** @param {number|null} ratio 0~1，null = 收起进度条 */
export function setProgress(ratio) {
  qs('#progress').hidden = ratio == null;
  qs('#progress-fill').style.width = ratio == null ? '0' : `${Math.round(ratio * 100)}%`;
}

export function setNavigating(on) {
  qs('#nav').hidden = on;
  qs('#stop-nav').hidden = !on;
  if (!on) setProgress(null);
}

// ── 事件 ──────────────────────────────────────────────

function rowOf(elm) {
  const row = elm.closest('.place');
  return row ? Number(row.dataset.i) : null;
}

function onPlacesClick(e) {
  const btn = e.target.closest('button');
  const i = rowOf(e.target);
  if (i == null) return;

  if (!btn) { setActive(i); return; }                 // 点整行 = 选中它，地图点击就填这里
  const act = btn.dataset.act;
  if (act === 'del') removePlaceAt(i);
  else if (act === 'pick') { setActive(i); S.handlers.pick?.(i); }
  else if (act === 'locate') S.handlers.locate?.(i);
}

function onPlacesInput(e) {
  const el = e.target;
  if (!el.matches('input.text')) return;
  const p = S.places[Number(el.dataset.i)];
  if (!p) return;
  p.text = el.value;
  // ⚠️ 改了字就把旧坐标丢掉。留着的话 `resolvePlaces` 会跳过地理编码，
  //    于是用户改了地名、规划结果却还是老地方 —— 不报错的错。
  p.lnglat = null;
  S.handlers.dirty?.();
}

function onCompareClick(e) {
  const b = e.target.closest('[data-pick]');
  if (b) S.handlers.pickColumn?.(Number(b.dataset.pick));
}

function onHistoryClick(e) {
  const load = e.target.closest('[data-load]');
  if (load) return S.handlers.historyLoad?.(load.dataset.load);
  const del = e.target.closest('[data-del]');
  if (del) S.handlers.historyDelete?.(del.dataset.del);
}
