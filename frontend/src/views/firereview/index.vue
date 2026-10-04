<template>
  <section class="page" data-module="firereview">
    <header class="page-head">
      <div>
        <h2>解除预警复评</h2>
        <p class="page-desc">值班员按监测区域和火险等级发起复评，系统结合监测时间、风力等级与现场记录给出建议，冲突时就高裁决。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出复评清单</button>
      </div>
    </header>

    <div class="panel">
      <h3 class="panel-title">发起复评</h3>
      <form class="filter-bar" @submit.prevent="submitReview">
        <label class="filter-item">
          <span>监测区域</span>
          <input v-model="draft.area" placeholder="按监测区域定位监测点" />
        </label>
        <label class="filter-item">
          <span>火险等级</span>
          <input v-model="draft.level" placeholder="留空则不限制" />
        </label>
        <label class="filter-item">
          <span>现场记录</span>
          <input v-model="draft.siteNote" placeholder="现场巡查情况，出现明火/冒烟等将建议升级" />
        </label>
        <label class="filter-item">
          <span>人工结论</span>
          <select v-model="draft.manual">
            <option v-for="verdict in verdicts" :key="verdict" :value="verdict">{{ verdict }}</option>
          </select>
        </label>
        <button class="btn primary" type="submit">提交复评</button>
      </form>
      <p class="panel-hint">同一监测点的同一次观测重复提交不会生成新单；缺历史读数的监测点按首次有效观测处理，建议封顶「维持」。</p>
    </div>

    <div class="panel">
      <h3 class="panel-title">统一阈值（调整后未归档复评单自动重算）</h3>
      <form class="filter-bar" @submit.prevent="saveRules">
        <label class="filter-item">
          <span>解除风力上限（级）</span>
          <input v-model.number="rules.windLift" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>升级风力下限（级）</span>
          <input v-model.number="rules.windEscalate" type="number" min="0" step="1" />
        </label>
        <label class="filter-item">
          <span>监测时间超期（天）</span>
          <input v-model.number="rules.staleDays" type="number" min="0" step="1" />
        </label>
        <button class="btn" type="submit">保存阈值并重算</button>
      </form>
      <p class="panel-hint">风力缺测按升级阈值补值；已归档复评单不再参与重算；重算与检查站提醒同步写入，任一失败一起退回。</p>
    </div>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无解除预警复评单，可先在上方发起复评</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 份解除预警复评单</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  archiveReview,
  confirmReview,
  createReview,
  getReviewRules,
  updateReviewRules,
} from '@/api/review-service'
import type { ReviewVerdict } from '@/api/review-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firereview')
const columns = ["复评单号", "监测点编号", "监测区域", "火险等级", "监测时间", "风力等级", "现场记录", "系统建议", "人工结论", "裁决结论", "评估备注", "复评人", "复评时间", "复评状态"]
const actions = ["确认生效", "归档复评单"]
const statuses = ["待复评", "已生效", "已归档"]
const verdicts: ReviewVerdict[] = ["可解除", "维持", "升级"]

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const draft = ref({ area: '', level: '', siteNote: '', manual: '维持' as ReviewVerdict })
const rules = ref({ ...getReviewRules() })

const stats = computed(() => [
  { label: '复评单总数', value: rows.value.length },
  { label: '待复评数', value: rows.value.filter((row) => String(row.status) === '待复评').length },
  { label: '已生效数', value: rows.value.filter((row) => String(row.status) === '已生效').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function clearMessages() {
  errorMessage.value = ''
  infoMessage.value = ''
}

function submitReview() {
  clearMessages()
  const result = createReview({
    area: draft.value.area,
    level: draft.value.level,
    siteNote: draft.value.siteNote,
    manual: draft.value.manual,
    operator: store.operator,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  if (!result.existed) {
    draft.value = { area: '', level: '', siteNote: '', manual: '维持' }
  }
  reload()
}

function saveRules() {
  clearMessages()
  const result = updateReviewRules({
    windLift: Number(rules.value.windLift),
    windEscalate: Number(rules.value.windEscalate),
    staleDays: Number(rules.value.staleDays),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    rules.value = { ...getReviewRules() }
    return
  }
  infoMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  clearMessages()
  const result =
    action === '确认生效' ? confirmReview(Number(row.id)) : archiveReview(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '解除预警复评单读取失败'
  }
}

onMounted(reload)
</script>
