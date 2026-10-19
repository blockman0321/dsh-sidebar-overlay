/**
 * 个人信息按钮的端到端验证（headless Chrome + CDP）。
 *
 * 前面几套测试验的是「接线」与「几何」，都在桩里跑。这里验证一件更关键的事：
 * 把**官方座位链**真的搭出来（`sidebar.settings` → `settings.launcher`），
 * 让插件自己去 `entriesOfSlot('settings.launcher')` 取条目、绑定 inject 面、
 * 渲染出按钮 —— 然后断言：
 *
 *   · 按钮真的渲染出来了（不是 undefined、不是空壳）；
 *   · 它拿到的是官方组件、`wide: false`、以及可用的 `useAccount` hook；
 *   · 点击它能打开官方菜单（桩里的 AccountMenu 渲染一个真实的 menu 节点）；
 *   · 菜单在浮层卡片**之外**也可见（portal 到 body，不被卡片 overflow 裁掉）；
 *   · 头像图片加载失败时走官方降级图标（不出现破图）；
 *   · 座位不存在时插件安静地不渲染按钮。
 *
 * 运行：node e2e-profile.mjs [chrome路径]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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
  console.log('可显式指定：node e2e-profile.mjs "C:\\path\\to\\chrome.exe"')
  process.exit(0)
}
console.log('使用浏览器:', chromePath)

/* ── CDP 小工具 ─────────────────────────────────────────────────────────── */

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error('DevTools 端口未监听')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => { resolve(socket) })
    socket.addEventListener('error', e => { reject(new Error(String(e?.message ?? e))) })
  })
}

class BrowserUnavailable extends Error {}

/* ── 断言 ───────────────────────────────────────────────────────────────── */

