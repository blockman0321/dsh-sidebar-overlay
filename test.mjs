/**
 * dsh-sidebar-overlay 的纯函数与 CSS 契约测试。
 *
 * 不需要浏览器：用一个最小的 `window.__ModuleLoader__` 桩把 client.js 里的
 * 导出取出来，然后逐项断言派生逻辑与生成的 CSS。
 *
 * 运行：node test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ── 用桩把浏览器半装载进来 ─────────────────────────────────────────────── */

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory(name => {
        if (name === 'react') return STUB_REACT
        // 官方 primitives 在测试里给空对象：插件会走内置降级路径。
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

/** 极简 React 桩：只用到 createElement / Fragment / 几个 hook。 */
const STUB_REACT = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
}

const source = readFileSync(join(here, 'client.js'), 'utf8')
// 去掉 ESM 不认的注释行不影响；直接求值。
new Function('window', source)(globalThis.window)

const M = loaded

/* ── 断言框架 ───────────────────────────────────────────────────────────── */

let pass = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    pass++
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `expected ${e}, got ${a}`)
}

/** 简单的中文翻译桩（含插值），用于断言派生逻辑。 */
function makeT() {
  const dict = {
    'session.new': '新会话',
    'session.untitled': '未命名',
    'workspace.defaultName': '默认工作区',
    'group.ungrouped': '未分组',
    'section.sessions': '会话',
    'section.workspaces': '工作区',
    'status.idle': '空闲',
    'status.running': '进行中',
    'status.completed': '已完成',
    'status.waitingApproval': '等待审批',
    'status.planReview': '计划待审',
    'status.waitingAnswer': '等待回答',
    'status.compact.approval': '待审批',
    'status.compact.planReview': '计划待审',
    'status.compact.answer': '待回答',
    'status.subagentsRunning.one': '{n} 个子智能体运行中',
    'status.subagentsRunning.other': '{n} 个子智能体运行中',
  }
  return (key, params) => {
    const raw = dict[key] ?? key
    return String(raw).replace(/\{(\w+)\}/g, (whole, k) => (params?.[k] === undefined ? whole : String(params[k])))
  }
}

const t = makeT()

/* ══════════════════════════════════════════════════════════════════════════
 * [1] 相对时间分桶
 * ══════════════════════════════════════════════════════════════════════════ */

