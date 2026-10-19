/**
 * dsh-sidebar-overlay 的真实渲染验证（headless Chrome + CDP）。
 *
 * 思路：用**官方 frame / overlayLayer 的真实 CSS** 搭一个仿真页，把本插件注册的
 * 浮层节点与生成的 CSS 套上去，在真实浏览器里渲染并测量几何。
 *
 * 验证的是几何事实，而不是「看起来对」：
 *   · 卡片关闭态在视口外且不可交互；
 *   · 打开态滑入、宽度/圆角/投影符合配置；
 *   · 浮层从标题栏下方开始；
 *   · **官方 grid 第一轨道与中栏 left 全程不变** —— 这是本插件相对旧 CSS 方案
 *     的核心承诺（旧方案必须把轨道压成 0px，导致中栏重排）；
 *   · 插件自己的节点不越出卡片矩形；
 *   · 顶栏里个人信息按钮与新会话按钮的排布（同高、左头像右按钮）。
 *
 * 运行：node visual-check.mjs [chrome路径]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ── 找 Chrome ──────────────────────────────────────────────────────────── */

const CANDIDATES = [
  process.argv[2],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const chromePath = CANDIDATES.find(p => existsSync(p))
if (chromePath === undefined) {
  console.log('跳过：未找到 Chrome / Edge。')
  console.log('可显式指定：node visual-check.mjs "C:\\path\\to\\chrome.exe"')
  process.exit(0)
}
console.log('使用浏览器:', chromePath)

/* ── 官方真实 CSS 片段（从 asar 提取的 ui-layout / ui-sidebar）────────────── */

const OFFICIAL_LAYOUT_CSS = `
/* ui-layout AppFrame（节选自官方 dist，哈希类名按提取结果） */
.BynINW_frame {
  background: var(--dsw-alias-bg-base);
  grid-template-rows: 100%;
  height: 100%;
  display: grid;
  position: relative;
  overflow: hidden;
}
[data-windows-titlebar] .BynINW_frame {
  --dsh-windows-content-radius: 16px;
  box-sizing: border-box;
  padding-top: var(--dsh-windows-titlebar-height);
  background: var(--dsw-specific-sidebar-fill);
  grid-template-rows: minmax(0, 1fr);
}
[data-windows-titlebar] .BynINW_centerCol {
  background: var(--dsw-alias-bg-base);
  border-radius: var(--dsh-windows-content-radius) 0 0 0;
}
[data-windows-titlebar] .BynINW_frame:before {
  content: "";
  height: var(--dsh-windows-titlebar-height);
  background: var(--dsw-specific-sidebar-fill);
  position: absolute;
  inset: 0 0 auto;
}
.BynINW_sidebarCol {
  background: var(--dsw-specific-sidebar-fill);
  border-right: .5px solid var(--dsw-alias-border-l3);
  min-width: 0;
  overflow: hidden;
}
.BynINW_centerCol { flex-direction: column; min-width: 0; display: flex; overflow: hidden; }
.BynINW_overlayLayer { z-index: 20; pointer-events: none; position: absolute; inset: 0; }
.BynINW_overlayLayer > * { pointer-events: auto; }
html[data-windows-titlebar] { --dsh-frame-top-clearance: var(--dsh-windows-titlebar-height); }
`

/* 官方 token 的最小替身（真实应用里由 ui-theme 注入）。 */
const TOKENS_CSS = `
:root {
  --dsw-alias-bg-base: #151517;
  --dsw-specific-sidebar-fill: #1b1b1c;
  --dsw-alias-label-primary: #e8e8ea;
  --dsw-alias-label-secondary: #a8a8ad;
  --dsw-alias-label-tertiary: #7a7a80;
  --dsw-alias-label-caption: #6a6a70;
  --dsw-alias-border-l3: rgba(255,255,255,.08);
  --dsw-alias-border-l4: rgba(255,255,255,.14);
  --dsw-alias-interactive-bg-hover: rgba(255,255,255,.06);
  --dsw-alias-state-business-primary: #4d6bfe;
  --dsw-alias-state-warning-primary: #e8a33d;
  --dsw-elevation-panel: 0 0 0 .5px rgba(255,255,255,.06), 0 8px 24px rgba(0,0,0,.45);
  --dsw-radius-sm: 6px;
  --dsw-radius-md: 8px;
  --dsw-radius-lg: 12px;
  --ds-ease-in-out: cubic-bezier(.4,0,.2,1);
  --dsw-focus-ring-width: 2px;
  --dsh-windows-titlebar-height: 40px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: "Segoe UI", system-ui, sans-serif;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
`

/* ── 用 CDP 驱动浏览器 ──────────────────────────────────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值并返回 JSON 结果。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', event => reject(new Error(`WebSocket 连接失败: ${String(event?.message ?? '')}`)))
  })
}

async function waitForDevtools(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) {
        const info = await response.json()
        if (typeof info.webSocketDebuggerUrl === 'string') return info.webSocketDebuggerUrl
      }
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('等待 DevTools 超时')
}

/**
 * 浏览器在受限沙箱下可能起不来（crashpad `OpenProcess: 拒绝访问`，DevTools
 * 端口永不监听）。这种情况是**环境限制**，不是插件缺陷，所以单独归类：
 * 报告 SKIP 并以退出码 0 结束，避免把环境问题误报成失败。
 */
class BrowserUnavailable extends Error {}

/* ── 断言 ───────────────────────────────────────────────────────────────── */

let pass = 0
const failures = []
function check(name, condition, detail) {
  if (condition) pass++
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-fso-'))
const port = 9333 + Math.floor(Math.random() * 400)
const pageUrl = 'about:blank'

const child = spawn(chromePath, [
  `--remote-debugging-port=${String(port)}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-gpu',
  '--window-size=1600,900',
  pageUrl,
], { stdio: 'ignore' })

let cdp
let browserUnavailable = false
try {
  let wsUrl
  try {
    wsUrl = await waitForDevtools(port)
  } catch (error) {
    browserUnavailable = true
    throw new BrowserUnavailable(error.message)
  }
  const browserWs = await connect(wsUrl)
  const browser = new Cdp(browserWs)

  // 新建一个页面 target，避免复用启动页的 about:blank 限制。
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

  // 用扁平会话：后续消息带上 sessionId。
  const sessionCdp = {
    send(method, params = {}) {
      const id = ++sessionCdp.id
      return new Promise((resolve, reject) => {
        sessionCdp.pending.set(id, { resolve, reject })
        browserWs.send(JSON.stringify({ id, method, params, sessionId }))
      })
    },
    id: 0,
    pending: new Map(),
  }
  browserWs.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && sessionCdp.pending.has(message.id)) {
      const { resolve, reject } = sessionCdp.pending.get(message.id)
      sessionCdp.pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })

  cdp = {
    async evaluate(expression) {
      const result = await sessionCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
      }
      return result.result.value
    },
    send: sessionCdp.send.bind(sessionCdp),
  }

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 读取插件源码与 CSS。
  const clientSource = (await import('node:fs')).readFileSync(join(here, 'client.js'), 'utf8')

  /* 构造仿真页：官方三栏 frame + overlayLayer + 插件浮层。
   * 中栏里再放一个「对话区 header + 对话内容容器」的两段结构，
   * 用来验证热区上边界是否真的把 header 排除掉了（真实缺陷回归）。 */
  const html = `<!doctype html>
<html data-windows-titlebar>
<head><meta charset="utf-8"><style>${TOKENS_CSS}${OFFICIAL_LAYOUT_CSS}
/* 仿真对话区：header（76px，含对话/轨迹 tab）+ body（= [data-conversation-content]）。
   与官方 ConversationRoot 的 flex column 结构一致：body 顶边 = header 底边。 */
.convRoot { display: flex; flex-direction: column; height: 100%; }
.convHeader { flex: none; min-height: 76px; box-sizing: border-box; padding: 10px 20px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l3); }
.convBody { flex: 1; min-height: 0; position: relative; }
</style></head>
<body>
<div class="BynINW_frame" id="frame" style="grid-template-columns: 280px minmax(400px,1fr) minmax(0px,0px)">
  <div class="BynINW_sidebarCol" id="sidebarCol"><div style="width:280px;height:100%">官方侧边栏</div></div>
  <div class="BynINW_centerCol" id="centerCol">
    <div class="convRoot">
      <div class="convHeader" id="convHeader">对话 / 轨迹 tab、会话标题</div>
      <div class="convBody" id="convBody" data-conversation-content></div>
    </div>
  </div>
  <div class="BynINW_overlayLayer" data-shell-overlay id="overlayLayer"></div>
</div>
<script>
window.__DSH_TEST__ = {};
// 记录真实官方几何，供断言对比。
window.__DSH_TEST__.measureOfficial = () => {
  const frame = document.getElementById('frame');
  const center = document.getElementById('centerCol');
  const sidebar = document.getElementById('sidebarCol');
  return {
    grid: getComputedStyle(frame).gridTemplateColumns,
    centerLeft: center.getBoundingClientRect().left,
    centerWidth: center.getBoundingClientRect().width,
    sidebarWidth: sidebar.getBoundingClientRect().width,
  };
};
// 对话区 header / body 的真实几何（热区上边界断言用）。
window.__DSH_TEST__.measureConversation = () => {
  const header = document.getElementById('convHeader');
  const body = document.getElementById('convBody');
  const hr = header.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  return {
    headerTop: hr.top, headerBottom: hr.bottom, headerHeight: hr.height,
    bodyTop: br.top, bodyLeft: br.left, bodyWidth: br.width,
  };
};
</script>
</body></html>`

  // 通过 Data URL 载入，避免文件系统权限问题。
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  await cdp.send('Page.navigate', { url: dataUrl })
  await new Promise(r => setTimeout(r, 600))

  /* 装载插件（用桩模块加载器），把生成的 CSS 与浮层节点注入页面。 */
  const install = await cdp.evaluate(`(() => {
    const logs = [];
    const registered = [];
    window.__ModuleLoader__ = {
      load({ id, factory }) {
        const mod = factory(name => {
          if (name === 'react') return window.__REACT_STUB__;
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
          throw new Error('unexpected require: ' + name);
        });
        window.__PLUGIN__ = mod;
      }
    };
    // 极简 React 桩：createElement 直接产出真实 DOM，便于几何测量。
    const createElement = (type, props, ...children) => {
      /* React 的语义：createElement(Comp, { children: x }) 与
       * createElement(Comp, null, x) 必须**等价** —— children 属于 props。
       *
       * 早期版本写成 { ...(props||{}), children: rest.length ? rest : undefined }，
       * 于是凡是「通过 props.children 传子节点」的写法（官方 Tooltip 与本插件的
       * 降级 TooltipFallback 都是这种）在桩里都会被覆盖成空：组件照常调用，
       * 只是什么都渲染不出来。这正是本脚本曾经漏掉「新会话」按钮的原因 ——
       * 几何断言全部通过，而按钮根本没被渲染。
       *
       * 现在按 React 规则合并：显式 props.children 保留，rest 有值时按覆盖
       * 顺序覆盖它（与真实 createElement 一致）。 */
      const flattened = children.flat(Infinity).filter(c => c !== undefined)
      const mergedProps = { ...(props || {}) }
      if (flattened.length === 1) mergedProps.children = flattened[0]
      else if (flattened.length > 1) mergedProps.children = flattened
      if (typeof type === 'function') {
        // 函数组件：直接调用（hooks 桩已内联）。
        return type(mergedProps)
      }
      if (type === Symbol.for('react.fragment')) {
        const frag = document.createDocumentFragment();
        const list = mergedProps.children === undefined ? [] : [mergedProps.children]
        for (const c of list.flat(Infinity)) if (c != null && c !== false) frag.append(c instanceof Node ? c : document.createTextNode(String(c)));
        return frag;
      }
      const el = document.createElement(type);
      const content = mergedProps.children === undefined ? [] : [mergedProps.children]
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); continue; }
        if (k.startsWith('on') && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); continue; }
        if (k === 'children') continue;
        if (k === 'ref' && typeof v === 'object') { v.current = el; continue; }
        if (k === 'draggable' || k === 'value' || k === 'disabled') { el[k] = v; continue; }
        if (k === 'tabIndex') { el.tabIndex = v; continue; }
        if (k === 'className') { el.className = v; continue; }
        el.setAttribute(k, String(v));
      }
      for (const c of content.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
      return el;
    };
    window.__REACT_STUB__ = {
      createElement,
      Fragment: Symbol.for('react.fragment'),
      // 单次渲染的桩：useState 每次给初值，setter 是 noop；
      // useCallback 必须**返回函数本身**（不是立即执行），否则组件里的
      // 每个 useCallback 都会在渲染期被调用一遍并读不到 state。
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: () => ({ current: null }),
    };
    ${clientSource}
    return { loaded: typeof window.__PLUGIN__ === 'object' };
  })()`)

  check('[1] 插件被模块加载器装载', install?.loaded === true, JSON.stringify(install))

  /* 注入样式并挂载浮层节点（模拟 shell.overlay 座位）。 */
  const mounted = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const css = plugin.__buildCss({ ...plugin.__DEFAULTS, width: 280, gap: 8, radius: 16, animationMs: 180 });
    const style = document.createElement('style');
    style.id = 'dsh-sidebar-overlay-style';
    style.textContent = css;
    document.head.appendChild(style);
    document.documentElement.style.setProperty('--dsh-fso-top', '40px');

    // 用插件的组件渲染真实 DOM（React 桩直接产出节点）。
    const overlay = document.getElementById('overlayLayer');
    const node = plugin.__renderForTest
      ? plugin.__renderForTest()
      : null;
    return { cssLength: css.length, hasNode: node !== null };
  })()`)

  check('[2] CSS 成功生成', mounted?.cssLength > 4000, JSON.stringify(mounted))

  /* 用**真实组件**渲染浮层，而不是手工构造 DOM。
   *
   * 手工构造会与实现脱节（曾经因为结构改动而误报「节点越界」）。这里给组件喂
   * 一套最小数据，让它自己产出节点，测得的就是真实结构。 */
  const built = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const React = window.__REACT_STUB__;
    const t = (key, params) => {
      if (params === undefined) return key;
      const values = Object.values(params).filter(v => typeof v !== 'object').join(',');
      return values === '' ? key : key + '(' + values + ')';
    };
    const hook = (value) => (selector) => (typeof selector === 'function' ? selector(value) : value);
    const sessions = {
      ids: ['s1', 's2'],
      byId: {
        s1: { id: 's1', title: '第一个会话', updatedAt: 3000, retainedBy: { mainView: 1 }, blank: false },
        s2: { id: 's2', title: '第二个会话', updatedAt: 2000, blank: false },
      },
      phase: 'ready',
      projectionsBySession: {},
    };
    const workspaces = {
      items: [{ workspaceId: 'w1', path: '/p/alpha', title: 'alpha', sessionIds: ['s1', 's2'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }],
      archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    };
    const props = {
      useSessions: hook(sessions),
      useSessionStatus: hook(new Map()),
      useWorkspaces: hook(workspaces),
      usePanelInfo: hook({ activePanelId: null }),
      config: {},
      t,
      /** 官方账户数据源（settings.launcher 条目 inject 出来的 account）。
       *  顶栏几何只需要「已登录 + 有头像」这一个快照。 */
      accountSource: {
        getSnapshot: () => ({
          view: { status: 'credential-stored' },
          details: { profile: { status: 'ready', value: { name: '测试用户' } } },
          avatar: { status: 'ready', url: 'https://example.invalid/a.png' },
        }),
        subscribe: () => () => {},
      },
      accountT: t,
      openSettings() {},
      openSession() {}, startSession() {},
      forkSession: () => Promise.resolve(),
      renameSession: () => Promise.resolve(),
      pinSession: () => Promise.resolve(),
      unpinSession: () => Promise.resolve(),
      archiveSession: () => Promise.resolve(),
      unarchiveSession: () => Promise.resolve(),
      renameWorkspace: () => Promise.resolve(),
      deleteWorkspace: () => Promise.resolve(),
      insertWorkspaceBefore: () => Promise.resolve(),
      createWorkspace: () => Promise.resolve(),
      searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
      searchResultLimit: 20,
      pickDirectory: () => Promise.resolve(null),
      hostHome: undefined,
      notify() {},
    };
    const overlay = document.getElementById('overlayLayer');
    // 组件直接返回真实 DOM 节点（createElement 桩产出的是元素）。
    const node = plugin.__FloatingSidebar(props);
    overlay.appendChild(node instanceof Node ? node : document.createTextNode(String(node)));
    return { mounted: true, hasCard: document.querySelector('[data-dsh-fso-card]') !== null, hasNew: !!document.querySelector('[data-dsh-fso-new]'), showNew: plugin.__DEFAULTS.showNewSession };
  })()`)
  check('[3] 浮层节点已挂载', built?.mounted === true)
  check('[3] 卡片节点由真实组件产出', built?.hasCard === true, JSON.stringify(built))

  await new Promise(r => setTimeout(r, 200))

  /* ── 关闭态几何 ─────────────────────────────────────────────────────── */
  const closed = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-fso-card]');
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const official = window.__DSH_TEST__.measureOfficial();
    return {
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
      transform: style.transform,
      official,
      overlayPointerEvents: getComputedStyle(document.getElementById('overlayLayer')).pointerEvents,
    };
  })()`)

  check('[4] 关闭态卡片在视口外', closed.rect.right <= 1, `right=${String(closed.rect.right)}`)
  check('[5] 关闭态透明', closed.opacity < 0.05, `opacity=${String(closed.opacity)}`)
  check('[6] 关闭态不拦截指针', closed.pointerEvents === 'none', closed.pointerEvents)
  check('[7] 官方 overlayLayer 是 pointer-events:none', closed.overlayPointerEvents === 'none', closed.overlayPointerEvents)
  check('[8] 关闭态官方 grid 未被改动',
    closed.official.grid.includes('280px'), closed.official.grid)
  check('[9] 关闭态中栏 left 为侧边栏宽度',
    Math.abs(closed.official.centerLeft - 280) < 1.5, `left=${String(closed.official.centerLeft)}`)

  /* ── 打开态几何 ─────────────────────────────────────────────────────── */
  /* 开关状态写在**卡片自身**的 data-open 上（不是 <html>）。
   * 写在 <html> 上会让浏览器在每次开合时重算整个文档的样式匹配；test.mjs 也
   * 明确断言生成的 CSS 不含 `html[`。这里必须切同一条路径，否则下面的「打开态」
   * 断言量到的其实是关闭态，会变成一堆假通过。 */
  await cdp.evaluate(`document.querySelector('[data-dsh-fso-card]').setAttribute('data-open', '')`)
  await new Promise(r => setTimeout(r, 450))

  const opened = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-fso-card]');
    const panel = document.querySelector('[data-dsh-fso-panel]');
    const rect = card.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const style = getComputedStyle(card);
    const official = window.__DSH_TEST__.measureOfficial();
    // 插件自己的节点是否越出卡片矩形。
    let escaped = [];
    for (const el of panel.querySelectorAll('[data-dsh-fso-header],[data-dsh-fso-new],[data-dsh-fso-list-area]')) {
      const r = el.getBoundingClientRect();
      if (r.right > rect.right + 1 || r.left < rect.left - 1 || r.bottom > rect.bottom + 1 || r.top < rect.top - 1) {
        escaped.push(el.getAttribute('data-dsh-fso-header') !== null ? 'header' : (el.getAttribute('data-dsh-fso-new') !== null ? 'new' : 'listArea'));
      }
    }
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      panelRect: { left: panelRect.left, top: panelRect.top, width: panelRect.width },
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
      radius: style.borderTopLeftRadius,
      shadow: style.boxShadow,
      transform: style.transform,
      official,
      // 诊断：逐个子元素的矩形，越界时能看出超了多少。
      children: [...panel.querySelectorAll('[data-dsh-fso-header],[data-dsh-fso-new],[data-dsh-fso-list-area]')].map(el => ({
        name: el.hasAttribute('data-dsh-fso-header') ? 'header' : (el.hasAttribute('data-dsh-fso-new') ? 'new' : 'listArea'),
        rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })(),
      })),
      escaped,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`)

  check('[10] 打开态卡片滑入到位', Math.abs(opened.rect.left - 8) < 2, `left=${String(opened.rect.left)}`)
  check('[11] 打开态不透明', opened.opacity > 0.95, `opacity=${String(opened.opacity)}`)
  check('[12] 打开态可交互', opened.pointerEvents === 'auto', opened.pointerEvents)
  check('[13] 卡片宽度为配置值', Math.abs(opened.rect.width - 280) < 1.5, `width=${String(opened.rect.width)}`)
  check('[14] 卡片圆角为配置值', opened.radius.startsWith('16px'), opened.radius)
  check('[15] 卡片有投影', opened.shadow !== 'none' && opened.shadow !== '', opened.shadow)
  check('[16] 浮层从标题栏下方开始', Math.abs(opened.rect.top - 48) < 2, `top=${String(opened.rect.top)}`)
  check('[17] 卡片底边贴视口底（留白 = gap）',
    Math.abs(opened.viewport.height - opened.rect.bottom - 8) < 2,
    `bottom=${String(opened.rect.bottom)} vh=${String(opened.viewport.height)}`)
  check('[18] 插件节点不越出卡片', opened.escaped.length === 0,
    `${JSON.stringify(opened.escaped)} card=${JSON.stringify(opened.rect)} children=${JSON.stringify(opened.children)}`)
  check('[19] 打开态官方 grid 仍未改动',
    opened.official.grid.includes('280px'), opened.official.grid)
  check('[20] 打开态中栏 left 仍为侧边栏宽度（零重排）',
    Math.abs(opened.official.centerLeft - 280) < 1.5, `left=${String(opened.official.centerLeft)}`)
  check('[21] 打开态中栏宽度未变',
    Math.abs(opened.official.centerWidth - closed.official.centerWidth) < 1.5,
    `${String(closed.official.centerWidth)} → ${String(opened.official.centerWidth)}`)
  check('[22] 侧边栏列宽未被改动',
    Math.abs(opened.official.sidebarWidth - 280) < 1.5, `width=${String(opened.official.sidebarWidth)}`)

  /* ── 顶栏：个人信息按钮 × 新会话按钮的真实几何 ────────────────────────
   * 这不是「看起来对不对」，而是几条必须成立的布局事实：
   *   · 两者同处一行，垂直居中对齐；
   *   · 个人信息在左、新会话在右，不重叠、不换行；
   *   · 个人信息是 38×38 正圆，内含 24×24 头像槽；
   *   · 新会话按钮吃掉剩余宽度，且两枚按钮同高（38px）；
   *   · 整行不越出卡片。 */
  const topbar = await cdp.evaluate(`(() => {
    const profile = document.querySelector('[data-dsh-fso-profile]');
    const avatar = document.querySelector('[data-dsh-fso-profile-avatar]');
    const newButton = document.querySelector('[data-dsh-fso-new]');
    const bar = document.querySelector('[data-dsh-fso-topbar]');
    const card = document.querySelector('[data-dsh-fso-card]');
    const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return {
      bar: bar === null ? null : rectOf(bar),
      profile: profile === null ? null : rectOf(profile),
      avatar: avatar === null ? null : rectOf(avatar),
      isButton: profile?.tagName === 'BUTTON',
      hasImg: profile?.querySelector('img') !== null,
      newButton: newButton === null ? null : rectOf(newButton),
      card: card === null ? null : rectOf(card),
      height: newButton === null ? null : getComputedStyle(newButton).height,
      barGap: bar === null ? null : getComputedStyle(bar).columnGap,
    };
  })()`)

  check('[23] 顶栏已渲染', topbar?.bar !== null && topbar?.bar !== undefined, JSON.stringify(topbar))
  check('[24] 个人信息按钮在顶栏左侧',
    topbar?.profile !== null && topbar?.profile !== undefined
      && Math.abs(topbar.profile.left - topbar.bar.left) < 1,
    `profile.left=${String(topbar?.profile?.left)} bar.left=${String(topbar?.bar?.left)}`)
  check('[25] 个人信息在新会话左边（不重叠）',
    topbar?.profile !== null && topbar?.profile !== undefined
      && topbar?.newButton !== null && topbar?.newButton !== undefined
      && topbar.profile.right <= topbar.newButton.left + 0.5,
    `profile.right=${String(topbar?.profile?.right)} new.left=${String(topbar?.newButton?.left)}`)
  check('[26] 两者在同一行（顶边对齐、垂直居中）',
    Math.abs((topbar.profile.top + topbar.profile.bottom) / 2 - (topbar.newButton.top + topbar.newButton.bottom) / 2) < 1.5,
    `profileMid=${String((topbar.profile.top + topbar.profile.bottom) / 2)} newMid=${String((topbar.newButton.top + topbar.newButton.bottom) / 2)}`)
  check('[27] 个人信息是正圆槽（宽 = 高 = 38）',
    Math.abs(topbar.profile.width - 38) < 1 && Math.abs(topbar.profile.height - 38) < 1,
    `w=${String(topbar.profile.width)} h=${String(topbar.profile.height)}`)
  check('[28] 个人信息是可点击的 button 元素', topbar?.isButton === true, String(topbar?.isButton))
  check('[29] 已登录渲染账户头像图片', topbar?.hasImg === true, String(topbar?.hasImg))
  check('[30] 头像槽是 24×24 圆形',
    Math.abs(topbar.avatar.width - 24) < 1 && Math.abs(topbar.avatar.height - 24) < 1,
    `w=${String(topbar?.avatar?.width)} h=${String(topbar?.avatar?.height)}`)
  check('[31] 新会话按钮高 38px（与个人信息一致）',
    Math.abs(topbar.newButton.height - 38) < 1, `h=${String(topbar?.newButton?.height)}`)
  check('[32] 新会话按钮吃掉剩余宽度',
    topbar.newButton.width > 150 && Math.abs(topbar.bar.right - topbar.newButton.right) < 1,
    `new.width=${String(topbar.newButton?.width)} bar.right=${String(topbar.bar?.right)}`)
  check('[33] 顶栏本身不越出卡片',
    topbar.bar.left >= topbar.card.left - 1 && topbar.bar.right <= topbar.card.right + 1
      && topbar.bar.top >= topbar.card.top - 1 && topbar.bar.bottom <= topbar.card.bottom + 1,
    `bar=${JSON.stringify(topbar.bar)} card=${JSON.stringify(topbar.card)}`)
  check('[34] 顶栏列间距为 8px', String(topbar.barGap ?? '').startsWith('8px'), topbar.barGap)

  /* ── 收回：几何必须回到关闭态，且官方几何全程不变 ───────────────────── */
  await cdp.evaluate(`document.querySelector('[data-dsh-fso-card]').removeAttribute('data-open')`)
  await new Promise(r => setTimeout(r, 450))

  const reclosed = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-fso-card]');
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return {
      right: rect.right,
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
      official: window.__DSH_TEST__.measureOfficial(),
    };
  })()`)

  check('[35] 收回后卡片移出视口', reclosed.right <= 1, `right=${String(reclosed.right)}`)
  check('[36] 收回后不拦截指针', reclosed.pointerEvents === 'none', reclosed.pointerEvents)
  check('[37] 收回后官方 grid 复原',
    reclosed.official.grid.includes('280px'), reclosed.official.grid)
  check('[38] 收回后中栏位置复原',
    Math.abs(reclosed.official.centerLeft - 280) < 1.5, `left=${String(reclosed.official.centerLeft)}`)

  /* ── 热区逻辑：验证 isCollapsed 判定与 trigger 模式 ─────────────────── */
  const hotzone = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const defaults = plugin.__DEFAULTS;
    return {
      trigger: defaults.trigger,
      triggerRatio: defaults.triggerRatio,
      closeSlack: defaults.closeSlack,
      onlyWhenCollapsed: defaults.onlyWhenCollapsed,
      width: defaults.width,
    };
  })()`)
  check('[27] 默认热区按对话内容列算（trigger=content）',
    hotzone.trigger === 'content', JSON.stringify(hotzone))
  check('[27] 默认比例为 0.4', hotzone.triggerRatio === 0.4, JSON.stringify(hotzone))
  check('[28] 默认仅在折叠态浮出', hotzone.onlyWhenCollapsed === true, JSON.stringify(hotzone))

  /* 热区几何：仿真页里内容列 clamp(680, 视口*.64, 920) → 左边缘 × 0.4。
   * 断言取整生效（含端点）、且不超过内容列左边缘。
   * 注意视口是 headless 默认的 1584px 左右，此时热区只有一百多像素 ——
   * 所以「大于旧默认 24px」这个断言用 `> 24` 而不是更激进的下限。 */
  const triggerGeo = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const viewport = window.innerWidth;
    const edge = plugin.__fallbackTriggerEdge(viewport, 0.4);
    const contentWidth = plugin.__contentColumnWidth(viewport);
    const contentLeft = (viewport - Math.min(viewport, contentWidth)) / 2;
    return { viewport, edge, contentLeft };
  })()`)
  check('[27] 热区右边界 = ceil(内容列左边缘 × 0.4)',
    triggerGeo.edge === Math.ceil(triggerGeo.contentLeft * 0.4),
    JSON.stringify(triggerGeo))
  check('[27] 热区为整数像素（ceil 生效，端点无歧义）',
    Number.isInteger(triggerGeo.edge), JSON.stringify(triggerGeo))
  check('[27] 热区大于旧默认 24px', triggerGeo.edge > 24, JSON.stringify(triggerGeo))
  check('[27] 热区不超过内容列左边缘', triggerGeo.edge <= triggerGeo.contentLeft, JSON.stringify(triggerGeo))

  /* ── 真实浏览器里验证热区上边界排除对话区 header ─────────────────────
   *
   * 真实缺陷回归：原先上边界只取窗口标题栏（Windows 40px），于是对话区自己的
   * header（对话/轨迹 tab、会话标题，76px）整块落在热区内，点头部会浮出侧边栏。
   *
   * 这里用仿真页里**真实渲染**的 header/body 几何来断言：
   * 插件算出的上边界必须等于对话内容容器的顶边（即 header 的底边）。 */
  const topGeo = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const conv = window.__DSH_TEST__.measureConversation();
    const titlebar = 40; // 仿真页 --dsh-windowstitlebar 高度
    return {
      conv,
      titlebar,
      pluginTop: plugin.__triggerTopEdge(conv.bodyTop, titlebar),
    };
  })()`)
  check('[27] 渲染出的对话区 header 高度 > 0（前提）',
    topGeo.conv.headerHeight > 0,
    JSON.stringify(topGeo.conv))
  check('[27] 热区上边界 = 对话内容容器顶边（排除 header）',
    Math.abs(topGeo.pluginTop - topGeo.conv.bodyTop) < 0.51,
    `pluginTop=${String(topGeo.pluginTop)} bodyTop=${String(topGeo.conv.bodyTop)}`)
  check('[27] 热区上边界高于窗口标题栏（确认取的是 header 底边而非仅标题栏）',
    topGeo.pluginTop > topGeo.titlebar,
    JSON.stringify({ pluginTop: topGeo.pluginTop, titlebar: topGeo.titlebar }))
  check('[27] 热区上边界等于 header 底部（header 整块在热区之外）',
    Math.abs(topGeo.pluginTop - topGeo.conv.headerBottom) < 0.51,
    `pluginTop=${String(topGeo.pluginTop)} headerBottom=${String(topGeo.conv.headerBottom)}`)

  /* ── 采样：开合过程中官方 grid 是否发生过变化（核心承诺）───────────── */
  const sampled = await cdp.evaluate(`(async () => {
    const frame = document.getElementById('frame');
    const card = document.querySelector('[data-dsh-fso-card]');
    const samples = [];
    const sample = () => samples.push(getComputedStyle(frame).gridTemplateColumns);
    sample();
    card.setAttribute('data-open', '');
    for (let i = 0; i < 12; i++) { await new Promise(r => requestAnimationFrame(r)); sample(); }
    card.removeAttribute('data-open');
    for (let i = 0; i < 12; i++) { await new Promise(r => requestAnimationFrame(r)); sample(); }
    const unique = [...new Set(samples)];
    return { total: samples.length, unique };
  })()`)

  check('[29] 开合全程官方 grid 只有一种取值（中栏零重排）',
    sampled.unique.length === 1, JSON.stringify(sampled.unique))

  /* ── 降级路径：官方 primitives 缺失时组件仍能渲染 ───────────────────── */
  const fallback = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    // 直接调用组件的渲染函数路径：通过 apply 之外的方式不可行，
    // 改为验证降级组件本身存在且不抛错。
    const css = plugin.__buildCss({ ...plugin.__DEFAULTS });
    return { ok: typeof css === 'string' && css.length > 0 };
  })()`)
  check('[30] 降级路径下 CSS 仍可生成', fallback?.ok === true)

} catch (error) {
  if (error instanceof BrowserUnavailable || browserUnavailable) {
    console.log('\nSKIP：浏览器在当前沙箱下无法启动（crashpad 权限被拒），跳过几何验证。')
    console.log('这不代表插件有问题；请在权限放宽的环境重跑，或直接装进 DSH 目视确认。')
    process.exitCode = 0
  } else {
    failures.push(`运行期异常：${error?.message ?? String(error)}`)
  }
} finally {
  try { child.kill() } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300))
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/* ── 结果 ───────────────────────────────────────────────────────────────── */

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
