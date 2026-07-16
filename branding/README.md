# Quell Feed – Branding (Lora Q)

Master files for the app icons and favicons. Everything derived (PNGs in
`public/`, Android `res/` icons, iOS asset catalog) is exported from these SVGs.

| File | Purpose |
| --- | --- |
| `quell-glyph-royal.svg` / `quell-glyph-ink.svg` | Bare Q glyph, no background |
| `quell-icon-royal.svg` / `quell-icon-ink.svg` | App icon with background (Android / web) |
| `quell-icon-royal-ios.svg` / `quell-icon-ink-ios.svg` | 1024 px, square corners — Apple applies the rounding itself |
| `AppIcon-royal-1024.png` | Rendered iOS icon (App Store Connect / Xcode) |
| `quell-monochrome-materialyou.svg` | Monochrome layer for Android themed icons (`<monochrome>` in the adaptive icon) |
| `quell-favicon-dark.svg` | White Q on transparent, for dark browser toolbars |
| `quell-favicon-auto.svg` | Favicon that switches via `prefers-color-scheme` (`<link rel="icon" href="..." type="image/svg+xml">`) |

Colors: Royal `#1D3D8F` | Ink `#0A0A0A`

The Q is set in Lora (SIL Open Font License), embedded as a path — no font
installation needed to edit the SVGs.
