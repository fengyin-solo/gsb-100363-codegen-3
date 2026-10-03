import { allRows, listRows, saveRowsAtomic } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 解除预警复评的全部业务口径都集中在这一层：阈值、评估、补值、裁决、联动、重算，
// 页面只负责渲染与收集输入，不做业务判断。

export type ReviewConclusion = '可解除' | '维持' | '升级'

export type ReviewThresholds = {
  windLiftMax: number // 风力不高于该值才具备解除条件
  windUpgradeMin: number // 风力达到该值直接建议升级
  humidityLiftMin: number // 相对湿度不低于该值才具备解除条件
  tempLiftMax: number // 气温不高于该值才具备解除条件
  staleHours: number // 监测时间距今超过该时长按失效观测处理
}

export const DEFAULT_THRESHOLDS: ReviewThresholds = {
  windLiftMax: 3,
  windUpgradeMin: 6,
  humidityLiftMin: 60,
  tempLiftMax: 30,
  staleHours: 48,
}

const THRESHOLD_KEY = 'forest-fire-patrol:review-thresholds'

const REVIEW_KEY = 'firereview'
const FIREWATCH_KEY = 'firewatch'
const CHECKPOINT_KEY = 'checkpoint'

export const REVIEW_CONCLUSIONS: ReviewConclusion[] = ['可解除', '维持', '升级']

// 补值口径（缺历史读数的监测点按首次有效观测兼容）：
// 先取同监测区域最近一次有效读数；区域里没有任何历史（首次有效观测）时按统一默认值补。
// 默认值取中性偏保守：风力 4 级高于解除上限，缺读数的点不会被误判成可解除。
const FALLBACK_WIND = 4
const FALLBACK_HUMIDITY = 50
const FALLBACK_TEMP = 28

// 裁决口径：系统建议与人工结论冲突时就高不就低，风险序为 升级 > 维持 > 可解除。
const SEVERITY: Record<ReviewConclusion, number> = { 可解除: 1, 维持: 2, 升级: 3 }

// 现场记录里的火险线索关键词，命中即建议升级，优先级最高。
const SITE_RISK_KEYWORDS = ['火点', '烟点', '复燃', '冒烟']

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const match = String(value).match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

function parseTime(value: string): Date | null {
  if (!value.trim()) {
    return null
  }
  const parsed = new Date(value.replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function loadThresholds(): ReviewThresholds {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(THRESHOLD_KEY)
    if (raw) {
      try {
        return { ...DEFAULT_THRESHOLDS, ...(JSON.parse(raw) as Partial<ReviewThresholds>) }
      } catch {
        // 阈值损坏时回到默认值
      }
    }
  }
  return { ...DEFAULT_THRESHOLDS }
}

function persistThresholds(thresholds: ReviewThresholds): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(THRESHOLD_KEY, JSON.stringify(thresholds))
  }
}

export function validateThresholds(thresholds: ReviewThresholds): string {
  const values = Object.values(thresholds)
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return '阈值必须是非负数字'
  }
  if (thresholds.windLiftMax >= thresholds.windUpgradeMin) {
    return `解除风力上限（${thresholds.windLiftMax} 级）必须低于升级风力下限（${thresholds.windUpgradeMin} 级）`
  }
  if (thresholds.staleHours <= 0) {
    return '观测失效时长必须大于 0 小时'
  }
  return ''
}

type Reading = { wind: number; humidity: number; temp: number; notes: string[] }

// 缺读数补值：同区域最近一次有效读数优先，首次有效观测用统一默认值；补值明细留痕。
function backfillReading(point: EntryRow, areaRows: EntryRow[]): Reading {
  const metrics = [
    { field: '风力等级', key: 'wind', fallback: FALLBACK_WIND, unit: ' 级' },
    { field: '相对湿度', key: 'humidity', fallback: FALLBACK_HUMIDITY, unit: '%' },
    { field: '气温读数', key: 'temp', fallback: FALLBACK_TEMP, unit: '℃' },
  ] as const
  const history = areaRows
    .filter((row) => Number(row.id) !== Number(point.id))
    .sort((a, b) => String(b['监测时间'] ?? '').localeCompare(String(a['监测时间'] ?? '')))
  const notes: string[] = []
  const filled: Record<string, number> = {}
  for (const metric of metrics) {
    let value = parseNumber(point[metric.field])
    if (value === null) {
      const donor = history.find((row) => parseNumber(row[metric.field]) !== null)
      if (donor) {
        value = parseNumber(donor[metric.field]) as number
        notes.push(`${metric.field}缺失，按同区域 ${donor['监测点编号']} 最近读数补 ${value}${metric.unit}`)
      } else {
        value = metric.fallback
        notes.push(`${metric.field}无历史有效读数，按首次有效观测默认补 ${value}${metric.unit}`)
      }
    }
    filled[metric.key] = value
  }
  return { wind: filled.wind, humidity: filled.humidity, temp: filled.temp, notes }
}

