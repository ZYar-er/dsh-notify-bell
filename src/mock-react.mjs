/**
 * 测试用 React 替身（仅用于 node 环境 import client.js 的纯逻辑导出）。
 * 不参与浏览器运行；浏览器端由 web shell 的静态模块映射提供真实 react。
 */
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
export const useEffect = () => {};
export const useCallback = (fn) => fn;
export const createElement = (type, props, ...children) => ({ type, props, children });
export default { useState, useEffect, useCallback, createElement };
