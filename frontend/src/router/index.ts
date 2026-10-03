import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Patrol = () => import('@/views/patrol/index.vue')
const Firewatch = () => import('@/views/firewatch/index.vue')
const Firereview = () => import('@/views/firereview/index.vue')
const Lookout = () => import('@/views/lookout/index.vue')
const Firebreak = () => import('@/views/firebreak/index.vue')
const Fireteam = () => import('@/views/fireteam/index.vue')
const Equipment = () => import('@/views/equipment/index.vue')
const Weather = () => import('@/views/weather/index.vue')
const Firereport = () => import('@/views/firereport/index.vue')
const Drone = () => import('@/views/drone/index.vue')
const Campaign = () => import('@/views/campaign/index.vue')
const Checkpoint = () => import('@/views/checkpoint/index.vue')
const Duty = () => import('@/views/duty/index.vue')
const Supply = () => import('@/views/supply/index.vue')
const Forestroad = () => import('@/views/forestroad/index.vue')
const Firebelt = () => import('@/views/firebelt/index.vue')
const Drill = () => import('@/views/drill/index.vue')
const Burnpermit = () => import('@/views/burnpermit/index.vue')
const Treegrowth = () => import('@/views/treegrowth/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/patrol', name: 'patrol', component: Patrol },
    { path: '/firewatch', name: 'firewatch', component: Firewatch },
    { path: '/firereview', name: 'firereview', component: Firereview },
    { path: '/lookout', name: 'lookout', component: Lookout },
    { path: '/firebreak', name: 'firebreak', component: Firebreak },
    { path: '/fireteam', name: 'fireteam', component: Fireteam },
    { path: '/equipment', name: 'equipment', component: Equipment },
    { path: '/weather', name: 'weather', component: Weather },
    { path: '/firereport', name: 'firereport', component: Firereport },
    { path: '/drone', name: 'drone', component: Drone },
    { path: '/campaign', name: 'campaign', component: Campaign },
    { path: '/checkpoint', name: 'checkpoint', component: Checkpoint },
    { path: '/duty', name: 'duty', component: Duty },
    { path: '/supply', name: 'supply', component: Supply },
    { path: '/forestroad', name: 'forestroad', component: Forestroad },
    { path: '/firebelt', name: 'firebelt', component: Firebelt },
    { path: '/drill', name: 'drill', component: Drill },
    { path: '/burnpermit', name: 'burnpermit', component: Burnpermit },
    { path: '/treegrowth', name: 'treegrowth', component: Treegrowth },
  ],
})

export default router
