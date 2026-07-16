import { f7 } from 'framework7-vue'

const ADD_FEED_ROUTE = '/add-feed/'
const ADD_LINK_ROUTE = '/add-link/'

/**
 * The "+" in the navbar has two destinations — subscribe to a feed, or save a single
 * link. It used to ask which one, every single time, with an action sheet: two taps for
 * an answer the tab already knew.
 *
 * So the tab answers it. In the Feed tab "+" subscribes to a feed, in Saved and in the
 * Archive it saves a link — both tabs hold saved articles, so "+" means the same thing
 * on either. `tab` is 'feed', 'saved' or 'archive'; anything else falls back to the
 * feed flow, because the Feed tab is the main view.
 */
function savesLinks(tab) {
  return tab === 'saved' || tab === 'archive'
}

export function addForTab(f7router, tab) {
  f7router.navigate(savesLinks(tab) ? ADD_LINK_ROUTE : ADD_FEED_ROUTE)
}

/**
 * The full menu — both destinations, from either tab. Reached by holding the "+" down
 * (see bindLongPress), which is the platform gesture for "this button can do more".
 *
 * The tab's own action is bold: the sheet then reads as "this is what a tap would have
 * done, and here is the other one", instead of a fresh question.
 */
export function openAddMenu(f7router, t, tab) {
  const isSaved = savesLinks(tab)

  f7.actions
    .create({
      buttons: [
        [
          {
            text: t('add.title'),
            label: true,
          },
          {
            text: t('add.feed'),
            bold: !isSaved,
            onClick: () => f7router.navigate(ADD_FEED_ROUTE),
          },
          {
            text: t('add.link'),
            bold: isSaved,
            onClick: () => f7router.navigate(ADD_LINK_ROUTE),
          },
        ],
      ],
    })
    .open()
}

/**
 * Long-press on `el`, on every input a phone or a desktop has. Returns an unbind function.
 *
 * The gesture arbitration is the hard part — a card is tappable, swipeable AND holdable,
 * and a hand-rolled setTimeout would fire in the middle of a swipe. Framework7's own
 * `taphold` already solves it: its touch module arms a timer on touchstart, clears it the
 * moment the finger moves (so a swipe can never become a hold), and `tapHoldPreventClicks`
 * swallows the click that would otherwise follow the release (so a hold can never become a
 * tap). We take that instead of writing a worse version of it.
 *
 * Two things it does not do by itself:
 *
 *   • The timer is only armed when `app.params.touch.tapHold` is true, and it ships false.
 *     The flag lives in the f7 app params, which App.vue owns — so we set it here, at the
 *     first bind, rather than depend on a file this feature does not own. The touch module
 *     holds a live reference to that params object and reads the flag per touch, so
 *     flipping it after init works; if App.vue ever turns it on declaratively, we leave it
 *     (and its delay) alone.
 *
 *   • F7 only binds its touch handlers on a touch device, so a desktop mouse never sees a
 *     `taphold`. `contextmenu` is the desktop gesture for precisely this menu anyway, and
 *     it is also what the keyboard's menu key fires — so it doubles as the mouse and
 *     keyboard route. It is NOT the touch route: on Android `contextmenu` is unreliable on
 *     a plain <div> and would fight the native text-selection popup.
 */
export function bindLongPress(el, handler) {
  if (!el) return () => {}

  if (f7?.params?.touch && !f7.params.touch.tapHold) {
    // 750ms (F7's default) is a long time to hold a finger still; Material puts the
    // threshold at half a second and that is what a long-press feels like.
    f7.params.touch.tapHold = true
    f7.params.touch.tapHoldDelay = 500
  }

  const onTapHold = () => handler()
  const onContextMenu = event => {
    event.preventDefault()
    handler()
  }

  el.addEventListener('taphold', onTapHold)
  el.addEventListener('contextmenu', onContextMenu)

  return () => {
    el.removeEventListener('taphold', onTapHold)
    el.removeEventListener('contextmenu', onContextMenu)
  }
}
