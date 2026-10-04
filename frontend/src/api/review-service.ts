import { filterRows } from '@/api/local-service'
import { listRows, runAtomic, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 解除预警复评单的业务规则全部收在这个文件里，页面组件不做业务判断。
//
// 口径约定（需求里明确由实现方决定的部分）：
// - 裁决口径：系统建议与人工结论冲突时就高不就低，风险排序 可解除 < 维持 < 升级。
// - 补值口径：风力等级缺测或不可解析时按升级阈值补值（最不利情形），并在评估备注里标注。
// - 优先级：现场记录危险信号 > 风力升级阈值 > 监测时间超期封顶 > 首次有效观测封顶 > 可解除判定 > 维持兜底。
// - 首次有效观测：监测点此前没有任何复评单（即缺历史读数）时，建议封顶「维持」，升级条件除外。
// - 超期判定：监测时间距复评时间超过 staleDays 天视为超期，不具备解除条件。
// - 检查站同步：以最新「已生效」复评单的裁决结论为准——升级→非关闭站点转「升级检查」，
//   可解除→非关闭站点转「正常检查」，维持→不动；临时关闭的站点不打扰。
// - 幂等口径：同一监测点编号 + 同一监测时间只允许存在一份复评单，重复提交返回原单。
// - 原子口径：复评生效、规则重算涉及复评单与检查站两个模块的写入，任一失败一起退回。

export type ReviewVerdict = '可解除' | '维持' | '升级'

export type ReviewRules = {
  windLift: number // 风力 ≤ 该值才具备解除条件（级）
  windEscalate: number // 风力 ≥ 该值建议升级（级）
  staleDays: number // 监测时间距复评时间超过该天数视为超期（天）
}

export type CreateReviewInput = {
  area: string // 监测区域
  level: string // 火险等级
  siteNote: string // 现场记录
  manual: ReviewVerdict // 人工结论
  operator: string // 复评人（值班员）
}

export type CreateReviewResult = ActionResult & {
  review?: EntryRow
  existed?: boolean
}

export type RecalcResult = ActionResult & {
  recalculated?: number
  changed?: number
}

const REVIEW_KEY = 'firereview'
const FIREWATCH_KEY = 'firewatch'
const CHECKPOINT_KEY = 'checkpoint'
const ARCHIVED = '已归档'
const EFFECTIVE = '已生效'

const DEFAULT_RULES: ReviewRules = { windLift: 3, windEscalate: 6, staleDays: 3 }
const RULES_STORAGE_KEY = 'forest-fire-patrol:review-rules'

const VERDICTS: ReviewVerdict[] = ['可解除', '维持', '升级']
const VERDICT_RANK: Record<ReviewVerdict, number> = { 可解除: 0, 维持: 1, 升级: 2 }

// 现场记录里的危险信号，命中即建议升级。
const DANGER_WORDS = ['明火', '冒烟', '烟雾', '烟点', '火星', '焦味', '火点']

const DAY_MS = 24 * 60 * 60 * 1000

// ── 阈值规则的持久化 ─────────────────────────────────────────

export function getReviewRules(): ReviewRules {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_RULES }
  }
  const raw = window.localStorage.getItem(RULES_STORAGE_KEY)
  if (!raw) {
    return { ...DEFAULT_RULES }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewRules>
    return {
      windLift: Number(parsed.windLift ?? DEFAULT_RULES.windLift),
      windEscalate: Number(parsed.windEscalate ?? DEFAULT_RULES.windEscalate),
      staleDays: Number(parsed.staleDays ?? DEFAULT_RULES.staleDays),
    }
  } catch {
    return { ...DEFAULT_RULES }
  }
}

function saveReviewRules(rules: ReviewRules): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules))
  }
}

// ── 评估引擎 ─────────────────────────────────────────────────

function normalizeVerdict(value: unknown): ReviewVerdict {
  return VERDICTS.includes(value as ReviewVerdict) ? (value as ReviewVerdict) : '维持'
}

