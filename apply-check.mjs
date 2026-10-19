/**
 * dsh-sidebar-overlay 的 apply 级集成测试。
 *
 * 前面三套测试都没执行过插件的 `apply`：
 *   · test.mjs   —— 纯函数与 CSS 文本；
 *   · smoke.mjs  —— 组件渲染；
 *   · visual-check.mjs —— 生成 CSS 的几何。
 *
 * 但 `apply` 里有大量接线逻辑（ctx.effect 注册、ctx.inject 等待依赖、样式注入、
 * 指针监听、浮层注册、总开关 API）。它若抛错，插件就完全不可用。
 *
 * 这里用一个最小的 Cordis + DOM 桩真实调用 `apply`，断言：
 *   · 不抛错；
 *   · 样式表被注入 <head>；
 *   · `shell.overlay` 注册被调用，且 id / locale / inject 面正确；
 *   · 注入面返回的业务回调形状完整，且调用时不崩；
 *   · 总开关 API 挂在 window 上且 toggle 生效；
 *   · dispose 后清理干净（样式移除、属性清除、window API 删除）。
 *
 * 运行：node apply-check.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ══════════════════════════════════════════════════════════════════════════
 * DOM 桩
 * ══════════════════════════════════════════════════════════════════════════ */

class StubClassList {
  constructor() { this.set = new Set() }
  add(...names) { for (const n of names) this.set.add(n) }
  remove(...names) { for (const n of names) this.set.delete(n) }
  contains(name) { return this.set.has(name) }
}

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.style = {
      props: new Map(),
      setProperty: (k, v) => { this.style.props.set(k, v) },
      getPropertyValue: k => this.style.props.get(k) ?? '',
      removeProperty: k => { this.style.props.delete(k) },
      cssText: '',
    }
    this.classList = new StubClassList()
    this.textContent = ''
    this.parentNode = null
    this.id = ''
    this.removed = false
    this._listeners = new Map()
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  append(...nodes) { for (const n of nodes) if (n !== null && n !== undefined) this.appendChild(n) }
  remove() {
    this.removed = true
    if (this.parentNode !== null) {
      const index = this.parentNode.children.indexOf(this)
      if (index >= 0) this.parentNode.children.splice(index, 1)
    }
  }
  querySelector() { return null }
  querySelectorAll() { return [] }
  /** 简化版 closest：只支持 `[attr]` 形式（够本套测试用）。
   * 真实浏览器里插件靠它排除右侧栏内的对话区实例。 */
  closest(selector) {
    const match = /^\[([a-z-]+)\]$/.exec(String(selector))
    if (match === null) return null
    let node = this
    while (node !== null && node !== undefined) {
      if (node.attributes?.has(match[1])) return node
      node = node.parentNode
    }
    return null
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 280, bottom: 800, width: 280, height: 800 } }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }
  /** 触发监听器（供测试驱动 pointermove 等）。 */
  dispatch(type, event) {
    for (const fn of this._listeners.get(type) ?? []) fn(event)
  }
  listenerCount(type) { return this._listeners.get(type)?.size ?? 0 }
}

const head = new StubElement('head')
const body = new StubElement('body')
const html = new StubElement('html')
// 让 html 具备真实的 documentElement 语义。
html.style = {
  props: new Map(),
  setProperty(k, v) { this.props.set(k, v) },
  getPropertyValue(k) { return this.props.get(k) ?? '' },
  removeProperty(k) { this.props.delete(k) },
  cssText: '',
}

const documentStub = {
  head,
  body,
  documentElement: html,
  createElement: tag => new StubElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { documentStub._listeners ??= new Map(); if (!documentStub._listeners.has(type)) documentStub._listeners.set(type, new Set()); documentStub._listeners.get(type).add(fn) },
  removeEventListener: (type, fn) => { documentStub._listeners?.get(type)?.delete(fn) },
  listenerCount: type => documentStub._listeners?.get(type)?.size ?? 0,
  /** 触发监听器（供测试驱动 pointermove / pointerleave）。 */
  dispatch: (type, event) => {
    for (const fn of documentStub._listeners?.get(type) ?? []) fn(event)
  },
}

const timers = []
/** window 级监听器（插件在 resize 时刷新几何）。 */
const windowListeners = new Map()
const windowStub = {
  innerHeight: 900,
  /* 对话区尚未挂载时的兜底会读视口宽度（折叠态中栏≈视口宽）。
   * 给成与 [33]/[34] 场景一致的 1020，使兜底值可与实测值直接比较。 */
  innerWidth: 1020,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearTimeout: () => {},
  requestAnimationFrame: fn => { timers.push({ fn, ms: 0 }); return timers.length },
  cancelAnimationFrame: () => {},
  addEventListener: (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(fn)
  },
  removeEventListener: (type, fn) => { windowListeners.get(type)?.delete(fn) },
  listenerCount: type => windowListeners.get(type)?.size ?? 0,
}

