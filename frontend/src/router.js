import { createRouter, createWebHistory } from 'vue-router'
import SimulatorView from './views/SimulatorView.vue'
import LedgerView from './views/LedgerView.vue'
import PortfolioView from './views/PortfolioView.vue'
import CompareView from './views/CompareView.vue'
import MarketReviewView from './views/MarketReviewView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'simulator', component: SimulatorView },
    { path: '/ledger', name: 'ledger', component: LedgerView },
    { path: '/portfolio', name: 'portfolio', component: PortfolioView },
    { path: '/compare', name: 'compare', component: CompareView },
    { path: '/review', name: 'review', component: MarketReviewView }
  ]
})
