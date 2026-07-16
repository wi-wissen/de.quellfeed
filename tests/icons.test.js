import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h } from 'vue'
import { ICONS, getIconSvg } from '../src/utils/icons.js'
import AppIcon from '../src/components/AppIcon.vue'

const SRC = join(process.cwd(), 'src')

function walk(dir) {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry)
		return statSync(full).isDirectory() ? walk(full) : [full]
	})
}

const sourceFiles = walk(SRC).filter((f) => f.endsWith('.vue') || f.endsWith('.js'))

function read(file) {
	return readFileSync(file, 'utf8')
}

/** Namen, die im Template statisch an <AppIcon> gehen. */
function staticIconNames(source) {
	const names = []
	for (const tag of source.match(/<AppIcon[\s\S]*?\/?>/g) || []) {
		const match = tag.match(/(?:^|\s)name="([a-z0-9-]+)"/)
		if (match) names.push(match[1])
	}
	return names
}

/** Namen, die über :name an <AppIcon> gehen — Menü-/Ziel-Definitionen im Script. */
function dynamicIconNames(source) {
	return [...source.matchAll(/icon: '([a-z0-9-]+)'/g)].map((m) => m[1])
}

describe('Icon-Registry', () => {
	it('packt jedes Icon zu echtem SVG-Markup aus', () => {
		for (const [name, svg] of Object.entries(ICONS)) {
			expect(svg, name).toMatch(/^<svg\b/)
			expect(svg, name).toContain('</svg>')
			expect(svg, name).not.toContain('data:')
		}
	})

	it('kennt jedes Icon, das im Quelltext verwendet wird', () => {
		const used = new Set()
		for (const file of sourceFiles) {
			const source = read(file)
			for (const name of staticIconNames(source)) used.add(name)
			for (const name of dynamicIconNames(source)) used.add(name)
		}

		expect(used.size).toBeGreaterThan(10)
		const unknown = [...used].filter((name) => !ICONS[name])
		expect(unknown).toEqual([])
	})

	it('kennt auch die Icons, die aus Bedingungen kommen', () => {
		// ArticleCard.saveActionIcon und der Archiv-Umschalter in der
		// ReadingView-Navbar — die Stellen, an denen ein Iconname aus einer
		// Bedingung entsteht statt aus einem statischen Attribut.
		const conditional = [
			'bookmark', 'bookmark-outline', 'trash-bin-outline',
			'archive-outline', 'arrow-undo-outline',
		]
		for (const name of conditional) {
			expect(ICONS[name], name).toBeTruthy()
		}
	})

	it('warnt bei unbekanntem Icon, statt still nichts zu rendern', () => {
		expect(getIconSvg('gibt-es-nicht')).toBe('')
		expect(getIconSvg('logo-rss')).toMatch(/^<svg\b/)
	})
})

describe('AppIcon rendert', () => {
	function mount(props) {
		const host = document.createElement('div')
		document.body.appendChild(host)
		createApp({ render: () => h(AppIcon, props) }).mount(host)
		return host.firstElementChild
	}

	it('legt ein echtes <svg> in den DOM — kein leeres Element wie in der ersten APK', () => {
		const el = mount({ name: 'logo-rss' })

		const svg = el.querySelector('svg')
		expect(svg).not.toBeNull()
		expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
		expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
	})

	it('beschriftet nur mit label, sonst versteckt vor Screenreadern', () => {
		expect(mount({ name: 'logo-rss' }).getAttribute('aria-hidden')).toBe('true')

		const labelled = mount({ name: 'arrow-back-outline', label: 'Zurück' })
		expect(labelled.getAttribute('aria-label')).toBe('Zurück')
		expect(labelled.getAttribute('role')).toBe('img')
		expect(labelled.getAttribute('aria-hidden')).toBeNull()
	})

	it('rendert bei unbekanntem Namen nichts, statt zu werfen', () => {
		expect(mount({ name: 'gibt-es-nicht' }).querySelector('svg')).toBeNull()
	})
})

describe('Kein lazy geladenes Icon-Webcomponent', () => {
	// Der Bug, der in der ersten APK JEDES Icon verschwinden ließ: Stencil lädt das
	// <ion-icon>-Element per `import('./p-xxxx.entry.js')` und markiert den Aufruf mit
	// @vite-ignore. Vite emittiert die Chunks deshalb nie — im Dev-Server fällt das nicht
	// auf, weil der relative Pfad dort nach node_modules auflöst, im Build ist es ein 404.
	// Diese beiden Tests sind der Grund, warum das nicht wiederkommen kann.
	it('lädt den ionicons-Loader nirgends', () => {
		for (const file of sourceFiles) {
			expect(read(file), file).not.toContain('ionicons/loader')
		}
	})

	it('rendert kein <ion-icon> mehr', () => {
		for (const file of sourceFiles) {
			expect(read(file), file).not.toContain('<ion-icon')
		}
	})

	it('bezieht die Icon-Daten nur aus ionicons/icons', () => {
		const registry = read(join(SRC, 'utils', 'icons.js'))
		expect(registry).toContain("from 'ionicons/icons'")
	})
})
