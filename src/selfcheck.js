/**
 * 自检开关。**只在 `node src/xxx.js` 直接运行时跑**，被 import 时不跑。
 *
 * 为什么要这一层：`if (typeof window === 'undefined') demo()` 看着够用，但
 * 任何一个 node 脚本 import 了这个模块，demo 就会连带执行并抛错 ——
 * 测试和被测试的代码互相污染。
 *
 * ⚠️ 必须把调用方的 `import.meta.url` 传进来。
 * `import.meta` 是**每个模块自己的**，在本文件里读到的永远是 `selfcheck.js`
 * 的路径，跟调用方比一定不相等 —— 于是 demo 被静默跳过，不报错、不输出，
 * 看起来像「自检写错了」。所以：
 *
 *     selfcheck(demo, import.meta.url);
 */

/**
 * @param {() => void} fn 自检函数，内部用 assert 式断言，失败就抛
 * @param {string} callerUrl 调用方的 `import.meta.url`
 * @returns {boolean} 是否执行了自检（调用方一般不需要）
 */
export function selfcheck(fn, callerUrl) {
  if (!isEntry(callerUrl)) return false;
  fn();
  return true;
}

/** 判断 callerUrl 指向的模块是不是 node 本次运行的入口脚本 */
function isEntry(callerUrl) {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const argPath = process.argv[1].replace(/\\/g, '/');   // Windows 反斜杠
  return decodeURIComponent(callerUrl).endsWith(argPath); // URL 里空格是 %20
}
