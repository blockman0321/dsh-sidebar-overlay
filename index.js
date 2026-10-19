/**
 * dsh-sidebar-overlay — Host half（宿主侧）。
 *
 * 全部功能都在浏览器半（见 client.js）：注册进官方 `shell.overlay` 浮层座位，
 * 自建 DOM 复刻官方工作区/会话浏览。宿主侧保持空实现，仅用于让 `dsh.client`
 * 清单被发现、使浏览器半被装载。
 */
export const name = 'sidebar-overlay'

export function apply(ctx, config) {
  // intentionally empty — the panel lives in client.js
}