export type EvalInput = {
  wind: number
  humidity: number
  temp: number
  observedAt: string
  siteNote: string
}

// 规则优先级（由高到低）：现场火险线索 > 大风升级 > 观测失效维持 > 解除条件判定 > 兜底维持。
export function evaluateSuggestion(
  input: EvalInput,
  thresholds: ReviewThresholds,
  now: Date = new Date(),
): { suggestion: ReviewConclusion; basis: string } {
  const hit = SITE_RISK_KEYWORDS.find((keyword) => input.siteNote.includes(keyword))
  if (hit) {
    return { suggestion: '升级', basis: `现场记录出现「${hit}」火险线索` }
  }
  if (input.wind >= thresholds.windUpgradeMin) {
    return { suggestion: '升级', basis: `风力 ${input.wind} 级达到升级线 ${thresholds.windUpgradeMin} 级` }
  }
  const observed = parseTime(input.observedAt)
  if (!observed) {
    return { suggestion: '维持', basis: '监测时间缺失，按失效观测处理，数据不足不解除' }
  }
  const hours = (now.getTime() - observed.getTime()) / 3_600_000
  if (hours > thresholds.staleHours) {
    return { suggestion: '维持', basis: `观测距今 ${Math.floor(hours)} 小时，超过 ${thresholds.staleHours} 小时按失效观测处理` }
  }
  if (
    input.wind <= thresholds.windLiftMax
    && input.humidity >= thresholds.humidityLiftMin
    && input.temp <= thresholds.tempLiftMax
  ) {
    return {
      suggestion: '可解除',
      basis: `风力 ${input.wind} 级、湿度 ${input.humidity}%、气温 ${input.temp}℃ 均落在解除区间`,
    }
  }
  return {
    suggestion: '维持',
    basis: `未同时满足解除条件（风力≤${thresholds.windLiftMax} 级、湿度≥${thresholds.humidityLiftMin}%、气温≤${thresholds.tempLiftMax}℃）`,
  }
}

// 裁决口径：建议与人工结论一致直接采用；冲突时就高不就低。
export function arbitrate(
  suggestion: ReviewConclusion,
  human: ReviewConclusion,
): { conclusion: ReviewConclusion; note: string } {
  if (suggestion === human) {
    return { conclusion: suggestion, note: `系统建议与人工结论一致，均为「${suggestion}」` }
  }
  const conclusion = SEVERITY[suggestion] >= SEVERITY[human] ? suggestion : human
  return {
    conclusion,
    note: `系统建议「${suggestion}」与人工结论「${human}」冲突，按就高原则裁决为「${conclusion}」`,
  }
}

// 复评通过后检查站提醒同步：升级把正常检查站点升为升级检查，可解除把升级检查站点放回正常检查，
// 维持不动；临时关闭、等待换岗的站点不纳入联动。
function syncCheckpoints(
  conclusion: ReviewConclusion,
  rows: EntryRow[],
): { rows: EntryRow[]; changed: number; summary: string } {
  if (conclusion === '维持') {
    return { rows, changed: 0, summary: '结论为维持，检查站提醒不变' }
  }
  const from = conclusion === '升级' ? '正常检查' : '升级检查'
  const to = conclusion === '升级' ? '升级检查' : '正常检查'
  let changed = 0
  const next = rows.map((row) => {
    if (String(row.status) !== from) {
      return row
    }
    changed += 1
    return { ...row, status: to, pending: true }
  })
  const summary = changed > 0 ? `${changed} 个检查站由「${from}」同步为「${to}」` : '没有需要联动的检查站'
  return { rows: next, changed, summary }
}

export function observationOptions(): { areas: string[]; levelsByArea: Record<string, string[]> } {
  const rows = listRows(FIREWATCH_KEY)
  const areas = [...new Set(rows.map((row) => String(row['监测区域'] ?? '')).filter(Boolean))]
  const levelsByArea: Record<string, string[]> = {}
  for (const area of areas) {
    levelsByArea[area] = [
      ...new Set(
        rows
          .filter((row) => String(row['监测区域']) === area)
          .map((row) => String(row['火险等级'] ?? ''))
          .filter(Boolean),
      ),
    ]
  }
  return { areas, levelsByArea }
}

// 复评对象：同一监测区域、同一火险等级下监测时间最新的一条观测记录。
export function matchObservation(area: string, level: string): EntryRow | null {
  const matched = listRows(FIREWATCH_KEY).filter(
    (row) => String(row['监测区域']) === area && String(row['火险等级']) === level,
  )
  if (matched.length === 0) {
    return null
  }
  return [...matched].sort((a, b) =>
    String(b['监测时间'] ?? '').localeCompare(String(a['监测时间'] ?? '')),
  )[0]
}

