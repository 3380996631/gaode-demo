/**
 * 纯格式化。**只被展示侧调用** —— 服务层与归一结构一律是原始数值。
 * 无依赖。
 */

/** 距离：米 → '850 米' / '1.2 公里' */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(1)} 公里`;
}

/** 时长：秒 → '45 秒' / '32 分钟' / '1 小时 5 分' */
export function formatTime(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} 秒`;
  const h = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} 小时 ${min} 分` : `${min} 分钟`;
}

/** 速度：米/秒 → '11.3 km/h' */
export function formatSpeed(mps) {
  return Number.isFinite(mps) ? `${(mps * 3.6).toFixed(1)} km/h` : '—';
}

/** 坐标：数字数组 → '113.9345, 22.5312'（固定 5 位 ≈ 1 米） */
export function formatLngLat(p) {
  return p ? `${p[0].toFixed(5)}, ${p[1].toFixed(5)}` : '—';
}

/** 地址过长时截断，给小车屏幕用 */
export function truncate(s, n = 18) {
  return s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? '');
}