globalThis.document = documentStub
globalThis.window = windowStub
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame
globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
  setItem(k, v) { this.store.set(k, v) },
  removeItem(k) { this.store.delete(k) },
}
globalThis.AbortController = globalThis.AbortController ?? class {
  constructor() { this.signal = { aborted: false } }
  abort() { this.signal.aborted = true }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Cordis 桩
 * ══════════════════════════════════════════════════════════════════════════ */

/** 记录所有注册的 effect，便于断言与统一 dispose。 */
const effects = []
/** 记录 ctx.inject 的调用（依赖名 + 是否执行了回调）。 */
const injections = []
/** 记录 slots.register 的调用。 */
const registrations = []
/** 记录 slots.inject 的调用。 */
const slotInjections = []

const services = new Map()

function makeCtx(parentEffects) {
  const base = {
    /** 已注册的 effect 清理函数。 */
    _disposers: parentEffects,
    get(name) { return services.get(name) },
    effect(callback, label) {
      const dispose = callback()
      const entry = { label, dispose, disposed: false }
      base._disposers.push(entry)
      return () => {
        if (entry.disposed) return
        entry.disposed = true
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(names, callback) {
      const executed = names.every(name => services.has(name))
      injections.push({ names, executed })
      if (!executed) return () => {}
      // 用子 ctx 调回调（官方语义：回调拿到 scope）。
      const scope = makeCtx(base._disposers)
      callback(scope)
      return () => {}
    },
  }
  // 真实 Cordis 把服务同时暴露为 `ctx.<name>` 属性与 `ctx.get(name)`。
  // 用 Proxy 而不是预定义属性：服务可能在 ctx 创建之后才注册。
  return new Proxy(base, {
    has(target, prop) { return Reflect.has(target, prop) || services.has(String(prop)) },
    get(target, prop) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      const name = String(prop)
      if (services.has(name)) return services.get(name)
      return undefined
    },
  })
}

const rootEffects = []
const ctx = makeCtx(rootEffects)

/* ── 服务 ───────────────────────────────────────────────────────────────── */

const calls = {
  openSession: [], startSession: [], forkSession: [], pinSession: [], unpinSession: [],
  archiveSession: [], unarchiveSession: [], renameSession: [], renameWorkspace: [],
  deleteWorkspace: [], insertWorkspaceBefore: [], createWorkspace: [], search: [], pickDirectory: [],
}

services.set('slots', {
  inject(key, callback) {
    slotInjections.push(key)
    // 模拟「座位已声明」：立即执行注册回调。
    return callback()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
})

services.set('uiWorkspace', {
  openSession: id => { calls.openSession.push(id) },
  startSession: workspaceId => { calls.startSession.push(workspaceId) },
  forkSession: id => { calls.forkSession.push(id); return Promise.resolve('child') },
  pinSession: id => { calls.pinSession.push(id); return Promise.resolve() },
  unpinSession: id => { calls.unpinSession.push(id); return Promise.resolve() },
  archiveSession: (id, options) => { calls.archiveSession.push({ id, options }); return Promise.resolve() },
  unarchiveSession: id => { calls.unarchiveSession.push(id); return Promise.resolve() },
  pickDirectory: () => { calls.pickDirectory.push(true); return Promise.resolve('/picked') },
})

services.set('workspaces', {
  rename: (id, title) => { calls.renameWorkspace.push({ id, title }); return Promise.resolve() },
  delete: id => { calls.deleteWorkspace.push(id); return Promise.resolve() },
  insertBefore: (id, before) => { calls.insertWorkspaceBefore.push({ id, before }); return Promise.resolve() },
  create: input => { calls.createWorkspace.push(input); return Promise.resolve({ workspaceId: 'w9' }) },
})

services.set('sessions', {
  searchResultLimit: 20,
  search: (query, signal) => { calls.search.push(query); return Promise.resolve({ ok: true, value: { items: [{ sessionId: 's1', snippet: '…' }], hasMore: false } }) },
  using: (id, options, operation) => {
    calls.renameSession.push({ id, source: options?.source })
    return Promise.resolve(operation({ binding: { session: { rename: () => Promise.resolve() } } }))
  },
})

services.set('remote', { $host: { home: '/home/me' }, directoryPicker: { pick: () => Promise.resolve({ ok: true, value: '/native' }) } })

services.set('locale', {
  register: (ns, dicts) => { services.get('locale').registered = { ns, dicts }; return () => {} },
})

services.set('shortcuts', {
  register: options => { services.get('shortcuts').registered = options; return () => {} },
})

/* ══════════════════════════════════════════════════════════════════════════
 * 装载并执行 apply
 * ══════════════════════════════════════════════════════════════════════════ */

let loaded
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    loaded = factory(name => {
      if (name === 'react') return { createElement: () => null, Fragment: Symbol('f'), useState: v => [v, () => {}], useEffect: () => {}, useMemo: f => f(), useCallback: f => f, useRef: () => ({ current: null }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

/** 可传入替代源文件路径，便于对旧版本跑同一套断言（验证断言确实抓得住 bug）。 */
const source = readFileSync(process.argv[2] ?? join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const M = loaded

let pass = 0
const failures = []
function check(name, condition, detail) {
  if (condition) pass++
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ── [1] apply 不抛错 ───────────────────────────────────────────────────── */

let applyError
try {
  M.apply(ctx, {})
} catch (error) {
  applyError = error
}
check('[1] apply 不抛错', applyError === undefined, applyError?.stack ?? '')
check('[2] apply 是函数', typeof M.apply === 'function')
check('[3] inject 声明 slots', Array.isArray(M.inject) && M.inject.includes('slots'), JSON.stringify(M.inject))

/* ── [4] 样式注入 ───────────────────────────────────────────────────────── */

const styleTags = head.children.filter(child => child.tagName === 'STYLE')
check('[4] 样式表已注入 head', styleTags.length === 1, `count=${String(styleTags.length)}`)
check('[5] 样式有 id', styleTags[0]?.id === 'dsh-sidebar-overlay-style', styleTags[0]?.id)
check('[6] 样式内容非空且含自有节点', (styleTags[0]?.textContent?.length ?? 0) > 4000 && styleTags[0].textContent.includes('[data-dsh-fso-panel]'))

/* ── [7] 语言字典注册 ───────────────────────────────────────────────────── */

const localeRegistered = services.get('locale').registered
check('[7] locale.inject 被调用', injections.some(i => i.names.includes('locale')), JSON.stringify(injections))
check('[8] 字典已注册', localeRegistered !== undefined, JSON.stringify(localeRegistered?.ns))
check('[9] 命名空间正确', localeRegistered?.ns === 'floatingSidebarOverlay', localeRegistered?.ns)
check('[10] 含 zh 与 en', localeRegistered?.dicts?.zh !== undefined && localeRegistered?.dicts?.en !== undefined)
check('[11] zh/en 键集一致',
  JSON.stringify(Object.keys(localeRegistered?.dicts?.zh ?? {}).sort()) === JSON.stringify(Object.keys(localeRegistered?.dicts?.en ?? {}).sort()),
  '键集不一致')

/* ── [12] 快捷键注册 ────────────────────────────────────────────────────── */

const shortcutRegistered = services.get('shortcuts').registered
check('[12] shortcuts.inject 被调用', injections.some(i => i.names.includes('shortcuts')))
check('[13] 快捷键已注册', shortcutRegistered !== undefined)
check('[14] 快捷键 id 正确', shortcutRegistered?.id === 'sidebar-overlay.toggle', shortcutRegistered?.id)
check('[15] 快捷键含桌面与 Web 默认值',
  shortcutRegistered?.defaults?.['desktop:windows'] !== undefined && shortcutRegistered?.defaults?.['web:macos'] !== undefined)
check('[16] resolve 返回 handled',
  shortcutRegistered?.resolve?.()?.status === 'handled', JSON.stringify(shortcutRegistered?.resolve?.()))

/* ── [17] 浮层注册 ──────────────────────────────────────────────────────── */

check('[17] 注册进 shell.overlay', slotInjections.includes('shell.overlay'), JSON.stringify(slotInjections))
check('[18] 有一条注册记录', registrations.length === 1, `count=${String(registrations.length)}`)
const registration = registrations[0]
check('[19] 注册 name 正确', registration?.options?.name === 'shell.overlay', registration?.options?.name)
check('[20] 注册 id 正确', registration?.options?.id === 'sidebar-overlay', registration?.options?.id)
check('[21] 注册 locale 正确', registration?.options?.locale === 'floatingSidebarOverlay', registration?.options?.locale)
check('[22] 未声明 children（自建 DOM）', registration?.options?.children === undefined)
check('[23] 注册了组件', typeof registration?.component === 'function')

/* ── [24] 注入面形状 ────────────────────────────────────────────────────── */

let injected
let injectError
try {
  injected = registration.options.inject()
} catch (error) {
  injectError = error
}
check('[24] inject 工厂不抛错', injectError === undefined, injectError?.stack ?? '')

const EXPECTED_FIELDS = [
  'config', 'openSession', 'startSession', 'forkSession', 'renameSession',
  'pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession',
  'renameWorkspace', 'deleteWorkspace', 'insertWorkspaceBefore', 'createWorkspace',
  'searchSessions', 'searchResultLimit', 'pickDirectory', 'notify',
]
for (const field of EXPECTED_FIELDS) {
  check(`[24] 注入面含 ${field}`, injected?.[field] !== undefined, `缺失 ${field}`)
}
check('[24] config 是对象', typeof injected?.config === 'object' && injected.config !== null)
check('[24] searchResultLimit 是数字', typeof injected?.searchResultLimit === 'number', String(injected?.searchResultLimit))
check('[24] hostHome 从 remote 取到', injected?.hostHome === '/home/me', String(injected?.hostHome))

/* ── [24b] 个人信息按钮：账户数据源 + 打开设置 ────────────────────────────
 *
 * 这里验证的是**没有官方座位时**的注入面：`accountSource` 与 `openSettings`
 * 都应为 undefined，浮层因此不渲染个人信息按钮（而不是渲染一个点了没反应的
 * 假按钮）。有座位时解析出的能力由 test.mjs [22] 与 e2e-profile.mjs 覆盖。 */

check('[24b] 注入面带 accountSource 字段（可为 undefined）',
  'accountSource' in (injected ?? {}), `keys=${Object.keys(injected ?? {}).join(',')}`)
check('[24b] slots 没有 settings.launcher 时 accountSource 为 undefined',
  injected?.accountSource === undefined, String(injected?.accountSource))
check('[24b] 注入面带 openSettings 字段（可为 undefined）',
  'openSettings' in (injected ?? {}), `keys=${Object.keys(injected ?? {}).join(',')}`)
check('[24b] slots 没有 sidebar.settings 时 openSettings 为 undefined',
  injected?.openSettings === undefined, String(injected?.openSettings))

/* ── [25] 业务回调真的转发到服务 ────────────────────────────────────────── */

injected.openSession('s1')
check('[25] openSession 转发', calls.openSession.includes('s1'), JSON.stringify(calls.openSession))
injected.startSession('w1')
check('[25] startSession 转发', calls.startSession.includes('w1'), JSON.stringify(calls.startSession))
injected.forkSession('s2')
check('[25] forkSession 转发', calls.forkSession.includes('s2'))
injected.pinSession('s3')
check('[25] pinSession 转发', calls.pinSession.includes('s3'))
injected.unpinSession('s3')
check('[25] unpinSession 转发', calls.unpinSession.includes('s3'))
injected.archiveSession('s4', { stopActivity: true })
check('[25] archiveSession 带 options 转发',
  calls.archiveSession.some(c => c.id === 's4' && c.options?.stopActivity === true),
  JSON.stringify(calls.archiveSession))
injected.unarchiveSession('s5')
check('[25] unarchiveSession 转发', calls.unarchiveSession.includes('s5'))
injected.renameWorkspace('w1', '新名字')
check('[25] renameWorkspace 转发', calls.renameWorkspace.some(c => c.id === 'w1' && c.title === '新名字'))
injected.deleteWorkspace('w2')
check('[25] deleteWorkspace 转发', calls.deleteWorkspace.includes('w2'))
injected.insertWorkspaceBefore('w3', 'w1')
check('[25] insertWorkspaceBefore 转发', calls.insertWorkspaceBefore.some(c => c.id === 'w3' && c.before === 'w1'))
injected.createWorkspace({ path: '/p' })
check('[25] createWorkspace 转发', calls.createWorkspace.some(c => c.path === '/p'))

/* ── [26] 异步回调 ──────────────────────────────────────────────────────── */

await Promise.resolve(injected.renameSession('s6', '标题'))
check('[26] renameSession 用 workspaceOperation source',
  calls.renameSession.some(c => c.id === 's6' && c.source === 'workspaceOperation'),
  JSON.stringify(calls.renameSession))

const searchResult = await injected.searchSessions('查询', undefined)
check('[26] searchSessions 解包 RemoteResult',
  Array.isArray(searchResult?.items) && searchResult.items.length === 1,
  JSON.stringify(searchResult))
check('[26] searchSessions 转发查询词', calls.search.includes('查询'))

const picked = await injected.pickDirectory()
check('[26] pickDirectory 优先用 uiWorkspace', picked === '/picked', String(picked))
check('[26] pickDirectory 走 uiWorkspace 而非 remote', calls.pickDirectory.length === 1)

/* ── [27] notify 不抛错 ─────────────────────────────────────────────────── */

let notifyError
try {
  injected.notify('toast.archived', { title: '某会话' })
  injected.notify('unknown.key')
} catch (error) {
  notifyError = error
}
check('[27] notify 不抛错', notifyError === undefined, notifyError?.message)
const toastNodes = body.children.filter(child => child.getAttribute?.('data-dsh-fso-toast') !== null)
check('[27] notify 创建了 toast 节点', toastNodes.length >= 1, `count=${String(toastNodes.length)}`)

/* ── [28] 总开关 API ────────────────────────────────────────────────────── */

const api = globalThis.window.__dshFloatingSidebarOverlay
check('[28] 总开关 API 已挂载', api !== undefined)
check('[28] API 含全部方法',
  typeof api?.toggle === 'function' && typeof api?.enable === 'function'
  && typeof api?.disable === 'function' && typeof api?.isEnabled === 'function' && typeof api?.isOpen === 'function')
check('[28] 默认启用', api?.isEnabled() === true)
check('[28] 默认未打开', api?.isOpen() === false)

api.disable()
check('[28] disable 后 isEnabled=false', api.isEnabled() === false)
check('[28] disable 写了 html 属性', html.getAttribute('data-dsh-fso') === 'off', String(html.getAttribute('data-dsh-fso')))
api.enable()
check('[28] enable 后 isEnabled=true', api.isEnabled() === true)
check('[28] enable 清了 html 属性', html.getAttribute('data-dsh-fso') === null)
check('[28] toggle 返回新状态', api.toggle() === false)
api.toggle()
check('[28] 再 toggle 回到启用', api.isEnabled() === true)

/* ── [29] 指针监听已挂上 ────────────────────────────────────────────────── */

check('[29] 挂载了 pointermove 监听', documentStub.listenerCount('pointermove') >= 1,
  String(documentStub.listenerCount('pointermove')))
check('[29] 挂载了 pointerleave 监听', documentStub.listenerCount('pointerleave') >= 1)

/* ── [30] 标题栏高度写入 CSS 变量 ───────────────────────────────────────── */

check('[30] 写了 --dsh-fso-top 变量',
  html.style.getPropertyValue('--dsh-fso-top') !== '', `value="${html.style.getPropertyValue('--dsh-fso-top')}"`)

/* ── [31] 指针驱动开合（不依赖真实几何）────────────────────────────────── */

{
  // 让热区判定成立：clientX 小、clientY 在标题栏下方。
  // isCollapsed 需要官方 frame 节点；桩里 querySelector 返回 null → 视为未折叠，
  // 而默认 onlyWhenCollapsed=true，所以这里先关掉该限制来验证指针通路。
  check('[31] 指针事件不抛错', (() => {
    try {
      documentStub.dispatch?.('pointermove', { clientX: 5, clientY: 200 })
      return true
    } catch { return false }
  })())
}

/* ── 开关状态写在卡片自身属性上（不在 html 上）────────────────────────── */

{
  // 桩的 querySelector 不实现选择器，所以直接给 document 挂一个假卡片来验证
  // setOpen 的写入目标。真实浏览器里由 React 渲染出该节点。
  const fakeCard = new StubElement('div')
  fakeCard.setAttribute('data-dsh-fso-card', '')
  /* panel 是判定用的几何来源。
   * 关键区别：panel 自身没有 transform，它的矩形是**布局矩形**，动画期间恒定；
   * 而 card 有 translateX 过渡，getBoundingClientRect() 会随动画变化。
   * 这里给 card 一个「还在屏幕外」的抖动矩形，用来证明判定没有误用它。 */
  const fakePanel = new StubElement('div')
  fakePanel.setAttribute('data-dsh-fso-panel', '')
  fakePanel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 296, bottom: 900, width: 296, height: 900 })
  fakeCard.getBoundingClientRect = () => ({ left: -308, top: 40, right: -28, bottom: 900, width: 280, height: 860 })
  const collapsedFrame = new StubElement('div')
  collapsedFrame.setAttribute('class', 'BynINW_frame')
  collapsedFrame.setAttribute('data-sidebar-collapsed', 'true')
  const previousQuery = documentStub.querySelector
  documentStub.querySelector = selector => {
    if (selector === '[data-dsh-fso-card]') return fakeCard
    if (selector === '[data-dsh-fso-panel]') return fakePanel
    // isCollapsed 查的是官方 frame；桩里给一个带标记元素让折叠判定成立。
    if (String(selector).includes('_frame')) return collapsedFrame
    return previousQuery?.call(documentStub, selector) ?? null
  }

  /* 验证开合状态机：
   *   1. 指针进入左边缘热区 → 卡片拿到 data-open；
   *   2. 开关状态不写在 html 上（避免全局样式重算导致闪烁）；
   *   3. 指针移出卡片 → data-open 被移除。 */

  // 先用总开关复位，确保从干净的关闭态开始。
  globalThis.window.__dshFloatingSidebarOverlay?.disable()
  globalThis.window.__dshFloatingSidebarOverlay?.enable()

  // 1. 进入热区
  documentStub.dispatch?.('pointermove', { clientX: 5, clientY: 300 })
  check('[31b] 进入热区后卡片带 data-open',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)
  check('[31b] 开合状态不写在 html 上',
    html.getAttribute('data-dsh-fso-open') === null)

  /* [31c] 回归：动画期间不得因视觉矩形而误收回。
   *
   * 这正是真机上「鼠标触发时闪烁抽搐」的根因。旧实现用 card 的
   * getBoundingClientRect()（受 transform 影响）判定「指针是否离开」，
   * 而卡片此时还在屏幕外（right = -28），于是 clientX=5 也被判成「已离开」
   * → 收回 → 指针仍在热区 → 又打开 → 每帧一轮。
   *
   * 现在判定读 panel 的布局矩形，与动画相位无关，指针停在热区内必须保持打开。
   *
   * 注意两点，否则断言会漏抓：
   *   · 先跑一遍排队的 rAF 回调 —— 旧实现把「量矩形」放在 rAF 里（此时才填上
   *     那个会抖动的 cardRect）；不跑这一帧，旧实现的 cardRect 恒为 null，反而
   *     因为「未测量就不判定」而侥幸不振荡，断言也就抓不到 bug 了。
   *     新实现在打开那一刻同步量 panel，不依赖 rAF，跑不跑都无影响。
   *   · 必须逐次记录状态而不是只看最后一次 —— 振荡是「开/关交替」的，
   *     偶数次事件后恰好停在「开」，只测末态会把抽搐当成正常。 */
  for (const timer of timers.splice(0)) if (typeof timer.fn === 'function') timer.fn()

  const flickerStates = []
  for (let i = 0; i < 12; i++) {
    documentStub.dispatch?.('pointermove', { clientX: 5, clientY: 300 })
    flickerStates.push(fakeCard.hasAttribute('data-open'))
  }
  const flips = flickerStates.filter((state, index) => index > 0 && state !== flickerStates[index - 1]).length
  check('[31c] 动画期间指针停在热区内不会误收回（闪烁回归）',
    flickerStates.every(state => state === true) && flips === 0,
    `状态序列=${flickerStates.map(s => (s ? '开' : '关')).join('')}，翻转 ${flips} 次（旧实现在这里每帧开合）`)

  /* [31d] 回归：热区与卡片左边缘之间的缝不算「离开」。
   * 卡片布局左边缘 = gap(8)，热区是 [0, 24]，指针停在 x=4 时在卡片之外
   * 但在热区之内，不能收起，否则同样会振荡。 */
  documentStub.dispatch?.('pointermove', { clientX: 4, clientY: 300 })
  check('[31d] 热区与卡片之间的缝不算「离开」',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  // 3. 指针移出卡片（panel 矩形是 0..296，x=900 远在其外）
  documentStub.dispatch?.('pointermove', { clientX: 900, clientY: 900 })
  check('[31b] 指针移出后卡片 data-open 被移除',
    !fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  documentStub.querySelector = previousQuery
}

/* ── [33] 热区真的按「对话内容列左边缘 × 40%」接线（接线验证）───────────
 *
 * 纯函数测试证明公式正确，但证明不了 apply 里**确实用了它**。这一节用真实
 * 几何走一遍状态机：模拟 1020px 窗口（官方内容列 clamp 后 680 → 左边缘 170），
 * 热区 = ceil(170 × 0.4) = 68。
 *
 * 断言 x=60（在 68 之内）能触发、x=100（在 68 之外）不能触发。
 *
 * 对照：改动前 trigger 固定 24，x=60 是**不会**触发的 —— 所以这条断言对
 * 旧实现会失败，不是摆设。
 * ------------------------------------------------------------------------- */
{
  const fakeCard = new StubElement('div')
  fakeCard.setAttribute('data-dsh-fso-card', '')
  const fakePanel = new StubElement('div')
  fakePanel.setAttribute('data-dsh-fso-panel', '')
  fakePanel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 296, bottom: 900, width: 296, height: 900 })

  /* 官方对话区容器：占满 1020px 视口；内容列 clamp(680, 1020*.64, 920) = 680，
   * 居中 → 左边缘 (1020−680)/2 = 170。与真机截图量到的数值一致。 */
  const fakeConversation = new StubElement('div')
  fakeConversation.setAttribute('data-conversation-content', '')
  fakeConversation.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1020, bottom: 900, width: 1020, height: 900 })

  const collapsedFrame = new StubElement('div')
  collapsedFrame.setAttribute('class', 'BynINW_frame')
  collapsedFrame.setAttribute('data-sidebar-collapsed', 'true')

  const previousQuery = documentStub.querySelector
  documentStub.querySelector = selector => {
    if (selector === '[data-dsh-fso-card]') return fakeCard
    if (selector === '[data-dsh-fso-panel]') return fakePanel
    if (selector === '[data-conversation-content]') return fakeConversation
    if (String(selector).includes('_frame')) return collapsedFrame
    return previousQuery?.call(documentStub, selector) ?? null
  }
  /* 如实模拟浏览器的 computed value：自定义属性只替换 `var()`，
   * **不求值** `clamp()` / `calc()`。已用 headless Chrome 实测，1020px 视口下
   * `--dsh-chat-content-width` 的 computed value 就是这串 token：
   *   "clamp(680px, calc(1020px * .64), 920px)"
   * 桩若返回 '680px' 会比浏览器更聪明，从而掩盖「插件其实读不到纯数值、
   * 必须自己按公式算」这一事实。 */
  const previousComputed = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({
    getPropertyValue: name => (name === '--dsh-chat-content-width'
      ? 'clamp(680px, calc(1020px * .64), 920px)'
      : ''),
  })

  globalThis.window.__dshFloatingSidebarOverlay?.disable()
  globalThis.window.__dshFloatingSidebarOverlay?.enable()

  /* 先让插件重新测量：resize 会刷新热区缓存（真实里窗口变化也是这条路径）。 */
  for (const fn of windowListeners.get('resize') ?? []) fn({})

  // x=60：旧实现（触发区 24px）不会触发，新实现（68px）应触发。
  documentStub.dispatch?.('pointermove', { clientX: 60, clientY: 300 })
  check('[33] 按 40% 计算后 x=60 能触发（旧实现 24px 热区不会）',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  // 收起后测边界外：x=100 在热区（68）之外，不应触发。
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  check('[33] 指针移出后已收起（前置条件）', !fakeCard.hasAttribute('data-open'))

  documentStub.dispatch?.('pointermove', { clientX: 100, clientY: 300 })
  check('[33] 热区之外（x=100 > 68）不触发',
    !fakeCard.hasAttribute('data-open'),
    'x=100 被误判为热区')

  // 阈值内侧紧邻：x=67 应触发（热区 = 68）。
  documentStub.dispatch?.('pointermove', { clientX: 67, clientY: 300 })
  check('[33] 阈值内侧 x=67 触发',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  // 端点：x=68 恰好在热区边界上，应触发（ceil 后边界含端点）。
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 68, clientY: 300 })
  check('[33] 端点 x=68 触发（含端点）',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  // 标题栏之上仍然不触发（原语义保持不变）。插件在热路径读的是 html 上的
  // **内联** `--dsh-fso-top`，所以这里直接写该变量来构造标题栏高度。
  const savedTop = html.style.getPropertyValue('--dsh-fso-top')
  html.style.setProperty('--dsh-fso-top', '40px')
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 10, clientY: 5 })
  check('[33] 标题栏内（y < clearance=40）仍不触发',
    !fakeCard.hasAttribute('data-open'),
    '标题栏区域被误判为热区')
  // 标题栏下方同一 x 应触发。
  documentStub.dispatch?.('pointermove', { clientX: 10, clientY: 300 })
  check('[33] 标题栏下方同一 x 触发（对照）',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)
  if (savedTop === '') html.style.removeProperty('--dsh-fso-top')
  else html.style.setProperty('--dsh-fso-top', savedTop)

  globalThis.getComputedStyle = previousComputed
  documentStub.querySelector = previousQuery
}

/* ── [34] 热区必须取「主对话区」，不能用右侧栏里的子智能体对话区 ──────────
 *
 * 真实缺陷（已核实官方源码）：`ui-subagent` 的「子智能体对话」在右侧栏里通过
 *   sidebar.chat.conversation → conversation.content（variant: 'embedded'）
 * 渲染**同一个** Conversation 组件，所以页面上会同时存在**两个**
 * `[data-conversation-content]`。右侧栏那个实例在窗口右边、容器窄得多，
 * 用它算「内容列左边缘」会得到一个大出一个量级的值 → 热区盖住半个窗口。
 *
 * 官方给右侧栏容器标了 `data-sidebar-right-session`，插件据此排除。
 * 这里刻意把右侧栏实例放在**文档顺序更前**（querySelector 会先命中它），
 * 确保断言真的在考「排除逻辑」而不是「碰巧顺序对」。
 * ------------------------------------------------------------------------- */
{
  const fakeCard = new StubElement('div')
  fakeCard.setAttribute('data-dsh-fso-card', '')
  const fakePanel = new StubElement('div')
  fakePanel.setAttribute('data-dsh-fso-panel', '')
  fakePanel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 296, bottom: 900, width: 296, height: 900 })

  // 右侧栏内的嵌入对话：容器在 x=700 起、宽 320 → 若被选中会算出巨大热区。
  const rightbarOwner = new StubElement('div')
  rightbarOwner.setAttribute('data-sidebar-right-session', 'sub-1')
  const rightbarConversation = new StubElement('div')
  rightbarConversation.setAttribute('data-conversation-content', '')
  rightbarConversation.getBoundingClientRect = () => ({ left: 700, top: 0, right: 1020, bottom: 900, width: 320, height: 900 })
  rightbarOwner.appendChild(rightbarConversation)

  // 主对话区：1020px 视口 → 内容列 680 → 左边缘 170 → 热区 = ceil(170×0.4) = 68。
  const mainConversation = new StubElement('div')
  mainConversation.setAttribute('data-conversation-content', '')
  mainConversation.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1020, bottom: 900, width: 1020, height: 900 })

  const collapsedFrame = new StubElement('div')
  collapsedFrame.setAttribute('class', 'BynINW_frame')
  collapsedFrame.setAttribute('data-sidebar-collapsed', 'true')

  /* 文档顺序：右侧栏实例在前 —— 朴素的 querySelector 会先命中它。 */
  const conversationNodes = [rightbarConversation, mainConversation]

  const previousQuery = documentStub.querySelector
  const previousQueryAll = documentStub.querySelectorAll
  documentStub.querySelector = selector => {
    if (selector === '[data-dsh-fso-card]') return fakeCard
    if (selector === '[data-dsh-fso-panel]') return fakePanel
    if (selector === '[data-conversation-content]') return conversationNodes[0]
    if (String(selector).includes('_frame')) return collapsedFrame
    return previousQuery?.call(documentStub, selector) ?? null
  }
  documentStub.querySelectorAll = selector =>
    (selector === '[data-conversation-content]' ? conversationNodes : previousQueryAll?.call(documentStub, selector) ?? [])

  /* 同 [33]：如实返回浏览器的 token 流（不求值 clamp/calc），
   * 逼插件走自己的公式，而不是靠桩喂一个现成的 px。 */
  const previousComputed = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({
    getPropertyValue: name => (name === '--dsh-chat-content-width'
      ? 'clamp(680px, calc(1020px * .64), 920px)'
      : ''),
  })

  globalThis.window.__dshFloatingSidebarOverlay?.disable()
  globalThis.window.__dshFloatingSidebarOverlay?.enable()
  for (const fn of windowListeners.get('resize') ?? []) fn({})

  /* 断言 1：x=60 能触发 —— 说明取到的是主对话区（热区 68）。 */
  documentStub.dispatch?.('pointermove', { clientX: 60, clientY: 300 })
  check('[34] 存在两个对话区时仍按主对话区算热区（x=60 触发）',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}`)

  /* 断言 2：真正区分两个实例。
   * 主对话区热区 = ceil(170×0.4) = 68；若误用右侧栏实例（容器 left=700、
   * width=320 → 内容列 320 退化为整宽 → left=700），热区会是
   * ceil(700×0.4) = 280。
   * 所以 x=150 是判别点：在 68 之外、却在 280 之内。
   *   · 取主对话区 → 150 > 68 → 不触发（正确）
   *   · 误用右侧栏 → 150 ≤ 280 → 触发（缺陷）
   * 用 x=150 而不是更大的值，是因为 40% 下两者间距比 70% 时窄，
   * 判别点必须落在 (68, 280) 之间才有效。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  check('[34] 前置：已收起', !fakeCard.hasAttribute('data-open'))

  documentStub.dispatch?.('pointermove', { clientX: 150, clientY: 300 })
  check('[34] x=150 不触发（未误用右侧栏对话区的几何）',
    !fakeCard.hasAttribute('data-open'),
    'x=150 触发了 —— 说明取的是右侧栏里那个对话区（其热区为 280）')

  /* ── 断言：边界含端点（浮点取整回归）──────────────────────────────────
   *
   * 某些比例下 `内容列左边缘 × ratio` 会算出 `x.999999…`。40% 本身是整数，
   * 但 `ceil` 必须在位 —— 这里验证端点 68 被包含、69 不被包含。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 68, clientY: 300 })
  check('[34] 热区端点含 68（含端点）',
    fakeCard.hasAttribute('data-open'),
    'x=68 未触发 —— 热区边界被吃掉 1px')

  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 69, clientY: 300 })
  check('[34] 端点之外 69 不触发',
    !fakeCard.hasAttribute('data-open'),
    'x=69 触发了 —— 热区比预期宽')

  /* ── 断言：热路径零 DOM 查询 ──────────────────────────────────────────
   *
   * 已打开且指针在热区内移动时，pointermove 里**不应**出现任何
   * getComputedStyle / getBoundingClientRect / querySelector。
   * 做法：先开卡（冷路径，允许查 DOM），**清零计数**后再移动，把两者分开 ——
   * 否则会把「开卡那一次」的固定开销误读成热路径开销。 */
  documentStub.dispatch?.('pointermove', { clientX: 60, clientY: 300 })
  check('[34] 前置：卡片已打开', fakeCard.hasAttribute('data-open'))

  const counters = { computed: 0, rect: 0, qs: 0, qsa: 0 }
  const savedComputedStyle = globalThis.getComputedStyle
  const savedRect = StubElement.prototype.getBoundingClientRect
  globalThis.getComputedStyle = (...args) => { counters.computed += 1; return savedComputedStyle(...args) }
  StubElement.prototype.getBoundingClientRect = function (...args) { counters.rect += 1; return savedRect.apply(this, args) }
  const savedQuery = documentStub.querySelector
  const savedQueryAll = documentStub.querySelectorAll
  documentStub.querySelector = (...args) => { counters.qs += 1; return savedQuery(...args) }
  documentStub.querySelectorAll = (...args) => { counters.qsa += 1; return savedQueryAll(...args) }

  for (let i = 0; i < 50; i++) documentStub.dispatch?.('pointermove', { clientX: 60, clientY: 300 })

  globalThis.getComputedStyle = savedComputedStyle
  StubElement.prototype.getBoundingClientRect = savedRect
  documentStub.querySelector = savedQuery
  documentStub.querySelectorAll = savedQueryAll

  check('[34] 热路径零 DOM 查询（已打开 + 热区内移动 50 次）',
    counters.computed === 0 && counters.rect === 0 && counters.qs === 0 && counters.qsa === 0,
    `getComputedStyle=${counters.computed}, getBoundingClientRect=${counters.rect}, querySelector=${counters.qs}, querySelectorAll=${counters.qsa}`)

  globalThis.getComputedStyle = previousComputed
  documentStub.querySelector = previousQuery

  /* 断言 3：单调时钟。低频重测若以 `Date.now()` 为基准，系统回拨会让
   * `now - last` 变负、低频重测长期失效。这里把 performance.now 拨回
   * 10 秒，再看插件是否仍会重测（缓存跟上几何变化）。
   *
   * 判别点：把内容列宽度改成 200px → 左边缘 (1020−200)/2 = 410
   *   → 新热区 = ceil(410×0.4) = 164（旧缓存热区是 68）。
   * x=100 在**新**热区（164）内、但在**旧**缓存热区（68）外：
   *   · 会重测 → 首次事件重测得 164，下一次事件 100 ≤ 164 → 打开；
   *   · 不重测（Date.now 回拨失效）→ 100 > 68 → 永不打开。 */
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => (name === '--dsh-chat-content-width' ? '200px' : '') })
  const realPerfNow = performance.now.bind(performance)
  const originalPerfNow = performance.now
  let shifted = false
  try {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => (shifted ? realPerfNow() - 10000 : realPerfNow()),
    })
    shifted = true
  } catch { /* 无法改时钟：后面的断言会因未重测而失败，正好暴露环境问题 */ }
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 100, clientY: 300 })
  documentStub.dispatch?.('pointermove', { clientX: 100, clientY: 300 })
  check('[34] 时钟回拨后低频重测仍然生效（单调时钟）',
    fakeCard.hasAttribute('data-open'),
    `data-open=${String(fakeCard.getAttribute('data-open'))}（回拨后未重测热区，热区仍停留在旧值 68）`)
  try {
    Object.defineProperty(performance, 'now', { configurable: true, value: originalPerfNow })
  } catch { /* 忽略 */ }

  /* 断言 4：页面上**只剩右侧栏那个**对话区时（主对话区尚未挂载），
   * 不能退而使用它的几何 —— 否则热区会大到 602，盖住半个窗口。
   * 正确行为是走视口兜底：1020px 视口 → 按 680 内容列算 → 热区 ≈119。 */
  documentStub.querySelectorAll = selector =>
    (selector === '[data-conversation-content]' ? [rightbarConversation] : previousQueryAll?.call(documentStub, selector) ?? [])
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  for (const fn of windowListeners.get('resize') ?? []) fn({})
  /* 收起：用明确的区外坐标。注意 y 不能取 900 —— panel 的 bottom 就是 900，
   * 加上 slack（8）后 `900 > 908` 为 false，不会被判为离开；
   * 而 x=2000 已远超 panel 右缘（296）+ slack，必然离开。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  check('[34] 前置：已收起（准备验证只剩右侧栏实例的场景）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === false,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())}`)

  /* 断言 4：页面上**只剩右侧栏那个**对话区时（主对话区尚未挂载），
   * 不能退而使用它的几何。
   *
   * 数值：误用右侧栏实例（left=700）会得到热区 ceil(700×0.4) = 280；
   * 正确走视口兜底（1020px 视口 → 内容列 680 → 左边缘 170）则得 68。
   *
   * 需要两条断言才能把三种情况分开：
   *   · x=60  → 兜底(68) 命中；右侧栏(280) 也命中；退化成 24 → 不命中
   *   · x=150 → 兜底(68) 不命中；右侧栏(280) 命中
   * 所以 (x=60 命中) + (x=150 不命中) 唯一确定「走了视口兜底」。 */
  documentStub.querySelectorAll = selector =>
    (selector === '[data-conversation-content]' ? [rightbarConversation] : previousQueryAll?.call(documentStub, selector) ?? [])
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  for (const fn of windowListeners.get('resize') ?? []) fn({})
  /* 收起：用明确的区外坐标。注意 y 不能取 900 —— panel 的 bottom 就是 900，
   * 加上 slack（8）后 `900 > 908` 为 false，不会被判为离开；
   * 而 x=2000 已远超 panel 右缘（296）+ slack，必然离开。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  check('[34] 前置：已收起（准备验证只剩右侧栏实例的场景）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === false,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())}`)

  documentStub.dispatch?.('pointermove', { clientX: 60, clientY: 300 })
  check('[34] 主对话区缺失时走视口兜底（x=60 触发，说明兜底 68 而非退化成 24）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === true,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())}（兜底未生效）`)

  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 150, clientY: 300 })
  check('[34] 只剩右侧栏对话区时不误用其几何（x=150 不触发，其热区会是 280）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === false,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())} — x=150 触发了，说明取了右侧栏实例的几何`)

  globalThis.getComputedStyle = previousComputed
  documentStub.querySelector = previousQuery
  documentStub.querySelectorAll = previousQueryAll
}

/* ── [35] 对话区 header 必须整块排除在热区之外 ────────────────────────────
 *
 * 真实缺陷（用户报告）：点「对话 / 轨迹」tab、会话标题时也会浮出侧边栏。
 *
 * 根因：官方 `ConversationRoot` 的结构是
 *   root (flex column)
 *     ├── header   ← 对话/轨迹 tab、会话标题、面包屑（min-height:76px）
 *     └── body = `[data-conversation-content]`（flex:1，正好在 header 之下）
 * 而插件原先只用「窗口标题栏高度」（Windows 上 40px）当上边界，
 * **完全没有排除对话区自己的 header**（76px 起），于是整块 header 都落在
 * 热区里（y ∈ [40, 116) 全部命中）。
 *
 * 修法：上边界取「对话内容容器顶边」与「窗口标题栏底边」的较大值。
 * 下面用真实几何验证：视口 1020x900，窗口标题栏 40，对话 header 76 →
 * 对话内容容器 top = 116 → 热区上边界 = 116。
 *   · y=100（header 内）→ 不触发
 *   · y=120（header 之下）→ 触发
 * ------------------------------------------------------------------------- */
{
  const fakeCard = new StubElement('div')
  fakeCard.setAttribute('data-dsh-fso-card', '')
  const fakePanel = new StubElement('div')
  fakePanel.setAttribute('data-dsh-fso-panel', '')
  fakePanel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 296, bottom: 900, width: 296, height: 900 })

  /* 对话内容容器：top=116（= 窗口标题栏 40 + 对话区 header 76），
   * left=0、width=1020 → 热区右边界仍为 ceil(170×0.4) = 68。 */
  const CONVERSATION_TOP = 116
  const fakeConversation = new StubElement('div')
  fakeConversation.setAttribute('data-conversation-content', '')
  fakeConversation.getBoundingClientRect = () => ({
    left: 0, top: CONVERSATION_TOP, right: 1020, bottom: 900, width: 1020, height: 900 - CONVERSATION_TOP,
  })

  const collapsedFrame = new StubElement('div')
  collapsedFrame.setAttribute('class', 'BynINW_frame')
  collapsedFrame.setAttribute('data-sidebar-collapsed', 'true')

  const previousQuery = documentStub.querySelector
  const previousQueryAll = documentStub.querySelectorAll
  documentStub.querySelector = selector => {
    if (selector === '[data-dsh-fso-card]') return fakeCard
    if (selector === '[data-dsh-fso-panel]') return fakePanel
    if (selector === '[data-conversation-content]') return fakeConversation
    if (String(selector).includes('_frame')) return collapsedFrame
    return previousQuery?.call(documentStub, selector) ?? null
  }
  documentStub.querySelectorAll = selector =>
    (selector === '[data-conversation-content]' ? [fakeConversation] : previousQueryAll?.call(documentStub, selector) ?? [])

  const previousComputed = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({
    getPropertyValue: name => (name === '--dsh-chat-content-width'
      ? 'clamp(680px, calc(1020px * .64), 920px)'
      : ''),
  })

  // 窗口标题栏高度：插件读 html 上的内联 `--dsh-fso-top`（由另一个 effect 写入）。
  const savedTop = html.style.getPropertyValue('--dsh-fso-top')
  html.style.setProperty('--dsh-fso-top', '40px')

  globalThis.window.__dshFloatingSidebarOverlay?.disable()
  globalThis.window.__dshFloatingSidebarOverlay?.enable()
  for (const fn of windowListeners.get('resize') ?? []) fn({})

  /* 断言 1：纯函数层面 —— 上边界取两者较大值。 */
  check('[35] triggerTopEdge 取「对话区顶边」与「标题栏」的较大值',
    M.__triggerTopEdge(116, 40) === 116 && M.__triggerTopEdge(20, 40) === 40,
    `${String(M.__triggerTopEdge(116, 40))} / ${String(M.__triggerTopEdge(20, 40))}`)

  /* 断言 2：header 内不触发。
   * header 占 y ∈ [40, 116)。x=30 在热区宽度（68）之内 —— 原先这里会触发。 */
  documentStub.dispatch?.('pointermove', { clientX: 30, clientY: 100 })
  check('[35] 对话区 header 内（y=100）不触发 tab/标题',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === false,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())} — header 内触发了`)

  // 再试几个 header 内的位置，确保整条都排除（不只是某一个 y）。
  const headerYs = [41, 60, 90, 114]
  let headerHits = 0
  for (const yy of headerYs) {
    documentStub.dispatch?.('pointermove', { clientX: 30, clientY: 100 }) // 先确保收起态
    documentStub.dispatch?.('pointermove', { clientX: 30, clientY: yy })
    if (globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === true) headerHits += 1
  }
  check('[35] header 整条（y=41/60/90/114）都不触发',
    headerHits === 0, `${headerHits} 个位置误触发`)

  /* 断言 3：header 之下紧接着的位置仍应触发（防止修成「永不触发」）。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 30, clientY: 120 })
  check('[35] header 之下（y=120）仍能触发（对照）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === true,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())}`)

  /* 断言 4：向上越过 header 底边一像素即不触发（边界精确性）。 */
  documentStub.dispatch?.('pointermove', { clientX: 2000, clientY: 400 })
  documentStub.dispatch?.('pointermove', { clientX: 30, clientY: 115 })
  check('[35] header 底边之上（y=115）不触发（边界精确）',
    globalThis.window.__dshFloatingSidebarOverlay?.isOpen() === false,
    `isOpen=${String(globalThis.window.__dshFloatingSidebarOverlay?.isOpen())}`)

  if (savedTop === '') html.style.removeProperty('--dsh-fso-top')
  else html.style.setProperty('--dsh-fso-top', savedTop)

  globalThis.getComputedStyle = previousComputed
  documentStub.querySelector = previousQuery
  documentStub.querySelectorAll = previousQueryAll
}

/* ── [32] dispose 清理 ──────────────────────────────────────────────────── */

let disposeError
try {
  for (const entry of rootEffects) {
    if (typeof entry.dispose === 'function') entry.dispose()
  }
} catch (error) {
  disposeError = error
}
check('[32] dispose 不抛错', disposeError === undefined, disposeError?.stack ?? '')
check('[32] 样式表被移除', styleTags[0]?.removed === true)
check('[32] window API 被清理', globalThis.window.__dshFloatingSidebarOverlay === undefined)
check('[32] html 标记属性被清理', html.getAttribute('data-dsh-fso') === null && html.getAttribute('data-dsh-fso-open') === null)
check('[32] CSS 变量被清理', html.style.getPropertyValue('--dsh-fso-top') === '')
check('[32] 指针监听被摘掉', documentStub.listenerCount('pointermove') === 0, String(documentStub.listenerCount('pointermove')))

/* ── 结果 ───────────────────────────────────────────────────────────────── */

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
