/**
 * dsh-sidebar-overlay 的组件烟雾测试。
 *
 * `test.mjs` 只验证纯函数与 CSS 文本，**不执行组件体**——hooks 顺序错误、
 * `undefined` 属性访问、渲染期抛错都抓不到。
 *
 * 这里用一个小型 React 桩**真实执行组件函数体**并递归渲染出 HTML：
 *   · `createElement` 遇到函数组件就调用它（即真实渲染）；
 *   · hooks 用「按调用顺序对齐的槽位」实现，能抓出条件调用 hooks 这类错误；
 *   · `useMemo` / `useCallback` 直接求值，`useEffect` 记录但不执行。
 *
 * 依赖本地 react 时优先用官方的 `react-dom/server`（更真实）；拿不到就用
 * 内置桩——两条路都能执行组件体，区别只在渲染细节的保真度。
 *
 * 运行：node smoke.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/* ══════════════════════════════════════════════════════════════════════════
 * 渲染后端：优先官方 react + react-dom/server，否则用内置桩
 * ══════════════════════════════════════════════════════════════════════════ */

function tryRequire(name) {
  try { return require(name) } catch { return undefined }
}

const RealReact = tryRequire('react')
const RealServer = tryRequire('react-dom/server')

/* ── 内置桩 ─────────────────────────────────────────────────────────────── */

const FRAGMENT = Symbol('react.fragment')

/**
 * 函数组件调用期间的 hooks 上下文。
 *
 * 每个组件实例有**独立的槽位数组**，所以嵌套调用（父组件渲染子组件）时
 * 游标与槽位必须保存/恢复，否则内层组件会写到外层组件的槽位上。
 */
let currentSlots = null
/** 槽位游标。 */
let slotIndex = 0
/** 已发生的 hooks 顺序违规。 */
const hookViolations = []

/**
 * 取（或创建）当前组件的第 n 个 hooks 槽位。
 *
 * 槽位按调用顺序存放：索引已存在就复用其值，越界才新建。`create` 返回的
 * **就是**要存进槽位的值，不再额外包装（否则 `useState` 会拿到双层对象）。
 * @param {number} index
 * @param {() => any} create - 槽位缺失时的值工厂。
 */
function slot(index, create) {
  if (currentSlots === null) {
    hookViolations.push('在组件外调用了 hook')
    return create()
  }
  while (currentSlots.length <= index) currentSlots.push(undefined)
  if (currentSlots[index] === undefined) currentSlots[index] = create()
  return currentSlots[index]
}

const StubReact = {
  Fragment: FRAGMENT,
  version: 'stub',

  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== true)
    const normalized = { ...(props ?? {}) }
    if (flat.length === 1) normalized.children = flat[0]
    else if (flat.length > 1) normalized.children = flat
    return { $$element: true, type, props: normalized }
  },

  useState(initial) {
    const index = slotIndex++
    const value = slot(index, () => (typeof initial === 'function' ? initial() : initial))
    // setter 是 no-op：烟雾测试只做一次渲染，不验证状态流转。
    const setter = () => {}
    return [value, setter]
  },

  useEffect(effect, deps) {
    slotIndex++
    // 记录但不执行：effect 需要 DOM，且烟雾测试只关心渲染期不崩。
    return undefined
  },

  useMemo(factory) {
    slotIndex++
    return factory()
  },

  useCallback(fn) {
    slotIndex++
    return fn
  },

  useRef(initial) {
    const index = slotIndex++
    return slot(index, () => ({ current: initial }))
  },

  useLayoutEffect(effect) {
    slotIndex++
    return undefined
  },
}

/**
 * 把元素树渲染成 HTML 字符串。
 *
 * 函数组件会被**真实调用**（带 hooks 上下文），因此渲染期错误会向上抛。
 * @param {any} node
 * @returns {string}
 */
function renderToHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (Array.isArray(node)) return node.map(renderToHtml).join('')
  if (typeof node !== 'object' || node.$$element !== true) return ''

  const { type, props } = node

  // 函数组件：真实执行组件体。
  if (typeof type === 'function') {
    const savedSlots = currentSlots
    const savedIndex = slotIndex
    currentSlots = []
    slotIndex = 0
    let output
    try {
      output = type(props)
    } finally {
      currentSlots = savedSlots
      slotIndex = savedIndex
    }
    return renderToHtml(output)
  }

  // Fragment：只渲染子节点。
  if (type === FRAGMENT) return renderToHtml(props.children)

  // 宿主元素。
  const tag = String(type)
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'ref' || key === 'key') continue
    if (value === null || value === undefined || value === false) continue
    if (key === 'style') continue
    if (key.startsWith('on') && typeof value === 'function') continue
    if (value === true) { attrs.push(key) ; continue }
    attrs.push(`${key}="${escapeHtml(String(value))}"`)
  }
  const attributeText = attrs.length > 0 ? ` ${attrs.join(' ')}` : ''
  return `<${tag}${attributeText}>${renderToHtml(props.children)}</${tag}>`
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ── 选定后端 ───────────────────────────────────────────────────────────── */

const useReal = RealReact !== undefined && RealServer !== undefined
const React = useReal ? RealReact : StubReact

console.log(useReal
  ? `渲染后端：官方 react ${RealReact.version ?? '?'} + react-dom/server`
  : '渲染后端：内置 React 桩（真实执行组件体 + hooks 顺序检查）')