// 只认「数字」或「数字+级」的规范写法，其余一律视为缺测，按补值口径处理。
function parseWind(raw: unknown): number | null {
  const match = String(raw ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*级?$/)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

// 兼容「2026-09-01」和「2026-09-01 10:30」两种写法，手工解析避免浏览器差异。
function parseTime(value: unknown): number | null {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
  ).getTime()
}

function nowLabel(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

type EvaluateInput = {
  windRaw: unknown
  observedAt: unknown // 监测时间
  reviewedAt: unknown // 复评时间
  siteNote: unknown // 现场记录
  firstObservation: boolean
  rules: ReviewRules
}

type EvaluateResult = {
  suggestion: ReviewVerdict
  notes: string[]
}

export function evaluateReview(input: EvaluateInput): EvaluateResult {
  const { rules } = input
  const notes: string[] = []
  let wind = parseWind(input.windRaw)
  if (wind === null) {
    wind = rules.windEscalate
    notes.push(`风力等级缺测，按${rules.windEscalate}级补值`)
  }
  const note = String(input.siteNote ?? '')
  if (DANGER_WORDS.some((word) => note.includes(word))) {
    notes.push('现场记录出现危险信号')
    return { suggestion: '升级', notes }
  }
  if (wind >= rules.windEscalate) {
    notes.push(`风力${wind}级达到升级阈值`)
    return { suggestion: '升级', notes }
  }
  const observed = parseTime(input.observedAt)
  const reviewed = parseTime(input.reviewedAt)
  const stale =
    observed === null || reviewed === null || (reviewed - observed) / DAY_MS > rules.staleDays
  if (stale) {
    notes.push('监测时间超期，不具备解除条件')
    return { suggestion: '维持', notes }
  }
  if (input.firstObservation) {
    notes.push('首次有效观测，建议封顶维持')
    return { suggestion: '维持', notes }
  }
  if (wind <= rules.windLift) {
    return { suggestion: '可解除', notes }
  }
  return { suggestion: '维持', notes }
}

// 裁决口径：就高不就低。
export function adjudicate(
  suggestion: ReviewVerdict,
  manual: ReviewVerdict,
): { verdict: ReviewVerdict; conflict: boolean } {
  const conflict = suggestion !== manual
  const verdict = VERDICT_RANK[suggestion] >= VERDICT_RANK[manual] ? suggestion : manual
  return { verdict, conflict }
}

// 缺历史读数的监测点按首次有效观测兼容：同一监测点没有更早的复评单即视为首次。
function isFirstObservation(target: EntryRow, reviews: EntryRow[]): boolean {
  const code = String(target['监测点编号'] ?? '')
  const targetTime = String(target['复评时间'] ?? '')
  const targetId = Number(target.id)
  return !reviews.some((row) => {
    if (Number(row.id) === targetId || String(row['监测点编号'] ?? '') !== code) {
      return false
    }
    const rowTime = String(row['复评时间'] ?? '')
    return rowTime < targetTime || (rowTime === targetTime && Number(row.id) < targetId)
  })
}

function buildAssessment(row: EntryRow, reviews: EntryRow[], rules: ReviewRules): EntryRow {
  const evaluated = evaluateReview({
    windRaw: row['风力等级'],
    observedAt: row['监测时间'],
    reviewedAt: row['复评时间'],
    siteNote: row['现场记录'],
    firstObservation: isFirstObservation(row, reviews),
    rules,
  })
  const manual = normalizeVerdict(row['人工结论'])
  const { verdict, conflict } = adjudicate(evaluated.suggestion, manual)
  const notes = [...evaluated.notes]
  if (conflict) {
    notes.push('建议与人工结论冲突，按就高裁决')
  }
  return {
    ...row,
    系统建议: evaluated.suggestion,
    人工结论: manual,
    裁决结论: verdict,
    评估备注: notes.join('；'),
    abnormal: verdict === '升级',
  }
}

// ── 检查站提醒同步 ───────────────────────────────────────────

function latestEffectiveVerdict(reviews: EntryRow[]): string {
  const effective = reviews.filter((row) => String(row.status) === EFFECTIVE)
  if (effective.length === 0) {
    return ''
  }
  const latest = effective.reduce((a, b) => {
    const timeA = String(a['复评时间'] ?? '')
    const timeB = String(b['复评时间'] ?? '')
    if (timeA !== timeB) {
      return timeA > timeB ? a : b
    }
    return Number(a.id) > Number(b.id) ? a : b
  })
  return String(latest['裁决结论'] ?? '')
}

// 返回实际改动的检查站条数；必须在 runAtomic 里调用。
function syncCheckpoints(verdict: string): number {
  const target = verdict === '升级' ? '升级检查' : verdict === '可解除' ? '正常检查' : ''
  if (!target) {
    return 0
  }
  const rows = listRows(CHECKPOINT_KEY)
  let changed = 0
  const next = rows.map((row) => {
    if (String(row.status) === '临时关闭' || String(row.status) === target) {
      return row
    }
    changed += 1
    return { ...row, status: target, pending: true, abnormal: false }
  })
  if (changed > 0) {
    saveRows(CHECKPOINT_KEY, next)
  }
  return changed
}

// ── 复评单的发起与流转 ───────────────────────────────────────

export function createReview(input: CreateReviewInput): CreateReviewResult {
  const area = input.area.trim()
  const level = input.level.trim()
  if (!area) {
    return { ok: false, message: '发起复评必须填写监测区域' }
  }
  if (!VERDICTS.includes(input.manual)) {
    return { ok: false, message: '人工结论只能是「可解除 / 维持 / 升级」' }
  }
  const candidates = filterRows(listRows(FIREWATCH_KEY), { 监测区域: area, 火险等级: level })
  if (candidates.length === 0) {
    return { ok: false, message: `没有找到监测区域「${area}」、火险等级「${level || '不限'}」的监测点` }
  }
  const point = [...candidates].sort((a, b) => {
    const diff = (parseTime(b['监测时间']) ?? 0) - (parseTime(a['监测时间']) ?? 0)
    return diff !== 0 ? diff : Number(b.id) - Number(a.id)
  })[0]
  const pointCode = String(point['监测点编号'] ?? '')
  const observedAt = String(point['监测时间'] ?? '')

  // 幂等：同一监测点 + 同一监测时间只允许一份复评单，重复提交直接返回原单。
  const reviews = listRows(REVIEW_KEY)
  const duplicated = reviews.find(
    (row) => String(row['监测点编号']) === pointCode && String(row['监测时间']) === observedAt,
  )
  if (duplicated) {
    return {
      ok: true,
      existed: true,
      review: duplicated,
      message: `复评单${duplicated['复评单号']}已覆盖该监测点本次观测，重复提交不再生成新单`,
    }
  }

  const id = reviews.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const draft: EntryRow = {
    id,
    status: '待复评',
    pending: true,
    abnormal: false,
    复评单号: `REV-${String(id).padStart(4, '0')}`,
    监测点编号: pointCode,
    监测区域: String(point['监测区域'] ?? area),
    火险等级: String(point['火险等级'] ?? level),
    监测时间: observedAt,
    风力等级: String(point['风力等级'] ?? ''),
    现场记录: input.siteNote.trim(),
    系统建议: '维持',
    人工结论: input.manual,
    裁决结论: '维持',
    评估备注: '',
    复评人: input.operator,
    复评时间: nowLabel(),
    复评状态: '待复评',
  }
  const assessed = buildAssessment(draft, [...reviews, draft], getReviewRules())
  const next = [...reviews, assessed]
  saveRows(REVIEW_KEY, next)
  const conflict = assessed['系统建议'] !== assessed['人工结论']
  const matched =
    candidates.length > 1 ? `；命中${candidates.length}个监测点，取监测时间最新的${pointCode}` : ''
  return {
    ok: true,
    review: assessed,
    message: `复评单${assessed['复评单号']}已登记：系统建议「${assessed['系统建议']}」，裁决结论「${assessed['裁决结论']}」${conflict ? '（与人工结论冲突，按就高裁决）' : ''}${matched}`,
  }
}

export function confirmReview(id: number): ActionResult {
  const reviews = listRows(REVIEW_KEY)
  const target = reviews.find((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的解除预警复评单` }
  }
  if (String(target.status) === EFFECTIVE) {
    return { ok: false, message: '该复评单已生效，不用重复操作' }
  }
  if (String(target.status) === ARCHIVED) {
    return { ok: false, message: '该复评单已归档，不能再生效' }
  }
  let synced = 0
  try {
    runAtomic(() => {
      const next = listRows(REVIEW_KEY).map((row) =>
        Number(row.id) === id
          ? { ...row, status: EFFECTIVE, pending: true, 复评状态: EFFECTIVE }
          : row,
      )
      saveRows(REVIEW_KEY, next)
      const verdict = latestEffectiveVerdict(next)
      if (verdict) {
        synced = syncCheckpoints(verdict)
      }
    })
  } catch {
    return { ok: false, message: '复评生效或检查站同步失败，本次写入已全部退回' }
  }
  return {
    ok: true,
    message: `复评单${target['复评单号']}已生效，检查站提醒已按「${target['裁决结论']}」同步（更新${synced}个站点）`,
  }
}

export function archiveReview(id: number): ActionResult {
  const reviews = listRows(REVIEW_KEY)
  const target = reviews.find((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的解除预警复评单` }
  }
  if (String(target.status) === ARCHIVED) {
    return { ok: false, message: '该复评单已归档，不用重复操作' }
  }
  if (String(target.status) !== EFFECTIVE) {
    return { ok: false, message: '只有已生效的复评单才能归档' }
  }
  const next = reviews.map((row) =>
    Number(row.id) === id ? { ...row, status: ARCHIVED, pending: false, 复评状态: ARCHIVED } : row,
  )
  saveRows(REVIEW_KEY, next)
  return { ok: true, message: `复评单${target['复评单号']}已归档，归档后不再参与规则重算` }
}

// 规则调整：保存新阈值，未归档复评单按统一阈值重算，检查站提醒按最新已生效结论再同步。
// 重算涉及复评单与检查站两个模块，任一写入失败，规则、复评单、检查站一起退回。
export function updateReviewRules(rules: ReviewRules): RecalcResult {
  const values = [rules.windLift, rules.windEscalate, rules.staleDays]
  if (!values.every((value) => Number.isFinite(value))) {
    return { ok: false, message: '阈值必须是数字' }
  }
  if (rules.windLift < 0 || rules.windEscalate <= rules.windLift || rules.staleDays < 0) {
    return { ok: false, message: '阈值口径不成立：需满足 0 ≤ 解除风力 < 升级风力，超期天数 ≥ 0' }
  }
  const previous = getReviewRules()
  saveReviewRules(rules)
  let recalculated = 0
  let changed = 0
  try {
    runAtomic(() => {
      const reviews = listRows(REVIEW_KEY)
      const next = reviews.map((row) => {
        if (String(row.status) === ARCHIVED) {
          return row
        }
        recalculated += 1
        const assessed = buildAssessment(row, reviews, rules)
        if (JSON.stringify(assessed) !== JSON.stringify(row)) {
          changed += 1
        }
        return assessed
      })
      saveRows(REVIEW_KEY, next)
      const verdict = latestEffectiveVerdict(next)
      if (verdict) {
        syncCheckpoints(verdict)
      }
    })
  } catch {
    saveReviewRules(previous)
    return { ok: false, message: '规则重算写入失败，阈值与数据已一起退回' }
  }
  return {
    ok: true,
    recalculated,
    changed,
    message: `阈值已更新，重算未归档复评单${recalculated}份，其中${changed}份结论有变化`,
  }
}
