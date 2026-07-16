import FeedPage from './pages/FeedPage.vue'
import SavedPage from './pages/SavedPage.vue'
import ArchivePage from './pages/ArchivePage.vue'
import ReadingView from './pages/ReadingView.vue'
import AddFeedPage from './pages/AddFeedPage.vue'
import AddLinkPage from './pages/AddLinkPage.vue'
import SettingsPage from './pages/settings/SettingsPage.vue'
import AppearanceSettings from './pages/settings/AppearanceSettings.vue'
import FeedSettings from './pages/settings/FeedSettings.vue'
import FeedDetailPage from './pages/settings/FeedDetailPage.vue'
import SyncSettings from './pages/settings/SyncSettings.vue'
import WebdavSettings from './pages/settings/WebdavSettings.vue'
import KarakeepSettings from './pages/settings/KarakeepSettings.vue'
import LinkwardenSettings from './pages/settings/LinkwardenSettings.vue'
import PaywallSettings from './pages/settings/PaywallSettings.vue'
import AiSettings from './pages/settings/AiSettings.vue'
import DataSettings from './pages/settings/DataSettings.vue'
import AdvancedSettings from './pages/settings/AdvancedSettings.vue'

export default [
  { path: '/', component: FeedPage },
  { path: '/saved/', component: SavedPage },
  { path: '/archive/', component: ArchivePage },
  { path: '/article/', component: ReadingView },
  { path: '/add-feed/', component: AddFeedPage },
  { path: '/add-link/', component: AddLinkPage },

  { path: '/settings/', component: SettingsPage },
  { path: '/settings/appearance/', component: AppearanceSettings },
  { path: '/settings/feeds/', component: FeedSettings },
  { path: '/settings/feeds/:feedId/', component: FeedDetailPage },
  { path: '/settings/sync/', component: SyncSettings },
  { path: '/settings/sync/webdav/', component: WebdavSettings },
  { path: '/settings/sync/karakeep/', component: KarakeepSettings },
  { path: '/settings/sync/linkwarden/', component: LinkwardenSettings },
  { path: '/settings/paywall/', component: PaywallSettings },
  { path: '/settings/ai/', component: AiSettings },
  { path: '/settings/data/', component: DataSettings },
  { path: '/settings/advanced/', component: AdvancedSettings },
]