function buildEvaluation(point: EntryRow, area: string, siteNote: string) {
  const areaRows = listRows(FIREWATCH_KEY).filter((row) => String(row['监测区域']) === area)
  const reading = backfillReading(point, areaRows)
  const { suggestion, basis } = evaluateSuggestion(
    {
      wind: reading.wind,
      humidity: reading.humidity,
      temp: reading.temp,
      observedAt: String(point['监测时间'] ?? ''),
      siteNote,
    },
    loadThresholds(),
  )
  return { reading, suggestion, basis }
}

export function previewSuggestion(
  area: string,
  level: string,
  siteNote: string,
): { suggestion: ReviewConclusion; basis: string; backfillNote: string } | null {
  const point = matchObservation(area, level)
  if (!point) {
    return null
  }
  const { reading, suggestion, basis } = buildEvaluation(point, area, siteNote)
  return {
    suggestion,
    basis,
    backfillNote: reading.notes.length > 0 ? reading.notes.join('；') : '读数完整，无需补值',
  }
}

export type InitiateParams = {
  area: string
  level: string
  siteNote: string
  operator: string
}

export function initiateReview(params: InitiateParams): ActionResult & { reviewId?: number } {
  const area = params.area.trim()
  const level = params.level.trim()
  if (!area || !level) {
    return { ok: false, message: '请先选择监测区域和火险等级' }
  }
  const point = matchObservation(area, level)
  if (!point) {
    return { ok: false, message: `监测区域「${area}」下没有火险等级为「${level}」的观测记录` }
  }
  const reviews = listRows(REVIEW_KEY)
  // 幂等口径：同一监测点、同一监测时间已有未归档复评单，直接返回原单，不重复生成。
  const duplicated = reviews.find(
    (row) =>
      String(row['监测点编号']) === String(point['监测点编号'])
      && String(row['监测时间']) === String(point['监测时间'])
      && String(row.status) !== '已归档',
  )
  if (duplicated) {
    return {
      ok: true,
      message: `复评单 ${duplicated['复评单号']} 已存在且未归档，本次不重复生成`,
      reviewId: Number(duplicated.id),
    }
  }
  const siteNote = params.siteNote.trim() || '无异常'
  const { reading, suggestion, basis } = buildEvaluation(point, area, siteNote)
  const id = reviews.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待复评',
    pending: true,
    abnormal: false,
    复评单号: `REV-${String(id).padStart(4, '0')}`,
    监测点编号: String(point['监测点编号'] ?? ''),
    监测区域: area,
    火险等级: level,
    监测时间: String(point['监测时间'] ?? ''),
    风力等级: `${reading.wind} 级`,
    现场记录: siteNote,
    系统建议: suggestion,
    人工结论: '待填写',
    复评结论: '待裁决',
    复评状态: '待复评',
    复评人: params.operator,
    复评时间: formatTime(new Date()),
    评估风力: reading.wind,
    评估湿度: reading.humidity,
    评估气温: reading.temp,
    评估依据: basis,
    补值说明: reading.notes.length > 0 ? reading.notes.join('；') : '读数完整，无需补值',
    裁决说明: '待人工结论后裁决',
    检查站联动: '复评通过后同步',
  }
  try {
    saveRowsAtomic({ [REVIEW_KEY]: [...reviews, row] })
  } catch {
    return { ok: false, message: '复评单写入失败，已整体退回，请重试' }
  }
  return { ok: true, message: `复评单 ${row['复评单号']} 已生成，系统建议「${suggestion}」`, reviewId: id }
}

