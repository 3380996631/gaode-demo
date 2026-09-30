/**
 * 本地历史（localStorage）。不认识 AMap / GPS / DOM。
 *
 * **只存输入**（地点 / 模式 / 策略），不存路线结果 —— 结果可从 API 重算，存了反而会过期。
 */
import { AppError, ERR } from './errors.js';

const KEY = 'gm.history.v1';     // 版本化，便于日后迁移
const MAX = 20;

/**
 * @typedef {Object} HistoryEntry
 * @property {string} id
 * @property {string} name        '起点 → 终点'，由 ui 侧生成
 * @property {'riding'|'driving'} mode
 * @property {number|string} [policy]
 * @property {{text:string, lnglat:number[]|null}[]} places
 * @property {number} createdAt   UTC 毫秒
 */

/** @returns {HistoryEntry[]} 读失败**返回空数组** —— 历史坏了不能拖垮整个页面 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    const err = new AppError(ERR.STORE_READ_FAILED, {}, e);
    err.detail = { ...err.detail, silent: true };   // 调用方按 silent 决定不弹提示
    console.warn(`[${err.code}] ${err.message}`, e);
    return [];
  }
}

/** 写入整份列表。配额满抛 B04102，其余失败 B04101。 */
export function saveHistory(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    const quota = e?.name === 'QuotaExceededError' || e?.code === 22;
    throw new AppError(quota ? ERR.STORE_QUOTA_EXCEEDED : ERR.STORE_WRITE_FAILED, {}, e);
  }
}

/** 加一条到队首，超出上限淘汰最旧。返回新列表。 */
export function addHistory(entry) {
  const list = [entry, ...loadHistory()].slice(0, MAX);
  saveHistory(list);
  return list;
}

export function removeHistory(id) {
  const list = loadHistory().filter((h) => h.id !== id);
  saveHistory(list);
  return list;
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    throw new AppError(ERR.STORE_WRITE_FAILED, {}, e);
  }
  return [];
}
