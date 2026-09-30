/**
 * 错误码：`<来源1位><业务域2位><编号3位>`，定长 6 位。例 `A00100`。
 *
 *   来源  A 用户端 —— 前端提示，不报警
 *         B 系统执行 —— 研发介入，报警
 *         C 第三方   —— 下游 API/协议出错，关注级
 *   编号  001 ~ 099  该「域 × 来源」的通用兜底，**最多 1 个**
 *         100 ~ 999  该域的具名场景，顺序递增
 *
 * ⚠️ 码值是契约：不重排、不复用、作废留空。复用会让旧日志里的码值指向新含义。
 *
 * 本文件是全站唯一的错误码定义处，无依赖。
 */

/** 带码值的异常。`detail` 是结构化上下文（给排查和程序判断），`cause` 是原始异常（不丢栈）。 */
export class AppError extends Error {
  constructor(def, detail = {}, cause) {
    super(fill(def.msg, detail));
    this.name = 'AppError';
    this.code = def.code;
    this.detail = detail;
    this.cause = cause;
  }
}

/** 把 `{name}` 占位符替换成 `detail.name`。找不到的占位符**原样保留** —— 那说明调用点漏传了，看见比藏起来好。 */
function fill(tpl, detail) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in detail ? detail[k] : m));
}

