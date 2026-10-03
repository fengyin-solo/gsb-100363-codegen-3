<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">森林防火巡护管理系统</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向森林火险监测、巡护任务调度、防火设施维护与应急响应指挥的林区防火管理平台。</span>
        <span class="head-user">当前值班：{{ store.operator }} · {{ store.shiftLabel }}</span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const navItems = [{ label: "运营概览", path: "/" }, { label: "巡护任务", path: "/patrol" }, { label: "火险监测", path: "/firewatch" }, { label: "解除预警复评", path: "/firereview" }, { label: "瞭望台管理", path: "/lookout" }, { label: "防火隔离带", path: "/firebreak" }, { label: "扑火队伍", path: "/fireteam" }, { label: "消防装备", path: "/equipment" }, { label: "气象观测", path: "/weather" }, { label: "火情报告", path: "/firereport" }, { label: "无人机巡查", path: "/drone" }, { label: "防火宣传", path: "/campaign" }, { label: "防火检查站", path: "/checkpoint" }, { label: "值勤排班", path: "/duty" }, { label: "物资储备", path: "/supply" }, { label: "林区道路", path: "/forestroad" }, { label: "防火林带", path: "/firebelt" }, { label: "应急演练", path: "/drill" }, { label: "焚烧审批", path: "/burnpermit" }, { label: "林木生长", path: "/treegrowth" }]
</script>
