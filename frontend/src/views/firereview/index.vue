<template>
  <section class="page" data-module="firereview">
    <header class="page-head">
      <div>
        <h2>解除预警复评</h2>
        <p class="page-desc">
          值班员按监测区域和火险等级发起复评，系统结合监测时间、风力等级与现场记录给出可解除、维持或升级建议；
          建议与人工结论冲突时就高裁决，复评通过后同步检查站提醒，原观测记录保持原样。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleInitiate">发起复评</button>
        <button class="btn" type="button" @click="toggleThresholds">统一阈值</button>
        <button class="btn" type="button" @click="exportRows">导出复评清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showThresholds" class="panel" @submit.prevent="saveThresholds">
      <h3 class="panel-title">统一评估阈值（保存后未归档复评单按新阈值重算，已归档单冻结）</h3>
      <div class="panel-grid">
        <label class="filter-item">
          <span>解除风力上限（级）</span>
          <input v-model.number="thresholdForm.windLiftMax" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>升级风力下限（级）</span>
          <input v-model.number="thresholdForm.windUpgradeMin" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>解除湿度下限（%）</span>
          <input v-model.number="thresholdForm.humidityLiftMin" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>解除气温上限（℃）</span>
          <input v-model.number="thresholdForm.tempLiftMax" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>观测失效时长（小时）</span>
          <input v-model.number="thresholdForm.staleHours" type="number" min="1" step="1" />
        </label>
      </div>
      <div class="panel-actions">
        <button class="btn primary" type="submit">保存阈值并重算</button>
        <span class="hint-text">
          当前口径：风力≤{{ thresholds.windLiftMax }} 级且湿度≥{{ thresholds.humidityLiftMin }}%
          且气温≤{{ thresholds.tempLiftMax }}℃ 才可解除；风力≥{{ thresholds.windUpgradeMin }} 级直接建议升级；
          观测超过 {{ thresholds.staleHours }} 小时按失效处理。
        </span>
      </div>
    </form>

    <form v-if="showInitiate" class="panel" @submit.prevent="submitInitiate">
      <h3 class="panel-title">发起解除预警复评</h3>
      <div class="panel-grid">
        <label class="filter-item">
          <span>监测区域</span>
          <select v-model="initiateForm.area">
            <option value="" disabled>请选择监测区域</option>
            <option v-for="area in options.areas" :key="area" :value="area">{{ area }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>火险等级</span>
          <select v-model="initiateForm.level">
            <option value="" disabled>请选择火险等级</option>
            <option v-for="level in levelOptions" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>现场记录</span>
          <select v-model="initiateForm.siteNote">
            <option v-for="note in siteNoteOptions" :key="note" :value="note">{{ note }}</option>
          </select>
        </label>
      </div>
      <p v-if="matchedObservation" class="hint-text">
        复评对象：{{ matchedObservation['监测点编号'] }}（监测时间 {{ matchedObservation['监测时间'] || '缺失' }}，
        风力 {{ matchedObservation['风力等级'] || '缺失' }}，湿度 {{ matchedObservation['相对湿度'] || '缺失' }}，
        气温 {{ matchedObservation['气温读数'] || '缺失' }}）
      </p>
      <p v-else-if="initiateForm.area && initiateForm.level" class="error-text">
        该区域该火险等级下没有观测记录，无法发起复评
      </p>
      <p v-if="preview" class="hint-text">
        系统建议预览：「{{ preview.suggestion }}」——{{ preview.basis }}；{{ preview.backfillNote }}
      </p>
      <div class="panel-actions">
        <button class="btn primary" type="submit">生成复评单</button>
        <span class="hint-text">同一监测点同一监测时间已有未归档复评单时，不重复生成。</span>
      </div>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr>
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td class="row-actions">
              <template v-if="String(row.status) === '待复评'">
                <select v-model="humanChoices[Number(row.id)]">
                  <option v-for="item in conclusions" :key="item" :value="item">人工：{{ item }}</option>
                </select>
                <button class="link" type="button" @click="submitHuman(row)">提交结论</button>
              </template>
              <button
                v-if="String(row.status) === '已复评'"
                class="link"
                type="button"
                @click="archive(row)"
              >
                归档复评
              </button>
              <span v-if="String(row.status) === '已归档'" class="hint-text">已冻结</span>
            </td>
          </tr>
          <tr class="detail-row">
            <td :colspan="columns.length + 1">
              评估依据：{{ row['评估依据'] }} ｜ 补值：{{ row['补值说明'] }} ｜ 裁决：{{ row['裁决说明'] }}
              ｜ 检查站：{{ row['检查站联动'] }} ｜ {{ row['复评人'] }} · {{ row['复评时间'] }}
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无复评单，可点击「发起复评」创建</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 张复评单</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  adjustThresholds,
  archiveReview,
  initiateReview,
  loadThresholds,
  matchObservation,
  observationOptions,
  previewSuggestion,
  submitConclusion,
  REVIEW_CONCLUSIONS,
  type ReviewConclusion,
  type ReviewThresholds,
} from '@/api/review-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('firereview')
const columns = ["复评单号", "监测点编号", "监测区域", "火险等级", "监测时间", "风力等级", "现场记录", "系统建议", "人工结论", "复评结论", "复评状态"]
const statuses = ["待复评", "已复评", "已归档"]
const conclusions = REVIEW_CONCLUSIONS
const siteNoteOptions = ["无异常", "枯落物干燥，可燃物偏多", "发现烟点", "发现火点", "疑似复燃"]
const filterFields = ["复评单号", "监测区域", "复评结论"]