export const ERR = {
  // ── 域 00 通用 / 基础架构 ─────────────────────
  INTERNAL:            { code: 'B00001', msg: '内部错误：{detail}' },            // 通用兜底
  LOAD_FAILED:         { code: 'C00001', msg: '高德 JSAPI 加载失败：{info}' },   // 通用兜底
  //                        A00001 保留：域 00 的 A 类兜底
  TOO_FEW_PLACES:      { code: 'A00100', msg: '至少需要起点和终点两个地点' },
  //                        A00101（公交必填城市）随公交删除，作废不复用
  //                        A00102（驾车途经点 16 上限）同样作废 —— 本方案逐段串联，
  //                        API 每次只见两个点，`opts.waypoints` 那条 16 上限碰不到
  NO_ACTIVE_ROW:       { code: 'A00103', msg: '请先点选一个地点行，再在地图上选点' },
  EMPTY_PLACE:         { code: 'A00104', msg: '第 {index} 个地点未填写' },
  REQUEST_LIMIT:       { code: 'A00105', msg: '本次操作需发出 {n} 次请求，超过上限 {max} 次' },
  MODE_NOT_SUPPORTED:  { code: 'A00106', msg: '本小车只支持骑行与驾车' },
  KEY_MISSING:         { code: 'B00100', msg: '未配置高德 Key，请填写 config.js' },
  EXPORT_FORMAT_UNKNOWN:{ code: 'B00101', msg: '未知的导出格式「{format}」' },
  // 高德的凭证类拒绝（Key 平台选错 / Key 无效 / 缺安全密钥）。**必须是 B 类** ——
  // 这不是「高德在抽风」，是我们这边配置错了；落成 C 类会让人去等它自己好，白等。
  AMAP_CREDENTIAL:     { code: 'B00102', msg: '高德拒绝调用（{info}）—— Key 的平台或配置不对，去控制台核对' },
  // 高德 20000/20001/20002（参数非法/缺必填/请求方式非法）—— 请求由本程序构造，**是我们的代码缺陷**。
  // 归到 C 类会让人以为是高德在抽风、去等它自己好。
  AMAP_REQUEST_INVALID:{ code: 'B00103', msg: '高德拒绝该请求（{info}）—— 参数由本程序构造，是代码缺陷' },
  PLUGIN_FAILED:       { code: 'C00100', msg: '插件加载失败：{plugin}' },
  // 断网 / 超时 / 非 2xx / 响应不是 JSON。**不能复用 C00001 LOAD_FAILED** —— 那句文案是
  // 「JSAPI 加载失败」，拿来报 REST 的断网是牛头不对马嘴。
  NETWORK_FAILED:      { code: 'C00101', msg: '网络请求失败（{info}）' },
  // 配额与限流族。**它会自愈**（官方：日配额次日 0:00 解封、QPS 下一分钟解封），
  // 与 B00102（等不好）是**相反**的处置动作，所以不能共用一个码。
  AMAP_QUOTA:          { code: 'C00102', msg: '高德配额/限流（{info}）—— 稍后会自动恢复' },

  // ── 域 01 地理编码 ───────────────────────────
  GEO_NOT_FOUND:       { code: 'A01001', msg: '找不到地点「{text}」' },         // 通用兜底
  GEO_REQUEST_FAILED:  { code: 'C01001', msg: '地理编码请求失败：{info}' },      // 通用兜底

  // ── 域 02 路径规划（骑行 + 驾车；两者共用同一套代码，故不拆域） ──
  // ⚠️ 带 {info}：高德能说清原因时（20800 点不在大陆 / 20801 附近没路 / 20803 起终点太远），
  //    只说「未找到可行路线」是把已知信息扔掉。调用点**必须**传 detail.info ——
  //    fill() 找不到占位符就原样留着 `{info}`，那正是「漏传了要看得见」的设计。
  ROUTE_NO_RESULT:     { code: 'A02001', msg: '未找到可行路线（{info}）' },     // 通用兜底
  ROUTE_FAILED:        { code: 'C02001', msg: '路线规划失败：{info}' },          // 通用兜底
  ROUTE_PARTIAL:       { code: 'C02100', msg: '第 {index} 段规划失败，其余路段已显示' },
  REFRESH_FAILED:      { code: 'C02101', msg: '路况刷新失败，继续使用当前路线' },
  // 域 02 的 B 类：配置写错（compareAxes 里的 policy 名字打错）。与 B00100 KEY_MISSING 同类 —— 研发/配置问题，必须被看见
  ROUTE_POLICY_UNKNOWN:{ code: 'B02100', msg: '未知的策略名「{policy}」（{mode}），请查 config.js 的 compareAxes' },

  // ── 域 03 高德定位（降级为地面站调试回退） ──────
  LOCATE_DENIED:       { code: 'A03001', msg: '定位被拒绝，请在浏览器允许定位权限' },  // 通用兜底
  LOCATE_FAILED:       { code: 'C03001', msg: '定位失败：{message}' },                // 通用兜底

  // ── 域 04 本地存储 ───────────────────────────
  //                        B04001 保留：域 04 的 B 类兜底
  STORE_READ_FAILED:   { code: 'B04100', msg: '读取本地历史失败' },
  STORE_WRITE_FAILED:  { code: 'B04101', msg: '保存本地历史失败' },
  STORE_QUOTA_EXCEEDED:{ code: 'B04102', msg: '本地存储已满，请清理历史' },

  // ── 域 05 GPS 定位源（NEO-M10 / NMEA） ───────
  NO_FIX:              { code: 'A05001', msg: 'GPS 尚未定位，请等待卫星信号' },  // 通用兜底
  GPS_PORT_FAILED:     { code: 'B05100', msg: '无法打开定位串口：{port}' },
  GPS_HDOP_POOR:       { code: 'A05101', msg: '定位精度不足（HDOP {hdop}），该点已忽略' },
  NMEA_CHECKSUM_FAILED:{ code: 'C05100', msg: 'NMEA 语句校验失败' },
  OFF_ROUTE:           { code: 'A05102', msg: '已偏离路线 {distance} 米' },
  REROUTE_LIMIT:       { code: 'A05103', msg: '本次导航已重算 {n} 次，请检查定位' },
  GPS_LOST_DR:         { code: 'A05104', msg: 'GPS 失锁，正在靠推算定位（精度衰减中）' },
  // 占的正是码表分配里「域 05 · 来源 A 的下一个可用」那一格
  GPS_OUTLIER:         { code: 'A05105', msg: '定位点跳变 {distance} 米，已丢弃' },

  // ── 域 06 IMU 定位源（M-G354PDH0） ───────────
  IMU_NOT_READY:       { code: 'A06001', msg: 'IMU 尚未就绪，请稍候' },         // 通用兜底
  IMU_SATURATED:       { code: 'A06101', msg: 'IMU 超量程，该段已忽略' },
  IMU_PORT_FAILED:     { code: 'B06100', msg: '无法打开 IMU 接口：{port}' },
  IMU_SELFTEST_FAILED: { code: 'B06101', msg: 'IMU 自检失败：{axis}' },
  IMU_CHECKSUM_FAILED: { code: 'C06100', msg: 'IMU 数据包校验失败' },
};

/**
 * 所有异步入口统一包一层，一处 try/catch。
 * 用法：`guard(ERR.ROUTE_FAILED, () => amaprest.planSegment(a, b, mode))`
 */
export async function guard(def, fn, ...args) {
  try {
    return await fn(...args);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(def ?? ERR.INTERNAL, { detail: e?.message ?? String(e) }, e);
  }
}

/**
 * 错误码第一段（A/B/C）唯一的落地处 —— 否则那 1 位只是装饰。
 * `A` 走 debug、`B` 走 error、`C` 走 warn。
 * ponytail: 无上报通道，只落 console；接监控时改这一个函数即可
 */
export function report(err) {
  const sink = { A: console.debug, B: console.error, C: console.warn }[err.code?.[0]] ?? console.error;
  sink(`[${err.code}] ${err.message}`, err.detail, err.cause);
}