export function submitConclusion(id: number, human: ReviewConclusion): ActionResult {
  if (!REVIEW_CONCLUSIONS.includes(human)) {
    return { ok: false, message: '人工结论只能是 可解除 / 维持 / 升级' }
  }
  const reviews = listRows(REVIEW_KEY)
  const index = reviews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的复评单` }
  }
  const row = reviews[index]
  if (String(row.status) === '已归档') {
    return { ok: false, message: `复评单 ${row['复评单号']} 已归档，结论不再变更` }
  }
  if (String(row.status) === '已复评') {
    // 幂等口径：相同结论重复提交直接返回原结果；不同结论不覆盖已通过的复评。
    if (String(row['人工结论']) === human) {
      return { ok: true, message: `复评单 ${row['复评单号']} 已按相同结论复评，重复提交未产生新结果` }
    }
    return {
      ok: false,
      message: `复评单 ${row['复评单号']} 已按「${row['人工结论']}」复评，如需变更请先归档后重新发起`,
    }
  }
  const suggestion = String(row['系统建议']) as ReviewConclusion
  const { conclusion, note } = arbitrate(suggestion, human)
  const sync = syncCheckpoints(conclusion, listRows(CHECKPOINT_KEY))
  const nextReviews = [...reviews]
  nextReviews[index] = {
    ...row,
    status: '已复评',
    人工结论: human,
    复评结论: conclusion,
    复评状态: '已复评',
    裁决说明: note,
    检查站联动: sync.summary,
    复评时间: formatTime(new Date()),
  }
  try {
    // 复评单与检查站提醒一次写入：任一失败整体退回，不产生半截结果。
    saveRowsAtomic({ [REVIEW_KEY]: nextReviews, [CHECKPOINT_KEY]: sync.rows })
  } catch {
    return { ok: false, message: '复评结果或检查站联动写入失败，已整体退回，请重试' }
  }
  return { ok: true, message: `复评单 ${row['复评单号']} 复评通过，结论「${conclusion}」；${sync.summary}` }
}

export function archiveReview(id: number): ActionResult {
  const reviews = listRows(REVIEW_KEY)
  const index = reviews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的复评单` }
  }
  const row = reviews[index]
  if (String(row.status) === '待复评') {
    return { ok: false, message: `复评单 ${row['复评单号']} 尚未复评，不能归档` }
  }
  if (String(row.status) === '已归档') {
    return { ok: true, message: `复评单 ${row['复评单号']} 已归档，无需重复操作` }
  }
  const next = [...reviews]
  next[index] = { ...row, status: '已归档', pending: false, 复评状态: '已归档' }
  try {
    saveRowsAtomic({ [REVIEW_KEY]: next })
  } catch {
    return { ok: false, message: '归档写入失败，已整体退回，请重试' }
  }
  return { ok: true, message: `复评单 ${row['复评单号']} 已归档，归档后不再参与阈值重算` }
}

// 规则调整：保存统一阈值，并把未归档复评单按新阈值重算；已归档单冻结不动。
export function adjustThresholds(next: ReviewThresholds): ActionResult {
  const invalid = validateThresholds(next)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const reviews = listRows(REVIEW_KEY)
  const now = new Date()
  let recalced = 0
  const nextReviews = reviews.map((row) => {
    if (String(row.status) === '已归档') {
      return row
    }
    recalced += 1
    const { suggestion, basis } = evaluateSuggestion(
      {
        wind: Number(row['评估风力']),
        humidity: Number(row['评估湿度']),
        temp: Number(row['评估气温']),
        observedAt: String(row['监测时间'] ?? ''),
        siteNote: String(row['现场记录'] ?? ''),
      },
      next,
      now,
    )
    const updated: EntryRow = { ...row, 系统建议: suggestion, 评估依据: basis }
    if (String(row.status) === '已复评') {
      const { conclusion, note } = arbitrate(suggestion, String(row['人工结论']) as ReviewConclusion)
      updated['复评结论'] = conclusion
      updated['裁决说明'] = `${note}（阈值调整后重算）`
    }
    return updated
  })
  // 结论发生变化的已复评单按复评时间先后重新联动检查站，新结论覆盖旧联动。
  let nextCheckpoints = listRows(CHECKPOINT_KEY)
  const changedRows = nextReviews
    .filter((row, i) =>
      String(row.status) === '已复评' && String(row['复评结论']) !== String(reviews[i]['复评结论']),
    )
    .sort((a, b) => String(a['复评时间'] ?? '').localeCompare(String(b['复评时间'] ?? '')))
  for (const row of changedRows) {
    const sync = syncCheckpoints(String(row['复评结论']) as ReviewConclusion, nextCheckpoints)
    nextCheckpoints = sync.rows
    const idx = nextReviews.findIndex((item) => Number(item.id) === Number(row.id))
    nextReviews[idx] = { ...nextReviews[idx], 检查站联动: `${sync.summary}（阈值重算后同步）` }
  }
  const backup = allRows()
  try {
    saveRowsAtomic({ [REVIEW_KEY]: nextReviews, [CHECKPOINT_KEY]: nextCheckpoints })
    persistThresholds(next)
  } catch {
    // 任一写入失败一起退回：行数据与阈值都回到调整前。
    try {
      saveRowsAtomic(backup)
    } catch {
      // 退回本身失败时保持现状，下一次操作仍以存储内容为准
    }
    return { ok: false, message: '阈值或重算结果写入失败，已整体退回，请重试' }
  }
  return {
    ok: true,
    message: `阈值已调整，${recalced} 张未归档复评单按统一阈值重算，其中 ${changedRows.length} 张结论变化并重新联动检查站`,
  }
}