const MIN = 6e4, HOUR = 36e5, DAY = 864e5
const base = 1_700_000_000_000
eq('[1] 刚刚', M.__relativeTimeBucket(base, base + 1000), { unit: 'now', n: 0 })
eq('[1] 分钟', M.__relativeTimeBucket(base, base + 5 * MIN), { unit: 'minutes', n: 5 })
eq('[1] 小时', M.__relativeTimeBucket(base, base + 3 * HOUR), { unit: 'hours', n: 3 })
eq('[1] 天', M.__relativeTimeBucket(base, base + 2 * DAY), { unit: 'days', n: 2 })
eq('[1] 月', M.__relativeTimeBucket(base, base + 31 * DAY), { unit: 'months', n: 1 })
eq('[1] 年', M.__relativeTimeBucket(base, base + 400 * DAY), { unit: 'years', n: 1 })
eq('[1] 未来时刻按 0 处理', M.__relativeTimeBucket(base, base - 99999), { unit: 'now', n: 0 })
{
  // 非法输入不能抛异常；返回一个结构完整的桶即可。
  const bucket = M.__relativeTimeBucket(undefined, base)
  check('[1] 非法输入不崩', bucket !== null && typeof bucket.unit === 'string' && Number.isFinite(bucket.n),
    `got ${JSON.stringify(bucket)}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * [2] 标题派生（复刻官方 displayTitle）
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[2] 空白会话', M.__rowDisplayTitle({ blank: true, title: '' }, t), '新会话')
eq('[2] 有标题', M.__rowDisplayTitle({ blank: false, title: '修 bug' }, t), '修 bug')
eq('[2] 标题仅空白 → 未命名', M.__rowDisplayTitle({ blank: false, title: '   ' }, t), '未命名')
eq('[2] 无 title 字段 → 未命名', M.__rowDisplayTitle({ blank: false }, t), '未命名')
eq('[2] 不用 id 兜底', M.__rowDisplayTitle({ blank: false, id: 'ses_abc' }, t), '未命名')
eq('[2] 空白优先于 title', M.__rowDisplayTitle({ blank: true, title: '有标题' }, t), '新会话')

/* ══════════════════════════════════════════════════════════════════════════
 * [3] 工作区标题 / 路径工具
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[3] 默认工作区本地化', M.__workspaceDisplayTitle('default-workspace', t), '默认工作区')
eq('[3] 普通标题原样', M.__workspaceDisplayTitle('leafmail', t), 'leafmail')
eq('[3] 取末段 POSIX', M.__workspaceTitleOf('/home/me/proj'), 'proj')
eq('[3] 取末段 Windows', M.__workspaceTitleOf('C:\\Users\\me\\proj'), 'proj')
eq('[3] 去掉尾部分隔符', M.__workspaceTitleOf('/home/me/proj/'), 'proj')
eq('[3] POSIX 家目录缩写', M.__abbreviateHomePath('/home/me/proj', '/home/me'), '~/proj')
eq('[3] 家目录自身', M.__abbreviateHomePath('/home/me', '/home/me'), '~')
eq('[3] Windows 不缩写', M.__abbreviateHomePath('C:\\Users\\me\\proj', 'C:\\Users\\me'), 'C:\\Users\\me\\proj')
eq('[3] 无 home 不缩写', M.__abbreviateHomePath('/home/me/proj', undefined), '/home/me/proj')
eq('[3] 非后代不缩写', M.__abbreviateHomePath('/other/proj', '/home/me'), '/other/proj')

/* ══════════════════════════════════════════════════════════════════════════
 * [4] 会话可见性
 * ══════════════════════════════════════════════════════════════════════════ */

const A = 'a', B = 'b', C = 'c'
const archivedSet = new Set([C])
eq('[4] 普通会话可见', M.__sessionVisible({ id: A }, undefined, archivedSet, 'default'), true)
eq('[4] 归档在 default 下隐藏', M.__sessionVisible({ id: C }, undefined, archivedSet, 'default'), false)
eq('[4] 归档在 show 下可见', M.__sessionVisible({ id: C }, undefined, archivedSet, 'show'), true)
eq('[4] 归档在 only 下可见', M.__sessionVisible({ id: C }, undefined, archivedSet, 'only'), true)
eq('[4] 普通在 only 下隐藏', M.__sessionVisible({ id: A }, undefined, archivedSet, 'only'), false)
eq('[4] 子智能体始终隐藏', M.__sessionVisible({ id: A, origin: 'subagent' }, undefined, archivedSet, 'show'), false)
eq('[4] 非当前空白会话隐藏', M.__sessionVisible({ id: B, blank: true }, A, archivedSet, 'default'), false)
eq('[4] 当前空白会话可见', M.__sessionVisible({ id: A, blank: true }, A, archivedSet, 'default'), true)
eq('[4] undefined 安全', M.__sessionVisible(undefined, A, archivedSet, 'default'), false)

/* ══════════════════════════════════════════════════════════════════════════
 * [5] 当前会话 / 排序
 * ══════════════════════════════════════════════════════════════════════════ */

const listFixture = {
  ids: [A, B, C],
  byId: {
    [A]: { id: A, displayTitle: 'A', updatedAt: 100, retainedBy: {} },
    [B]: { id: B, displayTitle: 'B', updatedAt: 300, retainedBy: { mainView: 1 } },
    [C]: { id: C, displayTitle: 'C', updatedAt: 200, retainedBy: {} },
  },
}
eq('[5] mainView 判定当前会话', M.__mainSessionId(listFixture), B)
eq('[5] 无 mainView → undefined', M.__mainSessionId({ byId: { [A]: { id: A, retainedBy: {} } } }), undefined)
eq('[5] 按最近更新降序', M.__orderByRecency([A, B, C], listFixture.byId), [B, C, A])
eq('[5] 缺失摘要被跳过', M.__orderByRecency([A, 'zzz'], listFixture.byId), [A])
eq('[5] 时间相同按 id 稳定', M.__orderByRecency(['b', 'a'], { a: { updatedAt: 1 }, b: { updatedAt: 1 } }), ['a', 'b'])

/* ══════════════════════════════════════════════════════════════════════════
 * [6] 手动排序对齐（reconcileManualOrder）
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const byId = {
    a: { id: 'a', updatedAt: 10 },
    b: { id: 'b', updatedAt: 30 },
    c: { id: 'c', updatedAt: 20 },
  }
  eq('[6] 保存顺序优先',
    M.__reconcileManualOrder(['a', 'b', 'c'], ['c', 'a', 'b'], byId, {}),
    ['c', 'a', 'b'])
  eq('[6] 新成员按最近更新补入',
    M.__reconcileManualOrder(['a', 'b', 'c'], ['a'], byId, {}),
    ['a', 'b', 'c'])
  eq('[6] 置顶补到最前',
    M.__reconcileManualOrder(['a', 'b'], ['b'], byId, { pinnedSessionIds: ['a'] }),
    ['a', 'b'])
  eq('[6] 归档垫底',
    M.__reconcileManualOrder(['a', 'b', 'c'], ['a'], byId, { archivedSessionIds: ['c'] }),
    ['a', 'b', 'c'])
  eq('[6] 保存顺序里的重复被忽略',
    M.__reconcileManualOrder(['a', 'b'], ['b', 'b', 'a'], byId, {}),
    ['b', 'a'])
  eq('[6] 已不在成员里的保存项被丢弃',
    M.__reconcileManualOrder(['a'], ['zzz', 'a'], byId, {}),
    ['a'])
}

{
  // 新分叉插到其来源之前。
  const byId = {
    parent: { id: 'parent', updatedAt: 100 },
    fork: { id: 'fork', updatedAt: 50, parentId: 'parent' },
    other: { id: 'other', updatedAt: 200 },
  }
  const result = M.__reconcileManualOrder(['other', 'parent', 'fork'], [], byId, {})
  eq('[6] 分叉插到来源之前', result, ['other', 'fork', 'parent'])
}

/* ══════════════════════════════════════════════════════════════════════════
 * [7] 空白占位 / 分区
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[7] 空白钉到最前', M.__pinCurrentBlank(['a', 'b'], 'x'), ['x', 'a', 'b'])
eq('[7] 已含空白不重复', M.__pinCurrentBlank(['x', 'a'], 'x'), ['x', 'a'])
eq('[7] 无空白保持原序', M.__pinCurrentBlank(['a', 'b'], undefined), ['a', 'b'])
eq('[7] 分区：空白 → 置顶 → 其余',
  M.__sectionMembers(
    [{ id: 'x', blank: true }, { id: 'p' }, { id: 'n' }],
    new Set(['p']),
    new Set(),
  ).map(s => s.id),
  ['x', 'p', 'n'])
eq('[7] 归档项不进入置顶分区',
  M.__sectionMembers(
    [{ id: 'p' }, { id: 'n' }],
    new Set(['p']),
    new Set(['p']),
  ).map(s => s.id),
  ['p', 'n'])

/* ══════════════════════════════════════════════════════════════════════════
 * [8] 状态优先级
 * ══════════════════════════════════════════════════════════════════════════ */

const statusOf = node => M.__sessionStatuses(node, t).map(s => s.state)
eq('[8] 空闲', statusOf({ runningSubagentCount: 0 }), ['idle'])
eq('[8] 运行中', statusOf({ running: true, runningSubagentCount: 0 }), ['ongoing'])
eq('[8] 已完成', statusOf({ completed: true, runningSubagentCount: 0 }), ['done'])
eq('[8] 待审批优先于运行中',
  statusOf({ pendingInteraction: 'approval', running: true, runningSubagentCount: 0 }),
  ['warning'])
eq('[8] 待审批 + 子智能体',
  statusOf({ pendingInteraction: 'approval', runningSubagentCount: 2 }),
  ['warning', 'ongoing'])
eq('[8] 计划待审', statusOf({ pendingInteraction: 'plan-review', runningSubagentCount: 0 }), ['warning'])
eq('[8] 待回答', statusOf({ pendingInteraction: 'question', runningSubagentCount: 0 }), ['warning'])
eq('[8] 未知交互类型忽略', statusOf({ pendingInteraction: 'weird', runningSubagentCount: 0 }), ['idle'])
eq('[8] 行尾紧凑标签',
  M.__sessionStatuses({ pendingInteraction: 'approval', runningSubagentCount: 0 }, t)[0].trailingLabel,
  '待审批')

/* ══════════════════════════════════════════════════════════════════════════
 * [9] 子智能体计数
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const list = {
    byId: { p: { id: 'p' }, c1: { id: 'c1', running: true }, c2: { id: 'c2', running: false } },
    projectionsBySession: { p: { values: { subagentCatalog: [{ id: 'c1' }, { id: 'c2' }] } } },
  }
  eq('[9] 统计运行中的子会话', M.__runningChildCount(list, 'p', undefined), 1)
  eq('[9] 状态快照优先于摘要',
    M.__runningChildCount(list, 'p', new Map([['c2', { running: true }], ['c1', { running: false }]])), 1)
  eq('[9] 无目录 → 0', M.__runningChildCount({ byId: {} }, 'p', undefined), 0)
  eq('[9] 目录非数组 → 0', M.__runningChildCount({ projectionsBySession: { p: { values: {} } } }, 'p', undefined), 0)
}

/* ══════════════════════════════════════════════════════════════════════════
 * [10] 行节点投影
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const list = { byId: {}, projectionsBySession: {} }
  const node = M.__sessionNode(
    { id: 's1', title: ' 标题 ', displayTitle: '标题', updatedAt: 123, blank: false, running: true },
    list,
    new Map([['s1', { running: true, completionUnread: false }]]),
    new Set(),
    new Set(),
  )
  eq('[10] id', node.id, 's1')
  eq('[10] 标题去空白', node.title, '标题')
  eq('[10] running 取状态快照', node.running, true)
  eq('[10] updatedAt 数字', node.updatedAt, 123)
  eq('[10] 无交互时无字段', 'pendingInteraction' in node, false)

  const archivedNode = M.__sessionNode(
    { id: 's2', updatedAt: 0, blank: true },
    list, undefined, new Set(['s2']), new Set(['s2']),
  )
  eq('[10] 归档标记', archivedNode.archived, true)
  eq('[10] 归档项 pinned 恒为 false', archivedNode.pinned, false)
  eq('[10] blank 归一为布尔', archivedNode.blank, true)
}

/* ══════════════════════════════════════════════════════════════════════════
 * [11] 工作区树祖先推导
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[11] 找最近祖先', M.__owningParentFolder('/a/b/c', ['/a', '/a/b']), '/a/b')
eq('[11] 无祖先 → undefined', M.__owningParentFolder('/x', ['/a']), undefined)
eq('[11] 前缀必须落在分隔符上', M.__owningParentFolder('/a/bc', ['/a/b']), undefined)
eq('[11] 自身不算祖先', M.__owningParentFolder('/a/b', ['/a/b']), undefined)
eq('[11] Windows 分隔符', M.__owningParentFolder('C:\\a\\b', ['C:\\a']), 'C:\\a')

{
  const groups = [
    { key: 'w1', cwd: '/a', label: 'a' },
    { key: 'w2', cwd: '/a/b', label: 'b' },
    { key: 'w3', cwd: '/a/b/c', label: 'c' },
    { key: 'w4', cwd: '/z', label: 'z' },
    { key: '', cwd: undefined, label: '未分组' },
  ]
  const tree = M.__nestGroups(groups)
  eq('[11] 根层级', tree.roots.map(g => g.key), ['w1', 'w4', ''])
  eq('[11] w1 的子级', (tree.childrenOf.get('w1') ?? []).map(g => g.key), ['w2'])
  eq('[11] w2 的子级', (tree.childrenOf.get('w2') ?? []).map(g => g.key), ['w3'])
}

/* ══════════════════════════════════════════════════════════════════════════
 * [12] 分组派生
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const list = {
    ids: ['s1', 's2', 's3'],
    byId: {
      s1: { id: 's1', title: 'one', updatedAt: 100, retainedBy: { mainView: 1 } },
      s2: { id: 's2', title: 'two', updatedAt: 300 },
      s3: { id: 's3', title: 'three', updatedAt: 200 },
    },
  }
  const workspaces = [
    { workspaceId: 'w1', path: '/p/one', title: 'one', sessionIds: ['s1', 's2'], createdAt: '2024-01-01T00:00:00.000Z' },
  ]
  const groups = M.__buildGroups(list, workspaces, {
    archived: new Set(), archivedFilter: 'default', currentId: 's1',
    ungroupedOrder: [], manualOrders: {}, pinned: new Set(), orderBy: 'updated', statuses: undefined, t,
  })
  eq('[12] 两个分组（工作区 + 未分组）', groups.length, 2)
  eq('[12] w1 按最近更新降序', groups[0].sessions.map(r => r.id), ['s2', 's1'])
  eq('[12] w1 完整顺序', groups[0].fullOrder, ['s2', 's1'])
  eq('[12] 未分组收到 s3', groups[1].sessions.map(r => r.id), ['s3'])
  eq('[12] 未分组 key 为空串', groups[1].key, '')
  eq('[12] 未分组标签', groups[1].label, '未分组')
  eq('[12] createdAt 解析为数字', typeof groups[0].createdAt, 'number')

  // 仅归档视图：没有可见成员的工作区分组被丢弃。
  const onlyArchived = M.__buildGroups(list, workspaces, {
    archived: new Set(['s3']), archivedFilter: 'only', currentId: undefined,
    ungroupedOrder: [], manualOrders: {}, pinned: new Set(), orderBy: 'updated', statuses: undefined, t,
  })
  eq('[12] only 模式丢弃空工作区分组', onlyArchived.map(g => g.key), [''])
  eq('[12] only 模式只留归档项', onlyArchived[0].sessions.map(r => r.id), ['s3'])

  // 完整顺序必须保留被隐藏的归档成员（拖拽写入依赖它）。
  const withHidden = M.__buildGroups(list, workspaces, {
    archived: new Set(['s1']), archivedFilter: 'default', currentId: undefined,
    ungroupedOrder: [], manualOrders: {}, pinned: new Set(), orderBy: 'updated', statuses: undefined, t,
  })
  eq('[12] 可见行排除归档项', withHidden[0].sessions.map(r => r.id), ['s2'])
  eq('[12] 完整顺序保留归档项', withHidden[0].fullOrder.sort(), ['s1', 's2'])
}

/* ══════════════════════════════════════════════════════════════════════════
 * [13] 空的「未分组」不得出现（stray 可见性判断必须前移）
 *
 * 官方的 stray 是「先按 sessionVisible 过滤，再判断 length > 0」：
 *   list.ids.map(id => list.byId[id])
 *     .filter(s => s !== undefined && !accounted.has(s.id) && sessionVisible(...))
 * 本插件曾经先用**未过滤**的 stray 判断非空、到投影阶段才过滤，于是当孤儿
 * 会话全部是空白会话（blank，默认隐藏）或被归档（默认隐藏）时，会造出一个
 * 0 行的分组——界面上就是一条点开什么都没有的「未分组」。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const opts = {
    archived: new Set(), archivedFilter: 'default', currentId: undefined,
    ungroupedOrder: [], manualOrders: {}, pinned: new Set(), orderBy: 'updated', statuses: undefined, t,
  }

  // 孤儿会话全是空白会话：默认隐藏 → 整个「未分组」不应存在。
  const blankOnly = {
    ids: ['b1', 'b2'],
    byId: {
      b1: { id: 'b1', title: '', updatedAt: 100, blank: true },
      b2: { id: 'b2', title: '', updatedAt: 200, blank: true },
    },
  }
  const blankGroups = M.__buildGroups(blankOnly, [], opts)
  eq('[13] 全空白孤儿会话不产生「未分组」', blankGroups.map(g => g.key), [])

  // 孤儿会话全被归档：默认视图隐藏归档 → 不应出现空的「未分组」。
  const archivedOnly = {
    ids: ['a1', 'a2'],
    byId: {
      a1: { id: 'a1', title: 'x', updatedAt: 100 },
      a2: { id: 'a2', title: 'y', updatedAt: 200 },
    },
  }
  const archivedGroups = M.__buildGroups(archivedOnly, [], { ...opts, archived: new Set(['a1', 'a2']) })
  eq('[13] 孤儿会话全归档时无空「未分组」', archivedGroups.map(g => g.key), [])

  // 只要有一条可见的孤儿会话，「未分组」就该出现，且只显示可见行。
  const mixed = {
    ids: ['v1', 'b1'],
    byId: {
      v1: { id: 'v1', title: '可见', updatedAt: 100 },
      b1: { id: 'b1', title: '', updatedAt: 200, blank: true },
    },
  }
  const mixedGroups = M.__buildGroups(mixed, [], opts)
  eq('[13] 有可见孤儿时渲染「未分组」', mixedGroups.map(g => g.key), [''])
  eq('[13] 「未分组」只显示可见行', mixedGroups[0].sessions.map(r => r.id), ['v1'])
  // 关键：隐藏的空白成员必须留在完整顺序里，否则重新可见时会丢失位置。
  eq('[13] 完整顺序保留隐藏的空白成员', mixedGroups[0].fullOrder.sort(), ['b1', 'v1'])

  // 归档成员同理：完整顺序保留，可见行排除。
  const mixedArchived = M.__buildGroups(archivedOnly, [], { ...opts, archived: new Set(['a1']) })
  eq('[13] 部分归档时「未分组」存在', mixedArchived.map(g => g.key), [''])
  eq('[13] 可见行排除归档孤儿', mixedArchived[0].sessions.map(r => r.id), ['a2'])
  eq('[13] 完整顺序保留归档孤儿', mixedArchived[0].fullOrder.sort(), ['a1', 'a2'])

  // only 视图：孤儿全是未归档 → 「未分组」无可见成员，也不该出现。
  const onlyView = M.__buildGroups(archivedOnly, [], { ...opts, archivedFilter: 'only' })
  eq('[13] only 视图下无归档孤儿时无「未分组」', onlyView.map(g => g.key), [])
}

{
  // 手动排序：保存顺序被尊重。
  const list = {
    ids: ['a', 'b'],
    byId: { a: { id: 'a', updatedAt: 100 }, b: { id: 'b', updatedAt: 300 } },
  }
  const workspaces = [{ workspaceId: 'w', path: '/w', title: 'w', sessionIds: ['a', 'b'], createdAt: '2024-01-01T00:00:00.000Z' }]
  const groups = M.__buildGroups(list, workspaces, {
    archived: new Set(), archivedFilter: 'default', currentId: undefined,
    ungroupedOrder: [], manualOrders: { w: ['a', 'b'] }, pinned: new Set(), orderBy: 'manual',
    statuses: undefined, t,
  })
  eq('[12] 手动排序尊重保存顺序', groups[0].sessions.map(r => r.id), ['a', 'b'])
}

/* ══════════════════════════════════════════════════════════════════════════
 * [13] 单列表派生
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const list = {
    ids: ['a', 'b', 'c'],
    byId: {
      a: { id: 'a', updatedAt: 100 },
      b: { id: 'b', updatedAt: 300 },
      c: { id: 'c', updatedAt: 200 },
    },
  }
  const flat = M.__buildFlat(list, {
    archived: new Set(), archivedFilter: 'default', currentId: undefined,
    ungroupedOrder: [], pinned: new Set(), orderBy: 'updated', statuses: undefined, t,
  })
  eq('[13] 扁平按最近更新', flat.sessions.map(r => r.id), ['b', 'c', 'a'])
  eq('[13] 固定 key', flat.key, '__flat__')
  eq('[13] 标签为「会话」', flat.label, '会话')
}

/* ══════════════════════════════════════════════════════════════════════════
 * [14] 本地搜索
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const list = {
    ids: ['a', 'b', 'c'],
    byId: {
      a: { id: 'a', title: 'Alpha 任务', updatedAt: 100 },
      b: { id: 'b', title: 'Beta', updatedAt: 300 },
      c: { id: 'c', title: 'Gamma', updatedAt: 200, blank: true },
    },
  }
  const workspaces = [{ workspaceId: 'w', path: '/p/leafmail', title: 'leafmail', sessionIds: ['a'], createdAt: '2024-01-01T00:00:00.000Z' }]
  const options = {
    archived: new Set(), archivedFilter: 'default', currentId: undefined,
    statuses: undefined, t,
  }
  eq('[14] 标题匹配', M.__localSearch(list, workspaces, 'alpha', options).map(r => r.id), ['a'])
  eq('[14] 大小写不敏感', M.__localSearch(list, workspaces, 'BETA', options).map(r => r.id), ['b'])
  eq('[14] 工作区名匹配', M.__localSearch(list, workspaces, 'leafmail', options).map(r => r.id), ['a'])
  eq('[14] 空查询返回空', M.__localSearch(list, workspaces, '   ', options), [])
  eq('[14] 无匹配返回空', M.__localSearch(list, workspaces, 'zzz', options), [])
  eq('[14] 结果带 workspace 字段', M.__localSearch(list, workspaces, 'alpha', options)[0].workspace, 'leafmail')
  eq('[14] 空白会话不参与搜索', M.__localSearch(list, workspaces, 'gamma', options), [])
}

/* ══════════════════════════════════════════════════════════════════════════
 * [15] 视图状态读写
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: k => { store.delete(k) },
  }
  const defaults = { groupBy: 'workspace', orderBy: 'updated', archivedFilter: 'default' }
  const fresh = M.__readViewState(defaults)
  eq('[15] 无存储时用默认值', [fresh.groupBy, fresh.orderBy, fresh.archivedFilter], ['workspace', 'updated', 'default'])
  eq('[15] 默认展开表为空', fresh.expandedGroups, {})
  eq('[15] 默认手动顺序为空', fresh.ungroupedOrder, [])

  store.set('dsh.floatingSidebarOverlay.view.v1', '{ 坏 JSON')
  const broken = M.__readViewState(defaults)
  eq('[15] 坏 JSON 回退默认', broken.groupBy, 'workspace')

  store.set('dsh.floatingSidebarOverlay.view.v1', JSON.stringify({ groupBy: 'flat', orderBy: 'manual', archivedFilter: 'show', ungroupedOrder: ['x'] }))
  const restored = M.__readViewState(defaults)
  eq('[15] 恢复 groupBy', restored.groupBy, 'flat')
  eq('[15] 恢复 orderBy', restored.orderBy, 'manual')
  eq('[15] 恢复筛选', restored.archivedFilter, 'show')
  eq('[15] 恢复未分组顺序', restored.ungroupedOrder, ['x'])

  delete globalThis.localStorage
}

/* ══════════════════════════════════════════════════════════════════════════
 * [16] 插值
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[16] 单参数', M.__interpolate('展开其余 {n} 个会话', { n: 5 }), '展开其余 5 个会话')
eq('[16] 多参数', M.__interpolate('{a} 与 {b}', { a: 1, b: 2 }), '1 与 2')
eq('[16] 缺参数保留原样', M.__interpolate('{a}', {}), '{a}')
eq('[16] 无参数原样', M.__interpolate('纯文本'), '纯文本')

/* ══════════════════════════════════════════════════════════════════════════
 * [17] CSS 契约（这是本插件相对旧方案的核心保证）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 去掉 CSS 注释，避免注释里的说明文字干扰契约断言。 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = M.__buildCss({ ...M.__DEFAULTS, width: 280, gap: 8, radius: 16, animationMs: 180 })
/** 只含真实声明，不含注释。 */
const cssCode = stripCssComments(css)

check('[17] 不含 grid-template-columns（不碰官方 grid）',
  !cssCode.includes('grid-template-columns'), '生成了 grid 覆盖')
check('[17] 不含 !important',
  !cssCode.includes('!important'), '出现了 !important')
check('[17] 不引用官方哈希类名',
  !/_[A-Za-z0-9]{6}_/.test(cssCode), '出现了官方哈希类名')
check('[17] 不引用官方 _frame / _sidebarCol',
  !cssCode.includes('_frame') && !cssCode.includes('_sidebarCol'), '引用了官方列结构')
check('[17] 动画用 transform 而非 left',
  cssCode.includes('transform: translateX') && !/^\s*left:\s*calc\(-1/m.test(cssCode), '动画未使用 transform')
check('[17] 只作用于自己的节点',
  cssCode.includes('[data-dsh-fso-panel]') && cssCode.includes('[data-dsh-fso-card]'), '缺少自有节点选择器')
check('[17] 关闭态卡片在屏幕外',
  /\[data-dsh-fso-card\]\s*\{[^}]*translateX\(-110%\)/s.test(cssCode), '关闭态未推出视口')
check('[17] 打开态滑入（卡片自身 data-open 属性）',
  /\[data-dsh-fso-card\]\[data-open\]\s*\{[^}]*translateX\(0\)/s.test(cssCode), '打开态未归位')
check('[17] 开关状态不写在 html 上（避免全局样式重算导致闪烁）',
  !/html\[/.test(cssCode), '仍在 html 上选择')
check('[17] 关闭态不拦截指针',
  /\[data-dsh-fso-card\]\s*\{[^}]*pointer-events:\s*none/s.test(cssCode), '关闭态仍拦截指针')
check('[17] 尊重 prefers-reduced-motion',
  cssCode.includes('prefers-reduced-motion'), '缺少减少动效处理')
check('[17] 宽度按配置生成',
  cssCode.includes('width: 296px'), 'width+gap*2 计算错误')

const cssNoAnim = stripCssComments(M.__buildCss({ ...M.__DEFAULTS, animationMs: 0 }))
check('[17] animationMs=0 时卡片无过渡',
  !/\[data-dsh-fso-card\]\s*\{[^}]*transition:\s*transform/s.test(cssNoAnim), '卡片仍生成了过渡')

const cssBase = stripCssComments(M.__buildCss({ ...M.__DEFAULTS, fill: 'base', shadow: false, border: true }))
check('[17] fill=base 用页面底色', cssBase.includes('var(--dsw-alias-bg-base)'), '底色未切换')
check('[17] 无投影时用发丝描边', cssBase.includes('border: .5px solid'), '缺少描边')

const cssTiny = stripCssComments(M.__buildCss({ ...M.__DEFAULTS, width: 10, gap: -5 }))
check('[17] 非法尺寸被夹到最小值', cssTiny.includes('width: 120px'), '未做下限保护')

/* ══════════════════════════════════════════════════════════════════════════
 * [18] 插件导出契约
 * ══════════════════════════════════════════════════════════════════════════ */

eq('[18] name', M.name, 'sidebar-overlay')
eq('[18] inject 只硬依赖 slots', M.inject, ['slots'])
check('[18] apply 是函数', typeof M.apply === 'function')
check('[18] 声明了 buildCss 供测试', typeof M.__buildCss === 'function')

/* ══════════════════════════════════════════════════════════════════════════
 * [19] design token 白名单
 *
 * 拼错的 token 不会报错，只会**静默失效**（`var(--typo)` 解析为无效值，
 * 该声明被丢弃）。这是最容易复发又最难察觉的一类 bug —— 已经踩过一次
 * （把 `state-warn-primary` 写成 `state-warning-primary`、
 * 把 `bg-layer-1` 写成 `bg-elevated`）。
 *
 * 所以这里把官方 ui-theme 真实定义过的 token 固化成白名单，任何新引入的
 * token 都必须先确认存在。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 官方 ui-theme 定义过的 token（从 asar 的 ui-theme client.js 提取核对）。 */
const OFFICIAL_TOKENS = new Set([
  // 背景
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay', '--dsw-alias-bg-skeleton',
  // 描边
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  // 文本
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption', '--dsw-alias-label-dimmed', '--dsw-alias-link',
  // 交互
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-button-elevated-fill', '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-floating-fill', '--dsw-alias-button-floating-hover',
  // 状态
  '--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary',
  '--dsw-alias-state-warn-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-idle-primary',
  // 侧边栏
  '--dsw-specific-sidebar-fill',
  // 投影
  '--dsw-elevation-panel', '--dsw-elevation-prominent', '--dsw-elevation-soft', '--dsw-elevation-stroke',
  // 圆角 / 焦点 / 缓动
  '--dsw-radius-xs', '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg',
  '--dsw-radius-xl', '--dsw-radius-panel',
  '--dsw-focus-ring-width', '--dsw-focus-ring-color',
  '--ds-ease-in-out',
  // 官方 ui-sidebar 发布的变量；本插件沿用同名以对齐缩进语义。
  '--dsh-sidebar-inline-padding',
  // 官方 ui-workspace 在 groupSection 上写入的层级缩进变量（组件提供值，不是主题 token）。
  '--dsh-workspace-indent',
  // 官方 ui-conversation / ui-chat 发布的对话内容列宽度轴。
  // 本插件读它来计算热区右边界（对话内容列左边缘 × triggerRatio）。
  // 定义处：ConversationRoot 的 body 上
  //   --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, 中栏宽*.64, 920px))
  '--dsh-chat-content-width',
  '--dsh-chat-user-width',
  '--dsh-conversation-column-width',
])

{
  const allCss = [
    css,
    cssNoAnim,
    cssBase,
    M.__buildCss({ ...M.__DEFAULTS, fill: 'base', shadow: false, border: false }),
  ].join('\n')

  const used = new Set()
  for (const match of stripCssComments(allCss).matchAll(/var\((--ds[a-z0-9-]*)/g)) used.add(match[1])

  // 组件内联样式里的 token 也要查（降级路径与 toast）。
  const source = readFileSync(join(here, 'client.js'), 'utf8')
  for (const match of source.matchAll(/var\((--ds[a-z0-9-]*)/g)) used.add(match[1])

  const unknown = [...used]
    // 本插件自己定义的变量（`--dsh-fso-*`）不属于官方 token 白名单。
    .filter(token => !token.startsWith('--dsh-fso-'))
    .filter(token => !OFFICIAL_TOKENS.has(token))
  check('[19] 用到的 design token 都在官方白名单里',
    unknown.length === 0, `未核对：${unknown.join(', ')}`)

  // 明确断言那两个踩过的坑不会回来。
  check('[19] 警告色用 state-warn-primary（不是 warning）',
    !allCss.includes('--dsw-alias-state-warning-primary'))
  check('[19] raised surface 用 bg-layer-1（不是 bg-elevated）',
    !allCss.includes('--dsw-alias-bg-elevated'))
  check('[19] 确实用到了警告色 token', used.has('--dsw-alias-state-warn-primary'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * [20] 热区几何
 *
 * 需求：**「窗口左边缘 → 对话内容列左边缘」这段留白，从左往右 40% 都可触发**。
 *
 * 官方对话内容列（ui-chat `.column`）是居中的：
 *   max-width: var(--dsh-chat-content-width); width: 100%; margin: 0 auto
 * 其中 `--dsh-chat-content-width = clamp(680px, 中栏宽 × .64, 920px)`。
 *
 * 「对话内容列左边缘」这个基准来自真机截图（窗口 1020px 宽）：
 *   内容列宽 = clamp(680, 1020×.64=652.8, 920) = 680
 *   内容列左边缘 = (1020 − 680) / 2 = 170   ← 与截图中量到的正文/输入框左缘一致
 * 所以 1020px 窗口的端到端断言是 `ceil(170 × 0.4) = 68`。
 *
 * 注意：截图上用户当时手绘的绿框右边缘约在 x≈120（那是 70% 的位置）。
 * 比例后来按明确要求收窄到 40%，所以**热区比那个绿框更窄**，这是预期的。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  /** 与 DEFAULTS.triggerRatio 一致；测试里显式传参，避免依赖实现细节。 */
  const RATIO = 0.4

  check('[20] 导出热区纯函数', typeof M.__triggerEdge === 'function'
    && typeof M.__contentColumnWidth === 'function'
    && typeof M.__fallbackTriggerEdge === 'function')

  // 内容列宽度：官方 clamp(680, 中栏宽×.64, 920)。
  eq('[20] 内容列宽度命中下限（1020×.64 < 680 → 680）',
    M.__contentColumnWidth(1020), 680)
  eq('[20] 内容列宽度取比例（1400×.64 = 896）',
    M.__contentColumnWidth(1400), 896)
  eq('[20] 内容列宽度命中上限（2000×.64 > 920 → 920）',
    M.__contentColumnWidth(2000), 920)
  eq('[20] 用户自定义宽度优先于公式',
    M.__contentColumnWidth(1020, 500), 500)
  eq('[20] 非法用户宽度被忽略',
    M.__contentColumnWidth(1020, Number.NaN), 680)

  /* 端到端：1020px 窗口 → 内容列左边缘 170 → 热区 68（= ceil(170 × 0.4)）。 */
  const edge1020 = M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, RATIO)
  check('[20] 1020px 窗口热区右边界 = 68（= ceil(170×0.4)）',
    edge1020 === 68, `实际 ${String(edge1020)}`)

  /* 浮点取整回归：某些比例下 `内容列左边缘 × ratio` 会算出 `x.999999…`
   * （0.7 时是 118.99999999999999），若不取整，整数阈值会落在热区**外**，
   * 与文档写的数字差 1px、边界不可预测。必须向上取整。
   * 这里同时验证「取整后一定是整数」与「ceil 严格生效」。 */
  check('[20] 取整后为整数（无 x.999… 边界歧义）',
    Number.isInteger(edge1020),
    `实际 ${String(edge1020)}（${Number.isInteger(edge1020) ? '整数' : '非整数 → 边界差 1px'}）`)
  // 用一个会踩到浮点尾巴的比例，确认 ceil 真的在兜底。
  check('[20] ceil 生效：0.7 比例下 170×0.7 被修正为 119 而非 118.999…',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, 0.7) === 119,
    String(M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, 0.7)))
  check('[20] 热区边界判定含端点（x=68 命中、x=69 不命中）',
    edge1020 >= 68 && edge1020 < 69, String(edge1020))
  // 其它窗口也必须是整数，避免同类误差在别处冒出来。
  check('[20] 各窗口尺寸下热区边界都是整数',
    [1020, 1440, 1920, 1280, 1600].every(w => Number.isInteger(M.__fallbackTriggerEdge(w, RATIO))),
    [1020, 1440, 1920, 1280, 1600].map(w => String(M.__fallbackTriggerEdge(w, RATIO))).join(', '))

  // 40% 相对旧的固定 24px 仍有明显扩大（这是本改动的目的）。
  check('[20] 热区大于旧默认值 24px', edge1020 > 24, `实际 ${String(edge1020)}`)

  /* 上限：内容列宽度被钳到 920 后，窗口再宽留白也按同比例增长，
   * 所以热区随窗口线性增长（不会因为钳制而失控到覆盖整个对话区）。 */
  const wide = M.__triggerEdge({ containerLeft: 0, containerWidth: 3000 }, RATIO)
  check('[20] 超宽窗口热区仍小于内容列左边缘',
    wide < (3000 - 920) / 2, `热区 ${String(wide)} vs 内容列左缘 ${String((3000 - 920) / 2)}`)

  /* 留白的比例关系：ratio 线性缩放结果（允许取整带来的 ≤1px 偏差）。 */
  const half = M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, RATIO / 2)
  check('[20] ratio 线性缩放（0.2 = 0.4 的一半，容取整误差 1px）',
    Math.abs(half * 2 - edge1020) <= 2, `${String(half)} × 2 vs ${String(edge1020)}`)

  // ratio 越界与非法值都要夹住，不能算出 0 或负数（否则热区永远不触发）。
  check('[20] ratio > 1 被夹到 1（热区至多到内容列左边缘）',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, 5) === 170,
    String(M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, 5)))
  check('[20] ratio 非法时回落到默认值 0.4（即 68）',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, Number.NaN) === 68,
    String(M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, Number.NaN)))
  check('[20] 热区恒有下限 24px（极窄容器也点得到）',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 100 }, RATIO) === 24,
    String(M.__triggerEdge({ containerLeft: 0, containerWidth: 100 }, RATIO)))

  // 窄容器：内容列退化为整宽，则「留白」为 0 → 回落到下限 24。
  check('[20] 容器窄于内容列时内容列=整宽 → 热区为下限',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 600 }, RATIO) === 24,
    String(M.__triggerEdge({ containerLeft: 0, containerWidth: 600 }, RATIO)))

  // 容器不在视口最左（例如右侧有面板时中栏左移）也要按绝对坐标算。
  const shifted = M.__triggerEdge({ containerLeft: 300, containerWidth: 1020 }, RATIO)
  check('[20] 容器左移时热区随内容列左边缘右移',
    shifted === Math.ceil((300 + 170) * RATIO), `${String(shifted)} vs ${String(Math.ceil((300 + 170) * RATIO))}`)

  // 官方计算值优先（仅当它是**纯数值**时；真实浏览器给的是 token 流，
  // 见下方 [20] 的说明与 apply-check 的如实桩）。
  eq('[20] contentWidth 为纯数值时优先于兜底公式',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020, contentWidth: 800 }, RATIO),
    Math.ceil((1020 - 800) / 2 * RATIO))

  /* 真实浏览器行为（headless Chrome 实测，1020px 视口）：
   * `getComputedStyle(el).getPropertyValue('--dsh-chat-content-width')` 返回
   *   "clamp(680px, calc(1020px * .64), 920px)"
   * —— `var()` 被替换了，但 `clamp()` / `calc()` **没有被求值**。
   * `parseFloat` 对它得到 NaN。所以插件在真实环境里拿不到"官方最终值"，
   * 必须靠自己按官方公式算。这条断言把该事实固化下来：
   * 把 token 流当 contentWidth 传进去（NaN）时，结果必须等同走公式。 */
  eq('[20] contentWidth 为 NaN（真实浏览器的 token 流）时回落到官方公式',
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020, contentWidth: Number.parseFloat('clamp(680px, calc(1020px * .64), 920px)') }, RATIO),
    M.__triggerEdge({ containerLeft: 0, containerWidth: 1020 }, RATIO))

  // 默认配置：trigger 必须是 'content'，ratio 必须是 0.4。
  eq('[20] 默认 trigger 为 content', M.__DEFAULTS.trigger, 'content')
  eq('[20] 默认 triggerRatio 为 0.4', M.__DEFAULTS.triggerRatio, 0.4)

  // 对话区尚未挂载时的兜底：折叠态中栏≈视口宽。
  const fb = M.__fallbackTriggerEdge(1020, RATIO)
  check('[20] 兜底热区与实测路径一致（同视口同结果）',
    fb === edge1020, `${String(fb)} vs ${String(edge1020)}`)
  eq('[20] 视口宽度未知时兜底为下限 24', M.__fallbackTriggerEdge(0, RATIO), 24)
}

/* ══════════════════════════════════════════════════════════════════════════
 * [21] 热区上边界（排除对话区 header）
 *
 * 真实缺陷（用户报告）：点「对话 / 轨迹」tab、会话标题也会浮出侧边栏。
 *
 * 官方 `ConversationRoot` 结构：
 *   root (flex column)
 *     ├── header  ← 对话/轨迹 tab、会话标题、面包屑（min-height:76px）
 *     └── body = `[data-conversation-content]`（flex:1，正好在 header 之下）
 *
 * 原先上边界只取「窗口标题栏高度」（Windows 40px），整块 header 都落在热区里。
 * 修法：上边界 = max(对话内容容器顶边, 窗口标题栏底边)。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  check('[21] 导出上边界纯函数', typeof M.__triggerTopEdge === 'function')

  // 典型 Windows：标题栏 40，对话区 header 76 → 容器 top = 116。
  eq('[21] 取对话区顶边（116 > 40）', M.__triggerTopEdge(116, 40), 116)
  // 无 tab 的 header 变体：`min-height:0` 只有 padding，可能比标题栏低。
  eq('[21] 对话区顶边低于标题栏时取标题栏（防露出窗口按钮区）',
    M.__triggerTopEdge(20, 40), 40)
  eq('[21] 两者相等时取该值', M.__triggerTopEdge(40, 40), 40)
  // 对话区尚未挂载（top 传 0）时只能用标题栏。
  eq('[21] 无对话区几何时退回标题栏', M.__triggerTopEdge(0, 40), 40)

  // 非法输入不能产生 NaN（否则 `y >= NaN` 恒 false → 热区永不触发）。
  check('[21] 非法输入不产生 NaN',
    Number.isFinite(M.__triggerTopEdge(Number.NaN, 40))
    && Number.isFinite(M.__triggerTopEdge(116, Number.NaN))
    && Number.isFinite(M.__triggerTopEdge(undefined, undefined)),
    `${String(M.__triggerTopEdge(Number.NaN, 40))} / ${String(M.__triggerTopEdge(116, Number.NaN))} / ${String(M.__triggerTopEdge(undefined, undefined))}`)
  eq('[21] 两者都非法时上边界为 0（整个高度都可触发，退化为原行为）',
    M.__triggerTopEdge(undefined, undefined), 0)

  // darwin：顶部 clearance 48，无 Windows 标题栏。
  eq('[21] darwin（clearance 48）下仍以对话区顶边为准',
    M.__triggerTopEdge(124, 48), 124)
}

/* ══════════════════════════════════════════════════════════════════════════
 * [22] 个人信息按钮：复用官方账户入口（settings.launcher）
 *
 * 浮层里的「个人信息」复用官方 `settings.launcher` 条目 inject 出来的
 * `account` 数据源（同一份账户状态），但**点击直接打开设置**，不弹账户菜单。
 * 这里断言：
 *   · 取不到座位/条目/account source 时返回 undefined（宁可不出按钮）；
 *   · 条目的 inject 面按渲染器规则绑定：`hooks.account` → `useAccount`；
 *   · 打开设置的路径走 `sidebar.settings` 条目 store 的 `actions.open()`。
 * ══════════════════════════════════════════════════════════════════════════ */

{
  const noop = () => {}

  // 缺 slots 服务 / 缺座位 / 条目形状不对 —— 都必须安静地返回 undefined。
  check('[22] 无 slots 服务时返回 undefined', M.__resolveAccountEntry(undefined) === undefined)
  check('[22] slots 无 entriesOfSlot 时返回 undefined', M.__resolveAccountEntry({}) === undefined)
  check('[22] 座位为空时返回 undefined',
    M.__resolveAccountEntry({ entriesOfSlot: () => [] }) === undefined)
  check('[22] 条目缺 inject 时返回 undefined',
    M.__resolveAccountEntry({ entriesOfSlot: () => [{}] }) === undefined)
  check('[22] inject 面没有 account source 时返回 undefined',
    M.__resolveAccountEntry({ entriesOfSlot: () => [{ inject: () => ({ hooks: {} }) }] }) === undefined)
  check('[22] entriesOfSlot 抛错时不外泄',
    M.__resolveAccountEntry({ entriesOfSlot: () => { throw new Error('boom') } }) === undefined)

  const component = function AccountMenu() { return null }
  const source = { getSnapshot: () => ({}), subscribe: () => () => {} }
  const ok = M.__resolveAccountEntry({ entriesOfSlot: () => [{ component, inject: () => ({ hooks: { account: source } }) }] })
  check('[22] 形状正确时交回 account source', ok?.source === source, JSON.stringify(ok))
  check('[22] 不再交回整个条目（不渲染官方 AccountMenu）', ok?.component === undefined)

  /* ── 打开设置：sidebar.settings 条目 store 的 actions.open() ───────────── */

  check('[22] 没有 slots 时拿不到 openSettings',
    M.__resolveOpenSettings(undefined) === undefined)
  check('[22] 没有 sidebar.settings 条目时拿不到 openSettings',
    M.__resolveOpenSettings({ entriesOfSlot: () => [] }) === undefined)
  check('[22] 条目缺 store 时拿不到 openSettings',
    M.__resolveOpenSettings({ entriesOfSlot: () => [{}] }) === undefined)

  // 官方把 create 覆写成返回同一实例，所以这里要断言「调的是 create()」。
  let opened = 0
  const instance = { actions: { open: () => { opened += 1 } }, getSnapshot: () => ({ open: false }) }
  let createCalls = 0
  const handle = { create: () => { createCalls += 1; return instance } }
  const openSettings = M.__resolveOpenSettings({
    entriesOfSlot: key => (key === 'sidebar.settings' ? [{ store: handle }] : []),
  })
  check('[22] 能拿到 openSettings', typeof openSettings === 'function')
  openSettings()
  check('[22] 调用 store 实例的 actions.open()', opened === 1, String(opened))
  check('[22] 通过 handle.create() 取实例（官方覆写为同一实例）', createCalls >= 1, String(createCalls))
  check('[22] 成功后返回 true', openSettings() === true, String(openSettings()))

  // actions.open 抛错时返回 false，不外泄。
  const brokenHandle = { create: () => ({ actions: { open: () => { throw new Error('nope') } } }) }
  const brokenOpen = M.__resolveOpenSettings({
    entriesOfSlot: () => [{ store: brokenHandle }],
  })
  check('[22] actions.open 抛错时返回 false', brokenOpen() === false)

  /* ── inject 面绑定（渲染器 bindInjectSources 的同一套规则）────────────── */

  let snap = { view: { status: 'credential-stored' } }
  let subscribed = 0
  const accountSource = {
    getSnapshot: () => snap,
    subscribe: () => { subscribed += 1; return () => { subscribed -= 1 } },
  }

  const entry = {
    component,
    inject: () => ({
      hooks: { account: accountSource },
      signOut: () => Promise.resolve(),
      contactUs: () => {},
    }),
  }

  const face = M.__bindEntryFace(entry)
  check('[22] hooks.account 绑定成 useAccount', typeof face.useAccount === 'function')
  check('[22] 原始 hooks 字段不外泄', face.hooks === undefined)
  check('[22] 其余操作原样展开',
    typeof face.signOut === 'function' && typeof face.contactUs === 'function')
  check('[22] 绑定面的 hook identity 稳定（子树不会反复重订阅）',
    face.useAccount === face.useAccount)

  // React 桩没有 useSyncExternalStore：降级为「读一次快照、不订阅」，
  // 渲染结果仍然正确。
  eq('[22] hook 应用 selector', face.useAccount(state => state.view.status), 'credential-stored')
  eq('[22] hook 支持不传 selector', face.useAccount().view.status, 'credential-stored')
  check('[22] 无 useSyncExternalStore 时不订阅（降级路径）', subscribed === 0, String(subscribed))

  // 真实 React 有 useSyncExternalStore：必须订阅，且返回当前快照。
  STUB_REACT.useSyncExternalStore = (subscribe, getSnapshot) => {
    subscribe(() => {})
    return getSnapshot()
  }
  try {
    const subscribedFace = M.__bindEntryFace(entry)
    eq('[22] 有 useSyncExternalStore 时返回当前快照',
      subscribedFace.useAccount(state => state.view.status), 'credential-stored')
    // useSyncExternalStore 的 subscribe 在外层已被调用一次 → 计数 +1。
    check('[22] 有 useSyncExternalStore 时真的订阅了账户 source', subscribed >= 1, String(subscribed))

    // 快照变化后 selector 反映新值。
    snap = { view: { status: 'signed-out' } }
    eq('[22] 快照变化后读到新值',
      subscribedFace.useAccount(state => state.view.status), 'signed-out')
  } finally {
    delete STUB_REACT.useSyncExternalStore
  }

  // inject 抛错时降级为空面（浮层不该因为账户入口崩掉）。
  const broken = M.__bindEntryFace({ component, inject: () => { throw new Error('nope') } })
  check('[22] inject 抛错时返回空面而不抛',
    typeof broken === 'object' && Object.keys(broken).length === 0)
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