const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const stats = ref([
  { label: '复评单总数', value: 0 },
  { label: '待复评', value: 0 },
  { label: '已复评', value: 0 },
  { label: '已归档', value: 0 },
])
const humanChoices = ref<Record<number, ReviewConclusion>>({})

const showInitiate = ref(false)
const showThresholds = ref(false)
const options = ref(observationOptions())
const initiateForm = reactive({ area: '', level: '', siteNote: '无异常' })
const thresholds = ref<ReviewThresholds>(loadThresholds())
const thresholdForm = reactive<ReviewThresholds>({ ...thresholds.value })

const levelOptions = computed(() => options.value.levelsByArea[initiateForm.area] ?? [])
const matchedObservation = computed(() =>
  initiateForm.area && initiateForm.level
    ? matchObservation(initiateForm.area, initiateForm.level)
    : null,
)
const preview = computed(() =>
  matchedObservation.value
    ? previewSuggestion(initiateForm.area, initiateForm.level, initiateForm.siteNote)
    : null,
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

watch(
  () => initiateForm.area,
  () => {
    initiateForm.level = ''
  },
)

function toggleInitiate() {
  showInitiate.value = !showInitiate.value
  if (showInitiate.value) {
    options.value = observationOptions()
  }
}

function toggleThresholds() {
  showThresholds.value = !showThresholds.value
  if (showThresholds.value) {
    Object.assign(thresholdForm, thresholds.value)
  }
}

function submitInitiate() {
  const result = initiateReview({ ...initiateForm, operator: store.operator })
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    showInitiate.value = false
    reload()
  }
}

function submitHuman(row: EntryRow) {
  const id = Number(row.id)
  const human = humanChoices.value[id] ?? (String(row['系统建议']) as ReviewConclusion)
  const result = submitConclusion(id, human)
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    reload()
  }
}

function archive(row: EntryRow) {
  const result = archiveReview(Number(row.id))
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    reload()
  }
}

function saveThresholds() {
  const result = adjustThresholds({ ...thresholdForm })
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    thresholds.value = loadThresholds()
    reload()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const all = listEntries(meta.key)
    stats.value = [
      { label: '复评单总数', value: all.total },
      { label: '待复评', value: all.items.filter((row) => String(row.status) === '待复评').length },
      { label: '已复评', value: all.items.filter((row) => String(row.status) === '已复评').length },
      { label: '已归档', value: all.items.filter((row) => String(row.status) === '已归档').length },
    ]
    for (const row of payload.items) {
      const id = Number(row.id)
      if (!(id in humanChoices.value)) {
        humanChoices.value[id] = String(row['系统建议']) as ReviewConclusion
      }
    }
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '复评单列表读取失败'
  }
}

onMounted(reload)
</script>