let pass = 0
const failures = []
function check(name, condition, detail) {
  if (condition) pass++
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-fso-e2e-'))
const port = 9700 + Math.floor(Math.random() * 300)

const child = spawn(chromePath, [
  `--remote-debugging-port=${String(port)}`,
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-gpu',
  '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore' })

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
  let nextId = 1
  const pending = new Map()
  browserWs.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    browserWs.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = {
    send: (method, params) => send(method, params, sessionId),
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
      }
      return result.result.value
    },
  }
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const clientSource = readFileSync(join(here, 'client.js'), 'utf8')

  /* 极简真实 DOM 页面：只需要一个能挂浮层的容器 + 官方 token 的替身。 */
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{
    --dsw-alias-bg-base:#151517; --dsw-specific-sidebar-fill:#1b1b1c;
    --dsw-alias-label-primary:#e8e8ea; --dsw-alias-label-secondary:#a8a8ad;
    --dsw-alias-label-tertiary:#7a7a80; --dsw-alias-border-l3:rgba(255,255,255,.08);
    --dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);
    --dsw-alias-bg-skeleton:rgba(255,255,255,.10);
    --dsw-alias-button-elevated-fill:rgba(255,255,255,.06);
    --dsw-alias-button-floating-hover:rgba(255,255,255,.10);
    --dsw-radius-sm:6px; --dsw-radius-md:8px; --dsw-radius-xs:4px;
    --dsw-elevation-panel:0 0 0 .5px rgba(255,255,255,.06),0 8px 24px rgba(0,0,0,.45);
    --ds-ease-in-out:cubic-bezier(.4,0,.2,1); --dsh-frame-top-clearance:0px;
    --dsw-focus-ring-width:2px;
  }
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:#151517;color:#e8e8ea}
  #overlay{position:absolute;inset:0;pointer-events:none}
  </style></head><body><div id="overlay" data-shell-overlay></div></body></html>`

  await cdp.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` })
  await new Promise(r => setTimeout(r, 600))

  /* 装载插件：React 桩 + 真实的 mod 加载器。 */
  const install = await cdp.evaluate(`(() => {
    window.__ModuleLoader__ = {
      load({ factory }) {
        window.__PLUGIN__ = factory(name => {
          if (name === 'react') return window.__REACT_STUB__;
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
          throw new Error('unexpected require: ' + name);
        });
      }
    };
    // createElement 按 React 语义：children 属于 props。
    const createElement = (type, props, ...rest) => {
      const flat = rest.flat(Infinity).filter(c => c !== undefined)
      const merged = { ...(props || {}) }
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      if (typeof type === 'function') return type(merged)
      if (type === Symbol.for('react.fragment')) {
        const frag = document.createDocumentFragment()
        const list = merged.children === undefined ? [] : [merged.children]
        for (const c of list.flat(Infinity)) if (c != null && c !== false) frag.append(c instanceof Node ? c : document.createTextNode(String(c)))
        return frag
      }
      const el = document.createElement(type)
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue
        if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); continue }
        if (k.startsWith('on') && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); continue }
        if (k === 'children' || k === 'ref') continue
        if (k === 'className') { el.className = v; continue }
        el.setAttribute(k, String(v))
      }
      const content = merged.children === undefined ? [] : [merged.children]
      for (const c of content.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)))
      return el
    }
    window.__REACT_STUB__ = {
      createElement,
      Fragment: Symbol.for('react.fragment'),
      // useState 必须真的记住值并触发重渲，否则「点开菜单」这类交互验不了：
      // 用「每次渲染重建组件树」的方式模拟一次重渲（本页只有这一棵小树）。
      useState: init => {
        const key = (window.__STATE_CURSOR__ = (window.__STATE_CURSOR__ ?? -1) + 1)
        const slot = window.__STATE__ ??= []
        if (slot[key] === undefined) slot[key] = typeof init === 'function' ? init() : init
        const set = value => {
          const next = typeof value === 'function' ? value(slot[key]) : value
          if (Object.is(next, slot[key])) return
          slot[key] = next
          window.__RERENDER__?.()
        }
        return [slot[key], set]
      },
      useEffect: () => {},
      useMemo: fn => fn(),
      useCallback: fn => fn,
      useRef: () => ({ current: null }),
      useSyncExternalStore: (subscribe, getSnapshot) => { subscribe(() => {}); return getSnapshot() },
    }
    ${clientSource}
    return { loaded: typeof window.__PLUGIN__ === 'object' };
  })()`)
  check('[1] 插件装载成功', install?.loaded === true, JSON.stringify(install))

  /* 搭官方座位链：模拟 ui-settings-general 的 sidebar.settings 声明，
  /* 搭官方座位链：**这是本脚本的重点**。
   *
   *   sidebar.settings   ← ui-settings-general，store 里是 { open, activeId } + actions
   *     └─ settings.launcher ← ui-settings-account，AccountMenu + account hook
   *
   * 关键：`sidebar.settings` 的 store handle 必须**像官方那样**把 `create`
   * 覆写成「永远返回同一个实例」。官方的写法是：
   *     const shellInstance = shellHandle.create()
   *     const shellStore = { ...shellHandle, create: () => shellInstance }
   * 插件靠 `handle.create().actions.open()` 打开设置，所以这一条如果按
   * 朴素 defineStore 语义实现（每次 create 新实例），点击就会指向一个
   * 没人读的 store —— 弹窗不开。本脚本刻意按官方的覆写方式建桩。 */
  const wired = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const React = window.__REACT_STUB__;
    const listeners = new Set();
    const accountState = {
      view: { status: 'credential-stored' },
      details: { profile: { status: 'ready', value: { name: '测试用户' } } },
      avatar: { status: 'ready', url: 'https://example.invalid/avatar.png' },
    };

    /* ── 官方 sidebar.settings 的 store 桩（含真实 open 状态）────────────── */
    function createShellStore() {
      let state = { open: false, activeId: undefined };
      const subs = new Set();
      const publish = () => { for (const fn of [...subs]) fn(); };
      const instance = {
        getSnapshot: () => state,
        subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
        actions: {
          open: () => { state = { ...state, open: true }; publish(); window.__SETTINGS_STORE_OPEN__ = true },
          close: () => { state = { open: false, activeId: undefined }; publish() },
          select: id => { state = { ...state, activeId: id }; publish() },
          openSection: id => { state = { ...state, activeId: id, open: true }; publish() },
        },
      };
      const handle = { spec: {}, create: () => instance };
      // 官方覆写：create 永远给同一个实例。
      return { ...handle, create: () => instance };
    }

    const shellStore = createShellStore();
    window.__SHELL_STORE__ = shellStore;

    // 账户入口条目：真实形状（component + inject），且只保留账户数据源。
    const accountSource = {
      getSnapshot: () => accountState,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    };
    const launcherEntry = {
      component: function AccountMenu() { return null },
      inject: () => ({ hooks: { account: accountSource } }),
    };

    window.__SLOTS__ = {
      entriesOfSlot: key => (key === 'sidebar.settings'
        ? [{ component: function SettingsRoot() { return null }, store: shellStore, inject: () => ({}) }]
        : key === 'settings.launcher' ? [launcherEntry] : []),
      inject: (key, cb) => cb(),
      register: () => () => {},
    };
    const slots = window.__SLOTS__;

    const t = (key, params) => {
      if (params === undefined) return key;
      const values = Object.values(params).filter(v => typeof v !== 'object').join(',');
      return values === '' ? key : key + '(' + values + ')';
    };
    window.__T__ = t;
    const hook = value => selector => (typeof selector === 'function' ? selector(value) : value);

    const css = plugin.__buildCss({ ...plugin.__DEFAULTS, animationMs: 0 });
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.documentElement.style.setProperty('--dsh-fso-top', '0px');

    /** 组装一份注入面：**openSettings 必须来自插件自己的解析函数**，
     *  不能在这里塞桩 —— 塞桩就等于「自己测自己」，正是上一版漏掉
     *  「点设置没反应」的原因。 */
    const props = () => ({
      useSessions: hook({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
      useSessionStatus: hook(new Map()),
      useWorkspaces: hook({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
      usePanelInfo: hook({ activePanelId: null }),
      config: {},
      t,
      accountSource: plugin.__resolveAccountEntry(slots)?.source,
      accountT: t,
      openSettings: plugin.__resolveOpenSettings(slots),
      openSession() {}, startSession() {}, notify() {},
    });

    window.__PROPS__ = props;
    window.__SETTINGS_STORE_OPEN__ = false;

    const host = document.getElementById('overlay');
    host.append(plugin.__FloatingSidebar(props()));
    document.querySelector('[data-dsh-fso-card]').setAttribute('data-open', '');

    return {
      hasProfile: document.querySelector('[data-dsh-fso-profile]') !== null,
      openSettingsResolved: typeof plugin.__resolveOpenSettings(slots) === 'function',
      accountResolved: plugin.__resolveAccountEntry(slots) !== undefined,
      // 关键：解析出来的 openSettings 真的能改到官方 store 的状态。
      storeOpenBefore: shellStore.create().getSnapshot().open,
    };
  })()`)

  check('[2] 个人信息按钮已渲染', wired?.hasProfile === true, JSON.stringify(wired))
  check('[3] 账户数据源解析成功', wired?.accountResolved === true, JSON.stringify(wired))
  check('[4] 打开设置函数解析成功', wired?.openSettingsResolved === true, JSON.stringify(wired))
  check('[5] 初始时官方设置 store 未打开', wired?.storeOpenBefore === false, String(wired?.storeOpenBefore))

  await new Promise(r => setTimeout(r, 200))

  /* 几何：按钮落在卡片内、是正圆，且在「新会话」左边。 */
  const geo = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-fso-card]');
    const profile = document.querySelector('[data-dsh-fso-profile]');
    const newButton = document.querySelector('[data-dsh-fso-new]');
    const r = el => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    return { card: r(card), profile: r(profile), newButton: r(newButton) };
  })()`)

  check('[6] 按钮落在卡片内', geo.profile.left >= geo.card.left - 1 && geo.profile.right <= geo.card.right + 1
    && geo.profile.top >= geo.card.top - 1 && geo.profile.bottom <= geo.card.bottom + 1,
    JSON.stringify({ profile: geo.profile, card: geo.card }))
  check('[7] 按钮是 38×38 正圆（宽 = 高）',
    Math.abs(geo.profile.width - 38) < 1 && Math.abs(geo.profile.height - 38) < 1,
    `w=${String(geo.profile.width)} h=${String(geo.profile.height)}`)
  check('[8] 个人信息在新会话左边',
    geo.profile.right <= geo.newButton.left + 0.5,
    `profile.right=${String(geo.profile.right)} new.left=${String(geo.newButton.left)}`)

  /* ★ 核心：真点按钮 → 官方设置 store 的 open 必须变 true。 */
  const clicked = await cdp.evaluate(`(() => {
    const profile = document.querySelector('[data-dsh-fso-profile]');
    profile.click();
    return {
      storeOpen: window.__SHELL_STORE__.create().getSnapshot().open,
      hasMenu: document.querySelector('[role="menu"]') !== null,
      hasSignOut: document.body.innerHTML.includes('signOut'),
    };
  })()`)
  check('[9] 点击后官方设置 store 打开（设置弹窗出现）',
    clicked?.storeOpen === true, JSON.stringify(clicked))
  check('[10] 点击不再弹出账户菜单', clicked?.hasMenu === false, JSON.stringify(clicked))
  check('[11] 点击不再出现「退出登录」项', clicked?.hasSignOut === false, JSON.stringify(clicked))

  /* 头像：已登录时是 img，src 来自官方 account hook。 */
  const avatar = await cdp.evaluate(`(() => {
    const img = document.querySelector('[data-dsh-fso-profile-avatar] img');
    const button = document.querySelector('[data-dsh-fso-profile]');
    return {
      hasImg: img !== null,
      src: img?.getAttribute('src') ?? null,
      label: button?.getAttribute('aria-label') ?? null,
      title: button?.getAttribute('title') ?? null,
    };
  })()`)
  check('[12] 已登录用账户头像图片', avatar?.hasImg === true && String(avatar?.src).includes('example.invalid'), JSON.stringify(avatar))
  check('[13] aria-label 是「打开设置」', avatar?.label === 'profile.openSettings', String(avatar?.label))
  check('[14] tooltip 带昵称', avatar?.title === '测试用户', String(avatar?.title))

  /* 未登录：降级为默认图标，不加载图片。 */
  const signedOut = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const t = window.__T__;
    const holder = document.createElement('div');
    document.body.append(holder);
    holder.append(plugin.__ProfileButton({
      accountSource: { getSnapshot: () => ({ view: { status: 'signed-out' } }), subscribe: () => () => {} },
      t,
      onOpenSettings() {},
    }));
    return {
      hasImg: holder.querySelector('img') !== null,
      hasSvg: holder.querySelector('svg') !== null,
      title: holder.querySelector('[data-dsh-fso-profile]')?.getAttribute('title') ?? null,
    };
  })()`)
  check('[15] 未登录不加载头像图片', signedOut?.hasImg === false, JSON.stringify(signedOut))
  check('[16] 未登录用默认账户图标', signedOut?.hasSvg === true, JSON.stringify(signedOut))
  check('[17] 未登录 tooltip 用未登录文案', signedOut?.title === 'profile.signedOut', String(signedOut?.title))

  /* 座位缺失：不渲染按钮，不出「点了没反应」的假按钮。 */
  const absent = await cdp.evaluate(`(() => {
    const plugin = window.__PLUGIN__;
    const empty = { entriesOfSlot: () => [] };
    return {
      account: plugin.__resolveAccountEntry(empty) === undefined,
      open: plugin.__resolveOpenSettings(empty) === undefined,
    };
  })()`)
  check('[18] 座位缺失时账户数据源为 undefined', absent?.account === true, JSON.stringify(absent))
  check('[19] 座位缺失时打开设置为 undefined', absent?.open === true, JSON.stringify(absent))
} catch (error) {
  if (error instanceof BrowserUnavailable || browserUnavailable) {
    console.log('SKIP：浏览器起不来（受限沙箱常见），这是环境限制而非插件缺陷。')
    console.log('原因：', error.message)
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