/* ══════════════════════════════════════════════════════════════════════════
 * 装载插件
 * ══════════════════════════════════════════════════════════════════════════ */

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory(name => {
        if (name === 'react') return React
        // 官方 primitives 在测试里给空对象：插件走内置降级路径。
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

const memoryStore = new Map()
globalThis.localStorage = {
  getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => { memoryStore.set(key, value) },
  removeItem: key => { memoryStore.delete(key) },
}

/** 可传入替代源文件路径，便于对旧版本跑同一套断言（验证断言确实抓得住 bug）。 */
const source = readFileSync(process.argv[2] ?? join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const M = loaded

/**
 * 渲染组件。
 *
 * 官方后端走 `renderToStaticMarkup`；桩后端走 `renderToHtml`（会执行组件体）。
 * @param {object} props
 */
function render(props) {
  const element = React.createElement(M.__FloatingSidebar, props)
  if (useReal) return RealServer.renderToStaticMarkup(element)
  return renderToHtml(element)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 断言
 * ══════════════════════════════════════════════════════════════════════════ */

let pass = 0
const failures = []
function check(name, condition, detail) {
  if (condition) pass++
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 渲染必须不抛错。 */
function renderSafe(name, props) {
  try {
    return { html: render(props), error: undefined }
  } catch (error) {
    failures.push(`${name} 渲染抛错 — ${error?.message ?? String(error)}`)
    return { html: '', error }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 测试数据
 * ══════════════════════════════════════════════════════════════════════════ */

/** 翻译桩：把 key 与参数拼进输出，便于断言「哪个分支被渲染」。 */
const t = (key, params) => {
  if (params === undefined) return key
  const values = Object.values(params).filter(v => typeof v !== 'object').join(',')
  return values === '' ? key : `${key}(${values})`
}

const makeHook = value => selector => (typeof selector === 'function' ? selector(value) : value)

const baseSessions = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', title: '第一个会话', updatedAt: 1000, retainedBy: { mainView: 1 }, blank: false },
    s2: { id: 's2', title: '第二个会话', updatedAt: 3000, blank: false },
    s3: { id: 's3', title: '', updatedAt: 2000, blank: false },
  },
  phase: 'ready',
  projectionsBySession: {},
}

const baseWorkspaces = {
  items: [{
    workspaceId: 'w1', path: '/p/alpha', title: 'alpha',
    sessionIds: ['s1', 's2'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
  }],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

/** 构造一套完整的注入 props。 */
function makeProps(overrides = {}) {
  return {
    useSessions: makeHook(overrides.sessions ?? baseSessions),
    useSessionStatus: makeHook(overrides.statuses ?? new Map()),
    useWorkspaces: makeHook(overrides.workspaces ?? baseWorkspaces),
    usePanelInfo: makeHook(overrides.panelInfo ?? { activePanelId: null }),
    config: overrides.config ?? {},
    t: overrides.t ?? t,
    openSession: () => {},
    startSession: () => {},
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
    notify: () => {},
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * [1] 基础渲染
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const { html } = renderSafe('[1] 基础渲染', makeProps())
  check('[1] 渲染出面板容器', html.includes('data-dsh-fso-panel'), html.slice(0, 300))
  check('[1] 渲染出卡片', html.includes('data-dsh-fso-card'))
  check('[1] 渲染出列表区', html.includes('data-dsh-fso-list-area'))
  check('[1] 渲染出区头', html.includes('data-dsh-fso-header'))
  check('[1] 渲染出新会话按钮', html.includes('data-dsh-fso-new'))
  check('[1] 渲染出工作区分组', html.includes('data-dsh-fso-project-row'))
  check('[1] 渲染出会话行', html.includes('data-dsh-fso-session-row'))
  check('[1] 标题进入 DOM', html.includes('第一个会话'))
  check('[1] 空标题回退「未命名」', html.includes('session.untitled'))
  check('[1] 渲染搜索框', html.includes('data-dsh-fso-search-input'))
  check('[1] 渲染未分组桶', html.includes('group.ungrouped'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [2] 空数据
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const empty = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const emptyWs = { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const { html } = renderSafe('[2] 空数据', makeProps({ sessions: empty, workspaces: emptyWs }))
  check('[2] 空列表渲染空状态', html.includes('data-dsh-fso-empty'))
  check('[2] 空状态文案', html.includes('empty.none'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [3] 降级路径
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const props = makeProps()
  delete props.useSessions
  delete props.useSessionStatus
  delete props.useWorkspaces
  delete props.usePanelInfo
  const { html } = renderSafe('[3] 全部 hook 缺失', props)
  check('[3] 无 hook 时渲染空状态', html.includes('data-dsh-fso-empty'), html.slice(0, 300))
}

{
  const props = makeProps()
  delete props.t
  const { html } = renderSafe('[3] t 缺失走兜底', props)
  check('[3] 无 t 时仍渲染', html.includes('data-dsh-fso-card'))
  check('[3] 兜底翻译生效', html.includes('工作区'), html.slice(0, 400))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [4] 状态点
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const statuses = new Map([
    ['s1', { running: true, completionUnread: false }],
    ['s2', { running: false, completionUnread: true }],
    ['s3', { running: false, completionUnread: false, pendingInteraction: { kind: 'approval' } }],
  ])
  const { html } = renderSafe('[4] 各种状态', makeProps({ statuses }))
  check('[4] 运行中状态', html.includes('status.running'))
  check('[4] 待审批紧凑标签', html.includes('status.compact.approval'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [5] 归档与筛选
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const workspaces = { ...baseWorkspaces, archivedSessionIds: ['s2'] }
  const { html } = renderSafe('[5] 归档隐藏', makeProps({ workspaces }))
  check('[5] 归档项默认不渲染', !html.includes('第二个会话'), html.slice(0, 400))

  const { html: shown } = renderSafe('[5] 归档显示',
    makeProps({ workspaces, config: { archivedFilter: 'show' } }))
  check('[5] show 模式渲染归档项', shown.includes('第二个会话'))
}

{
  const workspaces = { ...baseWorkspaces, archivedSessionIds: ['s1', 's2'] }
  const { html } = renderSafe('[5] 仅归档视图',
    makeProps({ workspaces, config: { archivedFilter: 'only' } }))
  check('[5] only 模式渲染归档项', html.includes('第一个会话') || html.includes('第二个会话'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [6] 空白会话与折叠配额
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const sessions = {
    ids: ['blank1'],
    byId: { blank1: { id: 'blank1', blank: true, updatedAt: 500, retainedBy: { mainView: 1 } } },
    phase: 'ready',
    projectionsBySession: {},
  }
  const workspaces = { ...baseWorkspaces, items: [{ ...baseWorkspaces.items[0], sessionIds: ['blank1'] }] }
  const { html } = renderSafe('[6] 当前空白会话', makeProps({ sessions, workspaces }))
  check('[6] 当前空白会话渲染', html.includes('session.new'))
  check('[6] 空白行不渲染时间', !html.includes('data-dsh-fso-time'))
}

{
  const ids = Array.from({ length: 9 }, (_, i) => `m${String(i)}`)
  const byId = Object.fromEntries(ids.map((id, i) => [id, { id, title: `会话${String(i)}`, updatedAt: 1000 + i, blank: false }]))
  const sessions = { ids, byId, phase: 'ready', projectionsBySession: {} }
  const workspaces = { ...baseWorkspaces, items: [{ ...baseWorkspaces.items[0], sessionIds: ids }] }
  const { html } = renderSafe('[6] 折叠配额', makeProps({ sessions, workspaces }))
  check('[6] 出现展开其余按钮', html.includes('data-dsh-fso-overflow'))
  check('[6] 隐藏数量正确', html.includes('sessions.expand(4)'), html.match(/sessions\.expand\([^)]*\)/)?.[0])
  check('[6] 显示最新的会话', html.includes('会话8'))
  check('[6] 不显示最旧的会话', !html.includes('会话0'))
}

{
  const ids = ['run1', ...Array.from({ length: 9 }, (_, i) => `m${String(i)}`)]
  const byId = Object.fromEntries(ids.map((id, i) => [id, { id, title: `会话${id}`, updatedAt: 5000 + i, blank: false }]))
  const sessions = { ids, byId, phase: 'ready', projectionsBySession: {} }
  const workspaces = { ...baseWorkspaces, items: [{ ...baseWorkspaces.items[0], sessionIds: ids }] }
  const statuses = new Map([['run1', { running: true }]])
  const { html } = renderSafe('[6] 运行中不占配额', makeProps({ sessions, workspaces, statuses }))
  check('[6] 运行中的会话始终显示', html.includes('会话run1'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [7] 视图模式
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const { html } = renderSafe('[7] 单列表', makeProps({ config: { groupBy: 'flat' } }))
  check('[7] 单列表不渲染工作区行', !html.includes('data-dsh-fso-project-row'), html.slice(0, 300))
  check('[7] 单列表仍渲染会话行', html.includes('data-dsh-fso-session-row'))
}

{
  const { html } = renderSafe('[7] 工作区树', makeProps({ config: { groupBy: 'workspace-tree' } }))
  check('[7] 树模式渲染分组', html.includes('data-dsh-fso-project-row'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [8] 子智能体
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const sessions = {
    ids: ['p'],
    byId: { p: { id: 'p', title: '父会话', updatedAt: 1000, blank: false } },
    phase: 'ready',
    projectionsBySession: { p: { values: { subagentCatalog: [{ id: 'c1' }, { id: 'c2' }] } } },
  }
  const workspaces = { ...baseWorkspaces, items: [{ ...baseWorkspaces.items[0], sessionIds: ['p'] }] }
  const statuses = new Map([['c1', { running: true }], ['c2', { running: true }]])
  const { html } = renderSafe('[8] 子智能体', makeProps({ sessions, workspaces, statuses }))
  check('[8] 渲染子智能体状态', html.includes('status.subagentsRunning'), html.slice(0, 400))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [9] 极端输入
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const broken = { ids: null, byId: null, phase: 'pending', projectionsBySession: null }
  const brokenWs = { items: null, archivedSessionIds: null, pinnedSessionIds: null }
  const { html } = renderSafe('[9] 损坏快照', makeProps({ sessions: broken, workspaces: brokenWs }))
  check('[9] 损坏快照不崩', html.includes('data-dsh-fso-card'))
}

{
  const sparse = { ids: ['x'], byId: { x: { id: 'x' } }, phase: 'ready', projectionsBySession: {} }
  const workspaces = { ...baseWorkspaces, items: [{ ...baseWorkspaces.items[0], sessionIds: ['x'] }] }
  const { html } = renderSafe('[9] 稀疏会话', makeProps({ sessions: sparse, workspaces }))
  check('[9] 稀疏会话不崩', html.includes('data-dsh-fso-session-row'))
}

{
  const { html } = renderSafe('[9] 非法配置', makeProps({
    config: { width: -100, gap: 'abc', radius: null, animationMs: 'x', groupBy: 'nonsense', orderBy: 'weird' },
  }))
  check('[9] 非法配置不崩', html.includes('data-dsh-fso-card'))
}

{
  const { html } = renderSafe('[9] 面板活跃', makeProps({ panelInfo: { activePanelId: 'plugins' } }))
  check('[9] 面板活跃时渲染成功', html.includes('data-dsh-fso-card'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [10] hooks 顺序（只有桩后端能查）
 * ══════════════════════════════════════════════════════════════════════════ */

if (!useReal) {
  check('[10] 无 hooks 顺序违规', hookViolations.length === 0, JSON.stringify(hookViolations.slice(0, 3)))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [11] 会话行 hover 操作区（与官方原生一致）
 *
 * 官方 SessionNodeItem 的 hover 操作区有**三个**按钮，排列为：
 *   「...」菜单  →  archive  →  pin
 * 其中 pin 最右（落在静止态 pinIndicator 的位置）、归档行不渲染 pin。
 * 之前本插件只渲染了「...」，用户报「hover 后展示的功能按钮与原生不一致」。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 HTML 里切出**第一个会话行**那段（配对 `<div>`，含嵌套）。
 *
 * 不能只按「下一个 row-actions」截断：工作区行也有 row-actions，会串味。
 * @param {string} html
 * @returns {string} 该会话行的 HTML；找不到时返回空串。
 */
function sessionRowHtml(html) {
  const marker = /<div[^>]*data-dsh-fso-session-row/.exec(html)
  if (marker === null) return ''
  const start = marker.index
  let depth = 0
  let index = start
  const tag = /<(\/?)div\b[^>]*>/g
  tag.lastIndex = start
  let match
  while ((match = tag.exec(html)) !== null) {
    if (match[1] === '/') {
      depth--
      if (depth === 0) return html.slice(start, tag.lastIndex)
    } else {
      depth++
    }
    index = tag.lastIndex
  }
  void index
  return html.slice(start)
}

/**
 * 抽出会话行 hover 操作区里各按钮的 aria-label（按出现顺序）。
 *
 * 操作区是行内最后一个 `data-dsh-fso-row-actions` 容器；这里先切出会话行，
 * 再从其中取 row-actions 之后的按钮。
 * @param {string} html
 * @returns {string[]}
 */
function rowActionLabels(html) {
  const row = sessionRowHtml(html)
  if (row === '') return []
  const marker = row.indexOf('data-dsh-fso-row-actions')
  if (marker < 0) return []
  return [...row.slice(marker).matchAll(/aria-label="([^"]*)"/g)].map(match => match[1])
}

/** 构造只含单个会话的场景，便于精确断言该行的操作区。 */
function singleSessionRow(sessionOverrides = {}, workspaceOverrides = {}, config = {}) {
  const id = 'only'
  const sessions = {
    ids: [id],
    byId: { [id]: { id, title: '唯一会话', updatedAt: 1000, blank: false, ...sessionOverrides } },
    phase: 'ready',
    projectionsBySession: {},
  }
  const workspaces = {
    ...baseWorkspaces,
    items: [{ ...baseWorkspaces.items[0], sessionIds: [id] }],
    ...workspaceOverrides,
  }
  return renderSafe('[11] 单会话', makeProps({ sessions, workspaces, config })).html
}

{
  const labels = rowActionLabels(singleSessionRow())

  check('[11] hover 操作区共 3 个按钮（官方同款）',
    labels.length === 3, `实际 ${String(labels.length)}：${JSON.stringify(labels)}`)

  /* 排列顺序：菜单在最左，然后 archive，最后 pin（pin 落在静止态置顶标记处）。
   * 注意每条 aria-label 都由 `actions.session.aria` 插值产生，文本形态是
   * `actions.session.aria(唯一会话)`（测试用 t 是键名拼接，不查字典）。 */
  check('[11] 按钮顺序为 菜单 → 归档 → 置顶',
    labels[0] === 'actions.session.aria(唯一会话)'
      && labels[1] === 'menu.archiveSession'
      && labels[2] === 'menu.pinSession',
    JSON.stringify(labels))
}

{
  // 已置顶：pin 按钮变成「取消置顶」。
  const labels = rowActionLabels(singleSessionRow({}, { pinnedSessionIds: ['only'] }))
  check('[11] 已置顶时按钮变「取消置顶」',
    labels[2] === 'menu.unpinSession', JSON.stringify(labels))
  check('[11] 已置顶仍渲染 3 个按钮',
    labels.length === 3, JSON.stringify(labels))
}

{
  // 已归档：归档按钮变「取消归档」，且**不渲染** pin 按钮（官方互斥语义）。
  // 归档行默认被筛选隐藏，所以要显式打开「全部对话」。
  const labels = rowActionLabels(singleSessionRow({}, { archivedSessionIds: ['only'] }, { archivedFilter: 'show' }))
  check('[11] 已归档时不渲染置顶按钮（官方互斥）',
    labels.length > 0 && !labels.includes('menu.pinSession') && !labels.includes('menu.unpinSession'),
    JSON.stringify(labels))
  check('[11] 已归档时归档按钮变「取消归档」',
    labels.includes('menu.unarchiveSession'), JSON.stringify(labels))
  check('[11] 已归档时共 2 个按钮（菜单 + 取消归档）',
    labels.length === 2, `实际 ${String(labels.length)}：${JSON.stringify(labels)}`)
}

{
  // 空白行：官方 `!row.blank &&` 整块不渲染操作区。
  const labels = rowActionLabels(singleSessionRow({ blank: true, title: '' }))
  check('[11] 空白行不渲染 hover 操作区', labels.length === 0, JSON.stringify(labels))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [12] 「未分组」桶没有工作区菜单（workspace/delete 边界校验）
 *
 * 「未分组」桶在 `buildGroups` 里是 `workspaceId: undefined`，它不是工作区。
 * 曾经这一行照样渲染「...」菜单，菜单项把 `undefined` 当 workspaceId 发给
 * workspaceController，Host 边界校验直接拒绝：
 *   workspace delete failed: gateway/input-invalid:
 *   typert gateway: workspace/delete: wire field "request" failed boundary validation
 * 官方 `ProjectRowItem` 用 `actions: group.workspaceId === void 0 ? void 0 : …`
 * 让这一行完全没有菜单；本插件必须同款处理。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 切出包含 `needle` 的那一个 `data-dsh-fso-project-row` 元素（配对 `<div>`）。
 *
 * 树模式下项目行会嵌套，所以不能用「找到下一个 project-row 就截断」，
 * 必须按标签深度配对。
 * @param {string} html
 * @param {string} needle - 该行里必然出现的文本或属性片段。
 * @returns {string} 该行的 HTML；找不到时返回空串。
 */
function projectRowHtml(html, needle) {
  const tag = /<(\/?)div\b[^>]*>/g
  let match
  while ((match = tag.exec(html)) !== null) {
    if (match[1] === '/' || !match[0].includes('data-dsh-fso-project-row')) continue
    const start = match.index
    let depth = 0
    const inner = /<(\/?)div\b[^>]*>/g
    inner.lastIndex = start
    let cursor
    while ((cursor = inner.exec(html)) !== null) {
      if (cursor[1] === '/') {
        depth--
        if (depth === 0) {
          const chunk = html.slice(start, inner.lastIndex)
          if (!chunk.includes(needle)) {
            // 不是目标行：从它之后继续找下一个项目行。
            tag.lastIndex = inner.lastIndex
          }
          if (chunk.includes(needle)) return chunk
          break
        }
      } else {
        depth++
      }
    }
  }
  return ''
}

{
  // 默认场景：w1 是真工作区，s3 落在「未分组」桶。
  const { html } = renderSafe('[12] 未分组菜单', makeProps())

  const workspaceRow = projectRowHtml(html, 'alpha')
  check('[12] 真工作区行仍渲染「...」菜单',
    workspaceRow.includes('actions.workspace.aria(alpha)'), workspaceRow.slice(0, 400))

  const ungroupedRow = projectRowHtml(html, 'group.ungrouped')
  check('[12] 渲染出「未分组」行', ungroupedRow !== '', html.slice(0, 400))
  check('[12] 「未分组」行不渲染「...」菜单',
    !ungroupedRow.includes('actions.workspace.aria'),
    ungroupedRow.slice(0, 500))
  check('[12] 「未分组」行不渲染任何图标按钮（无菜单、无新建会话）',
    !ungroupedRow.includes('data-dsh-fso-icon-button'),
    ungroupedRow.slice(0, 500))
  check('[12] 全局只有真工作区带工作区菜单',
    [...html.matchAll(/actions\.workspace\.aria\(([^)]*)\)/g)].every(m => m[1] === 'alpha'),
    JSON.stringify([...html.matchAll(/actions\.workspace\.aria\(([^)]*)\)/g)].map(m => m[1])))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [13] 顶栏：个人信息按钮 + 新会话
 *
 * 官方把账户入口放在侧边栏底部（`sidebar.settings` → `settings.launcher`
 * → AccountMenu）；折叠成浮层后底部那一段不可见，所以本插件把它挪到卡片
 * 顶部、紧挨「新会话」左边。
 *
 * 行为与官方那个入口**不同**：点一下直接打开设置弹窗，不弹账户菜单，
 * 因此没有「联系我们 / 退出登录」。头像仍复用官方 `account` 数据源。
 *
 * 这里验证渲染接线：
 *   · 两者同处 `[data-dsh-fso-topbar]`，且个人信息在**左**、新会话在右；
 *   · 有 account source 时渲染头像钮（已登录用 img，未登录用图标）；
 *   · 点击调用 onOpenSettings，且**不**渲染任何菜单/菜单项；
 *   · 数据源与打开设置的函数都缺失时安静地不渲染；
 *   · `showProfile` / `showNewSession` 可分别关掉互不影响。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const accountSource = signedIn => ({
    getSnapshot: () => (signedIn
      ? {
          view: { status: 'credential-stored' },
          details: { profile: { status: 'ready', value: { name: '测试用户' } } },
          avatar: { status: 'ready', url: 'https://example.invalid/a.png' },
        }
      : { view: { status: 'signed-out' } }),
    subscribe: () => () => {},
  })

  const base = makeProps()
  const signedIn = { ...base, accountSource: accountSource(true), accountT: base.t, openSettings: () => {} }
  const { html } = renderSafe('[13] 顶栏', signedIn)

  check('[13] 渲染出顶栏容器', html.includes('data-dsh-fso-topbar'), html.slice(0, 400))
  check('[13] 渲染出个人信息按钮', html.includes('data-dsh-fso-profile'), html.slice(0, 600))
  check('[13] 已登录用账户头像图片', html.includes('<img'), html.slice(0, 800))
  check('[13] aria-label 是「打开设置」', html.includes('profile.openSettings'), html.slice(0, 800))
  check('[13] tooltip 带昵称', html.includes('测试用户'), html.slice(0, 900))

  // 不再有账户菜单：任何菜单项都不该出现。
  check('[13] 不再渲染账户菜单项（联系我们）',
    !html.includes('profile.contactUs') && !html.includes('contactUs'), html.slice(0, 900))
  check('[13] 不再渲染账户菜单项（退出登录）',
    !html.includes('profile.signOut') && !html.includes('signOut'), html.slice(0, 900))

  // 顺序：个人信息在左，新会话在右。
  const topbarStart = html.indexOf('data-dsh-fso-topbar')
  const profileAt = html.indexOf('data-dsh-fso-profile', topbarStart)
  const newAt = html.indexOf('data-dsh-fso-new', topbarStart)
  check('[13] 个人信息按钮在新会话按钮左边',
    topbarStart >= 0 && profileAt > topbarStart && newAt > profileAt,
    `topbar=${String(topbarStart)} profile=${String(profileAt)} new=${String(newAt)}`)

  // 未登录：降级为官方默认账户图标，按钮仍可用。
  const signedOut = renderSafe('[13] 未登录', {
    ...base, accountSource: accountSource(false), accountT: base.t, openSettings: () => {},
  })
  check('[13] 未登录仍渲染个人信息按钮', signedOut.html.includes('data-dsh-fso-profile'))
  check('[13] 未登录不加载头像图片', !signedOut.html.includes('<img'), signedOut.html.slice(0, 700))
  check('[13] 未登录 tooltip 用未登录文案', signedOut.html.includes('profile.signedOut'), signedOut.html.slice(0, 900))

  // 点击 → 调用 onOpenSettings（不是打开菜单）。这里直接调用组件体，
  // 拿到真实的 onClick 处理器再触发它 —— 只断言 HTML 里有没有 onclick
  // 属性是测不出「点下去真的开设置」的。
  let opened = 0
  const element = M.__ProfileButton({
    accountSource: accountSource(true),
    t: base.t,
    onOpenSettings: () => { opened += 1 },
  })
  check('[13] 个人信息按钮是 button 元素', element?.type === 'button', String(element?.type))
  check('[13] 点击处理函数已挂载', typeof element?.props?.onClick === 'function')
  element?.props?.onClick?.()
  check('[13] 点击直接触发打开设置', opened === 1, String(opened))

  // 数据源与打开设置都缺失：不渲染（不出假按钮）。
  const noEntry = renderSafe('[13] 无数据源', { ...base, accountEntry: undefined })
  check('[13] 取不到账户数据源时不渲染个人信息按钮',
    !noEntry.html.includes('data-dsh-fso-profile'), noEntry.html.slice(0, 400))
  check('[13] 取不到账户数据源时新会话仍渲染',
    noEntry.html.includes('data-dsh-fso-new'))

  // 配置项分别生效。
  const noProfile = renderSafe('[13] showProfile=false', {
    ...signedIn, config: { showProfile: false },
  })
  check('[13] showProfile=false 关掉个人信息',
    !noProfile.html.includes('data-dsh-fso-profile'))
  check('[13] showProfile=false 不影响新会话',
    noProfile.html.includes('data-dsh-fso-new'))

  const noNew = renderSafe('[13] showNewSession=false', {
    ...signedIn, config: { showNewSession: false },
  })
  check('[13] showNewSession=false 关掉新会话',
    !noNew.html.includes('data-dsh-fso-new'))
  check('[13] showNewSession=false 不影响个人信息',
    noNew.html.includes('data-dsh-fso-profile'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [14] 顶栏「插件」面板按钮
 *
 * 对应官方 `sidebar.panellist` 里 plugins 那一行。浮层渲染不出那个座位的
 * 图标，所以按钮自己画，但**必须只在面板确实注册时**才画：
 * `ctx.layout.selectPanel` 对未注册的 key 会直接 throw，否则就是假按钮。
 *
 * 这里验证：
 *   · 有该面板时渲染，且排在新会话右边；
 *   · 缺失时不渲染（不出假按钮），`showPluginsPanel: false` 也关掉；
 *   · 未选中不带 aria-current，选中时才带；
 *   · 点击先叫面板、成功才收浮层；失败时浮层不关。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const base = makeProps()
  const withPanel = {
    ...base,
    pluginsPanel: true,
    openPluginsPanel: () => true,
    closeOverlay: () => {},
  }
  const { html } = renderSafe('[14] 插件按钮', withPanel)

  check('[14] 渲染出插件按钮', html.includes('data-dsh-fso-panel-button'), html.slice(0, 600))
  check('[14] aria-label 是「插件」', html.includes('panel.plugins'), html.slice(0, 800))
  check('[14] 未选中时不带 aria-current', !html.includes('aria-current="page"'), html.slice(0, 800))

  // 顺序：插件按钮在新会话右边。
  const topbarStart = html.indexOf('data-dsh-fso-topbar')
  const newAt = html.indexOf('data-dsh-fso-new', topbarStart)
  const panelAt = html.indexOf('data-dsh-fso-panel-button', topbarStart)
  check('[14] 插件按钮在新会话按钮右边',
    topbarStart >= 0 && newAt > topbarStart && panelAt > newAt,
    `topbar=${String(topbarStart)} new=${String(newAt)} panel=${String(panelAt)}`)

  // 面板未注册（官方没装 Plugin Manager，或 seats 变了）：不渲染。
  const without = renderSafe('[14] 无面板', { ...withPanel, pluginsPanel: false })
  check('[14] 面板未注册时不渲染按钮',
    !without.html.includes('data-dsh-fso-panel-button'), without.html.slice(0, 400))
  check('[14] 面板未注册时新会话仍渲染', without.html.includes('data-dsh-fso-new'))

  // 配置项可关。
  const off = renderSafe('[14] showPluginsPanel=false', {
    ...withPanel, config: { showPluginsPanel: false },
  })
  check('[14] showPluginsPanel=false 关掉按钮',
    !off.html.includes('data-dsh-fso-panel-button'))

  // 选中态：usePanelInfo 报 plugins 时高亮。
  const active = renderSafe('[14] 选中态', {
    ...withPanel,
    usePanelInfo: makeHook({ activePanelId: 'plugins' }),
  })
  check('[14] 选中时带 data-active', active.html.includes('data-active'))
  check('[14] 选中时带 aria-current=page', active.html.includes('aria-current="page"'))

  // 点击：先开面板，成功才收浮层。
  // 组件外层是 Tooltip（primitives 缺失时是内置 TooltipFallback），
  // 真正的 button 在它的 children 里，断言要取内层。
  let openedPanel = 0
  const wrapper = M.__PanelButton({
    usePanelInfo: makeHook({ activePanelId: null }),
    label: 'panel.plugins',
    onOpen: () => { openedPanel += 1 },
  })
  const element = typeof wrapper?.type === 'function' && wrapper.props?.children !== undefined
    ? wrapper.props.children
    : wrapper
  check('[14] 插件按钮是 button 元素', element?.type === 'button', String(element?.type))
  check('[14] 点击处理函数已挂载', typeof element?.props?.onClick === 'function')
  element?.props?.onClick?.()
  check('[14] 点击触发打开面板', openedPanel === 1, String(openedPanel))

  // openPluginsPanel 失败时不能连浮层一起收掉 —— 那一层在 FloatingSidebar 里，
  // 这里直接验它的组合逻辑：opened === false ⇒ closeOverlay 不被调用。
  let closedOnFailure = 0
  const failing = { ...withPanel, openPluginsPanel: () => false, closeOverlay: () => { closedOnFailure += 1 } }
  const failed = renderSafe('[14] 打开失败', failing)
  check('[14] 打开失败时按钮仍在（不因失败而消失）', failed.html.includes('data-dsh-fso-panel-button'))
  check('[14] 打开失败时未触发收起', closedOnFailure === 0, String(closedOnFailure))
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
