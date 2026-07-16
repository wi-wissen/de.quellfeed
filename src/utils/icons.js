/**
 * The icon registry — deliberately WITHOUT the ion-icon web component.
 *
 * Ionicons ships its element as a lazily loaded Stencil component. Stencil's loader pulls
 * its chunks in with `import(`./${bundleId}.entry.js`)` and marks that exact call
 * `@vite-ignore`, so Vite leaves it alone and never emits the chunks. In the dev server
 * the relative path happens to resolve into node_modules/ionicons/dist/esm/, where the
 * files really are; in a production build it points at nothing. The result was a 404, a
 * custom element that never upgraded, and NOT ONE ICON in the APK — while the browser
 * looked exactly as intended.
 *
 * The icon data still comes from ionicons: `ionicons/icons` exports each icon as a
 * `data:image/svg+xml;utf8,<svg …>` string, which we unwrap once here and render inline.
 * No network, no custom element, no lazy loading.
 */
import {
	addCircleOutline,
	addOutline,
	alertCircleOutline,
	archive,
	archiveOutline,
	arrowBackOutline,
	arrowDownOutline,
	arrowUndoOutline,
	arrowUpOutline,
	bookmark,
	bookmarkOutline,
	cloudOutline,
	colorPaletteOutline,
	constructOutline,
	copyOutline,
	documentTextOutline,
	ellipsisHorizontalOutline,
	eyeOffOutline,
	eyeOutline,
	languageOutline,
	linkOutline,
	lockOpenOutline,
	logInOutline,
	logoRss,
	newspaperOutline,
	pause,
	play,
	playSkipBack,
	playSkipForward,
	refreshOutline,
	settingsOutline,
	shareOutline,
	sparklesOutline,
	stop,
	stopCircleOutline,
	swapVerticalOutline,
	syncOutline,
	trashBinOutline,
	volumeHighOutline,
} from 'ionicons/icons'

const DATA_URI_PREFIX = 'data:image/svg+xml;utf8,'

function unwrap(dataUri) {
	if (typeof dataUri !== 'string' || !dataUri.startsWith(DATA_URI_PREFIX)) return ''
	const svg = dataUri.slice(DATA_URI_PREFIX.length)
	// Ionicons does not percent-encode the markup; decoding unconditionally would only
	// throw on a literal %.
	return svg.includes('%') ? decodeURIComponent(svg) : svg
}

export const ICONS = {
	'add-circle-outline': unwrap(addCircleOutline),
	'add-outline': unwrap(addOutline),
	'alert-circle-outline': unwrap(alertCircleOutline),
	// Filled twin of archive-outline — the Archive tab swaps to it when active,
	// exactly like the bookmark pair below.
	archive: unwrap(archive),
	'archive-outline': unwrap(archiveOutline),
	'arrow-back-outline': unwrap(arrowBackOutline),
	'arrow-down-outline': unwrap(arrowDownOutline),
	'arrow-undo-outline': unwrap(arrowUndoOutline),
	'arrow-up-outline': unwrap(arrowUpOutline),
	bookmark: unwrap(bookmark),
	'bookmark-outline': unwrap(bookmarkOutline),
	'cloud-outline': unwrap(cloudOutline),
	'color-palette-outline': unwrap(colorPaletteOutline),
	'construct-outline': unwrap(constructOutline),
	'copy-outline': unwrap(copyOutline),
	'document-text-outline': unwrap(documentTextOutline),
	'ellipsis-horizontal-outline': unwrap(ellipsisHorizontalOutline),
	'eye-off-outline': unwrap(eyeOffOutline),
	'eye-outline': unwrap(eyeOutline),
	'language-outline': unwrap(languageOutline),
	'link-outline': unwrap(linkOutline),
	'lock-open-outline': unwrap(lockOpenOutline),
	'log-in-outline': unwrap(logInOutline),
	'logo-rss': unwrap(logoRss),
	'newspaper-outline': unwrap(newspaperOutline),
	// Filled, not outline: these are transport controls in a player bar, and every
	// media player on the platform draws them solid.
	pause: unwrap(pause),
	play: unwrap(play),
	'play-skip-back': unwrap(playSkipBack),
	'play-skip-forward': unwrap(playSkipForward),
	'refresh-outline': unwrap(refreshOutline),
	'settings-outline': unwrap(settingsOutline),
	'share-outline': unwrap(shareOutline),
	'sparkles-outline': unwrap(sparklesOutline),
	stop: unwrap(stop),
	'stop-circle-outline': unwrap(stopCircleOutline),
	'swap-vertical-outline': unwrap(swapVerticalOutline),
	'sync-outline': unwrap(syncOutline),
	'trash-bin-outline': unwrap(trashBinOutline),
	'volume-high-outline': unwrap(volumeHighOutline),
}

export function getIconSvg(name) {
	const svg = ICONS[name]
	if (!svg) {
		console.warn(`[AppIcon] Unknown icon: "${name}" — add it to src/utils/icons.js.`)
		return ''
	}
	return svg
}
