# Quell Feed

> **Quell the noise.**

An offline-first RSS reader and bookmark keeper for Android (iOS prepared). No backend,
no accounts, no trackers — everything lives on the device. The web build exists for
debugging, not as a target platform.

The name carries two meanings, both intended: the German **Quelle** — the source you
subscribe to; and the English **to quell** — to put the noise down.

- **App ID:** `de.quellfeed` · **Domain:** quellfeed.de
- **Store listing:** "Quell Feed – RSS und Lesezeichen" · **Launcher:** "Quell Feed"
- **Concept:** see [CONCEPT.md](CONCEPT.md)

## Built with AI

This app was written with **Claude** (Anthropic), working from the author's direction and
review. That is stated plainly here rather than buried, because you deserve to know what
you are installing and reading the code of. Every architectural decision in this file was
made deliberately and is defended in the code comments; where something is unverified, the
code says so instead of pretending.

## Stack

| Layer | Technology |
|---|---|
| UI | Framework7 v8 + Vue 3 (**Options API**, no TypeScript) |
| Native shell | Capacitor v6 (Android; minSdk 26, target 35) |
| Icons | Ionicons — inlined as SVG, see below |
| i18n | vue-i18n (de/en, picked from `navigator.language`) |
| HTTP (native) | `CapacitorHttp` — no CORS to fight |
| HTTP (dev web) | same-origin proxy as Vite middleware |
| Feed parsing | own `DOMParser`-based parser (RSS + Atom) |
| Article extraction | `@mozilla/readability` + `dompurify` |
| Persistence | `@capacitor/preferences` |
| Tests | Vitest (jsdom) |

## Getting started

```bash
npm install
npm run dev      # Vite, dev proxy included — one single process
npm test         # Vitest
npm run build    # production build into dist/

npx cap sync android
cd android && ./gradlew assembleDebug
```

Vite picks its own free port, and that is fine: the dev proxy runs as **middleware inside
the Vite server**, so it is same-origin by construction. A different port changes nothing.

## The dev proxy

In a browser, CORS blocks fetching foreign feeds and article pages. Natively it does not —
everything goes through `CapacitorHttp`. So the dev web build has proxy middleware in
[vite.config.js](vite.config.js):

```
GET /__proxy?url=https%3A%2F%2Fexample.com%2Ffeed     # feeds and articles
    /__dav?url=…                                      # WebDAV, forwards PUT bodies and ETags
```

[`src/utils/http.js`](src/utils/http.js) decides at runtime: `import.meta.env.DEV` → proxy,
otherwise `CapacitorHttp`.

> **History.** This used to be `cors-anywhere` as a separate process on port 8080, with an
> origin whitelist pinned to `localhost:5173`. Whenever either port was taken (Docker and
> WSL like both), the proxy died silently and *every* feed search failed. The middleware
> has neither a port of its own nor a whitelist, so it cannot break that way.

## Icons: no web component

Ionicons ships `<ion-icon>` as a lazily loaded Stencil component. Stencil pulls its chunks
in with `import(\`./${bundleId}.entry.js\`)` and marks that call `@vite-ignore` — so Vite
leaves it alone and **never emits the chunks**. In the dev server the relative path happens
to resolve into `node_modules/ionicons/dist/esm/`, where the files really are. In a
production build it points at nothing: 404, the custom element never upgrades, and **not a
single icon appears** — while the browser looks perfect.

So [`src/utils/icons.js`](src/utils/icons.js) unwraps the SVG markup that `ionicons/icons`
exports as data URIs and [`AppIcon.vue`](src/components/AppIcon.vue) renders it inline. No
network, no custom element, no lazy loading. `tests/icons.test.js` fails the build if an
icon name is used that the registry does not know, or if the web component ever returns.

## Adding feeds and links

The **`+`** in the navbar follows the tab you are in: Feed → subscribe, Saved → save a
link. Long-press it for the other one. Long-pressing an article card opens every quick
action it has, for anyone who does not know the card can be swiped.

**Subscribing** ([AddFeedPage](src/pages/AddFeedPage.vue)) takes any URL and
`discoverFeeds()` looks, in order: is this already a feed → `<link rel="alternate">` in the
HTML → known paths (`/feed`, `/rss`, `/atom.xml`, …). The HTML is parsed with `DOMParser`,
not a regex — spektrum.de writes `type=application/rss+xml` **without quotes**, and a regex
that expected them found nothing.

**Saving a link** ([AddLinkPage](src/pages/AddLinkPage.vue)) keeps a single article without
subscribing to the site. Such articles have `feedId: null`, are saved by definition, and
appear **only** under Saved — never in the Feed tab. Since no feed can bring them back,
unsaving one *deletes* it.

## Sharing into the app (Android)

Quell Feed registers for `ACTION_SEND` / `text/plain`. What arrives is rarely a bare URL —
Chrome sends "Page title https://example.com/article" — so the text is mined for a URL.

A shared **article** is saved silently, confirmed with a **native** toast (a Framework7
toast lives in the WebView and would die with it) and the app puts itself back in the
background: you never wanted to leave the browser. A shared **feed** — a bare domain, or a
`/feed`, `/rss`, `.xml` path — opens the subscribe screen, because that is a decision.

The native half is [`ShareIntentPlugin.java`](android/app/src/main/java/de/quellfeed/ShareIntentPlugin.java),
written by hand: Capacitor's `BridgeActivity.onNewIntent()` never calls `setIntent()`, so
any plugin reading the activity's intent keeps seeing the original launch intent and
concludes nothing was shared. The plugin repairs that, and **consumes** the intent when it
hands the text over, so a later resume cannot re-save the same link.

## Reading: font, size, width, theme

The reading view renders in a sandboxed iframe with no JavaScript. Font, font size
(five steps, 100 % exactly in the middle), line width (in `ch`, so the column grows with
the font) and colour theme are all configurable.

Two traps that are solved here and are easy to reintroduce:

- The iframe is a **`srcdoc`**, so its document URL is `about:srcdoc` — and **`'self'`
  cannot be resolved against that**. A CSP of `font-src 'self'` therefore blocks *our own*
  bundled fonts: the `@font-face` rule applies, the family changes, but the woff2 never
  loads and the text silently falls back. The CSP names our origin explicitly.
- Framework7 switches its dark variants on a plain **`.dark` class** on `<html>`. It never
  reads our `data-theme`. Without that class every F7 widget stays in its light variant, no
  matter what the app's own theme says.

## Reading aloud

The reading view speaks the article through the **OS speech engine**, skipping images and
captions. The currently spoken paragraph is highlighted and scrolls into view; tapping a
paragraph continues from there.

The plugin has **no pause/resume** — only `speak()` and `stop()`. Pause is built on the
`onRangeStart` event (character offsets into the string we handed over): we remember the
offset, stop, and on resume speak the remainder of that paragraph. Long gaps between
paragraphs came from two things, both fixed: blank lines in the extracted text (which the
engine renders as a long silence), and the plugin's default `QUEUE_FLUSH`, which restarts
the engine at every utterance boundary. The first utterance flushes, every following one is
queued with `QUEUE_ADD`, with one chunk always preloaded.

## AI (bring your own key)

No backend means **no shipped API key** — anything in the bundle is extractable, native app
or not. So the user brings their own ([`ai.js`](src/utils/ai.js), OpenAI-compatible
`/chat/completions`):

| Preset | Base URL |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Custom | anything — Ollama, LM Studio, Groq … |

Summaries sit collapsed above the article; translation is a button in the article toolbar.
Long articles are **chunked, not truncated** — a truncated translation hands the reader an
article that stops mid-sentence.

The key goes only to the chosen provider and appears in **no** log line and **no** error
message. There are regression tests for exactly that.

## Sync

Three targets, all of them direct between the device and a server the **user** owns.

**WebDAV** ([`sync.js`](src/utils/sync.js)) is the full one: feeds *and* articles, both
directions, deletions included, in **one JSON file** in our own format. Two constraints
shape it:

- **`CapacitorHttp` cannot do `PROPFIND` on Android.** `HttpURLConnection` only allows the
  standard methods and throws `ProtocolException` otherwise. So the sync uses **GET and PUT
  only** — no PROPFIND, no MKCOL (which is why the folder must already exist).
- **Conflicts via `ETag` / `If-Match`** (HTTP 412), verified against sabre/dav
  (Nextcloud, ownCloud). Synology and mailbox.org are unverified, so there is a
  content-based fallback.

Identity is the **URL**, never the local `id` (a `crypto.randomUUID()`, different on every
device). Deletions leave tombstones. `cachedHtml` is never synced — it is a cache, can be
megabytes, and is locally rebuildable.

**KaraKeep**, **Linkwarden** and **Instapaper** are bookmark services: the server holds the truth, and only
saved articles travel. Both were tested against live servers, which corrected several
assumptions that would have destroyed data — the details are in the code comments, because
that is where the next person will need them. Two things worth knowing up front:

- KaraKeep's `POST /bookmarks` dedupes **only on a byte-identical URL**, and then it is a
  **pure no-op**: title, note and flags are all discarded. Only a PATCH ever changes an
  existing bookmark.
- Linkwarden's `collection: { name }` is an **unconditional CREATE**, not find-or-create —
  twenty syncs would leave twenty identical collections. And it can store **no publication
  date** and has **no read state** at all; the settings page says so up front rather than
  letting you discover it after 300 articles.
- Instapaper (API v2) authenticates with a **personal access token**, not an OAuth flow: the
  code exchange needs the application's client secret, and an app without a backend has
  nowhere safe to keep one. Each user registers their own Owner Only application and
  pastes the token — the same bring-your-own model as the other two. Saved = exists
  (Home + Archive), archive ↔ `archived`, date ← `pubtime`; read state stays local. Built
  from the published OpenAPI spec; **not yet run against a live account**.

## Logged-in sites (paywalls)

If you subscribe to a newspaper, you can log in to it inside the app's own browser and then
read the full article. Your credentials go to the newspaper's own login page and **never
leave the device** — we never see them, and there is nowhere for them to go.

It works because Capacitor installs `CapacitorCookies` as the global `java.net.CookieHandler`,
delegating to Android's `CookieManager`. Cookies set in the in-app WebView therefore reach
`CapacitorHttp` automatically, HttpOnly ones included. (Chrome Custom Tabs would **not**
share that jar — which is why the in-app browser is a WebView.)

## Import and export

OPML for the **feeds**. Individually saved articles (`feedId: null`) go out and come in as
**Netscape bookmarks** — the format every browser reads and writes.

## Favicons

From the site itself: `https://<host>/favicon.ico`, and whatever the page declared in
`<link rel="icon">` when we had its HTML in hand anyway. Never fetched just for an icon.

This used to be Google's `s2/favicons`, which meant that merely scrolling the feed list told
Google which sites you read — the one place the "nothing leaves your device" promise was
quietly broken. `icons.duckduckgo.com` is kept as a **fallback** for the few hosts that keep
no favicon of their own: it answers a plain 404 where Google hands back a generic globe that
looks like a real icon and is worse than nothing.

## Local data model

```
feeds[]     id, url, title, favicon, lastFetched, updatedAt
articles[]  id, feedId, source?, url, title, description, image,
            isRead, isSaved, publishedAt, updatedAt, cachedHtml?
tombstones  deletions, so a sync cannot resurrect what you removed
settings    language, theme, reading{font,size,width},
            ai, webdav, karakeep, linkwarden, instapaper, paywall
```

`source` is only set on link articles; for feed articles the feed title is the source name.
`cachedHtml` exists only for saved articles and is what makes them readable offline.

## Domain configs

Readability does not do well on every site. A per-domain JSON config can prescribe
selectors:

```json
{
  "presentation": { "showFeedImage": false, "showArticleTitle": true },
  "selectors": {
    "container": ["article", "main article", "main"],
    "remove": ["aside", "nav", ".ad", ".related"]
  }
}
```

They live in **`docs/configs/<domain>.json`** — inside the GitHub-Pages folder,
next to the website, because that is what they are: published content, not app assets.
The app fetches them remotely with a 28-day TTL ([`domainConfig.js`](src/utils/domainConfig.js));
**there is no bundled copy** — a saved article reads from its cached HTML and never asks
for a config, so there is no moment where you hold an article but lack its rules. In dev,
a small Vite middleware serves the same `/configs/*` paths from `docs/configs/`.

**Extraction order:** domain config → Readability → `<article>` → `<main>` → `<body>`. Then
always DOMPurify, rendered in a sandboxed iframe with no JavaScript.

## Project layout

```
src/
  main.js            app bootstrap
  routes.js          Framework7 routes
  store/index.js     the one reactive store, global as $store
  pages/             Feed · Saved · ReadingView · AddFeed · AddLink · settings/
  components/        ArticleCard (swipe + hold actions), AppIcon
  utils/             http · feedParser · articleParser · articleText · speech ·
                     mediaSession · sync · webdav · karakeep · linkwarden · instapaper · ai ·
                     shareTarget · icons · fonts · theme · favicon · opml · bookmarks
  i18n/              de · en
  css/app.css        brand tokens + Framework7 overrides
android/             native Android project — committed on purpose, see below
ios/                 native iOS project — built unsigned in CI, for sideloading
public/              app assets that ship inside the APK (favicons)
docs/                the GitHub-Pages site: landing page + domain configs — NOT app code
branding/            master SVGs and the 1024px iOS icon — the only lossless sources
tests/               Vitest
```

`docs/` deploys straight from the branch (Settings → Pages → Deploy from a branch →
`/docs`); there is no build step and no workflow. `docs/CNAME` pins quellfeed.de. The
imprint and privacy pages are the author's existing ones and are linked, not duplicated.

`android/` is **in** the repository. It holds hand-written configuration — the share intent
filter, the launcher icons, the splash, the app name, `ShareIntentPlugin.java` — none of
which `npx cap add android` would restore.

## Releases

Pushing a tag like `v0.2.0` runs [release.yml](.github/workflows/release.yml): tests
first, then a **signed Android APK** and an **unsigned iOS IPA** are built and attached
to a GitHub Release. The website links straight to those assets.

```bash
git tag v0.2.0
git push origin v0.2.0
```

The version inside the APK comes from the tag (`versionName = 0.2.0`) and the workflow
run number (`versionCode`), so it only ever grows — nothing to bump by hand.

### One-time setup: the Android signing key

Android refuses to install an unsigned APK, so releases need a key. You create it
**once** and keep it **forever** — updates must be signed with the same key, or Android
treats them as a different app. The setup follows the standard Android convention
(a `keystore.properties` file the build reads, never committed), so it works the same
as in any other Capacitor or plain Android project.

**Step 1: Create the keystore**

Open a terminal in the project directory and run (`keytool` ships with every JDK):

Linux/macOS:

```bash
keytool -genkeypair -v -keystore android/app/quellfeed-release.jks \
  -keyalg RSA -keysize 4096 -validity 10000 -alias quellfeed
```

Windows (if `keytool` is not on PATH, use the Android Studio JBR):

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v `
  -keystore android/app/quellfeed-release.jks `
  -keyalg RSA -keysize 4096 -validity 10000 -alias quellfeed
```

You will be asked for the following information:
- **Keystore password**: choose a secure one (at least 6 characters)
- **Key password**: you can use the same (just press Enter)
- **Name, organization, etc.**: fill in or leave blank

⚠️ **Important**: back the passwords and the `.jks` file up somewhere safe! Without
them you will never be able to publish app updates again.

**Step 2: Create the keystore.properties file**

Create a file `android/keystore.properties` with the following content:

```properties
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=quellfeed
storeFile=quellfeed-release.jks
```

Replace `YOUR_KEYSTORE_PASSWORD` and `YOUR_KEY_PASSWORD` with your actual passwords.

⚠️ **Security**: `android/keystore.properties` and `*.jks` are already in `.gitignore`
and will never be checked into the repository.

**Step 3: Build a signed release APK locally**

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

(on Windows: `.\gradlew assembleRelease`)

The signed APK can be found at:

```
android/app/build/outputs/apk/release/app-release.apk
```

Without `-PquellVersionName`/`-PquellVersionCode` a local build stamps itself
`0.0.0-dev` — fine for testing on a device; real version numbers come from the tag in CI.

**Step 4: Hand the same key to CI**

CI signs with the same keystore, passed as four repository secrets. Encode it first
(secrets are text, the keystore is binary):

Linux/macOS:

```bash
base64 -w0 android/app/quellfeed-release.jks > encoded.txt
```

Windows:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("android/app/quellfeed-release.jks")) | Set-Clipboard
```

Then store four secrets under *GitHub → repo → Settings → Secrets and variables →
Actions → New repository secret*:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the base64 text from above |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `quellfeed` |
| `ANDROID_KEY_PASSWORD` | the key password |

Or with the CLI: `gh secret set ANDROID_KEYSTORE_BASE64 < encoded.txt` etc.

### iOS: why the IPA is unsigned

Signing an iOS app for distribution needs a paid Apple Developer account. Sideloading
does not: **AltStore/SideStore re-sign the IPA with the user's own free Apple ID** on
installation. So CI builds the archive with `CODE_SIGNING_ALLOWED=NO` and ships the raw
IPA. If the app ever goes to the App Store, that release path gets a signed lane — the
unsigned one stays for sideloaders.

The IPA contains the **QuellShare share extension** (the app's entry in the iOS share
sheet) plus an **App Group** (`group.de.quellfeed`) through which the extension hands
shared links to the app. Two honest caveats for sideloaders, from AltStore's own FAQ:
every embedded extension consumes an extra "App ID" (a free Apple ID gets 10 per
week), so AltStore asks on install whether to keep the extension — **stripping it
keeps the app fully working, only the share-sheet entry disappears**. And app-group
identifiers are rewritten during re-signing to the signer's own team namespace; app
and extension are rewritten together, so the handover keeps working. One caveat on
top, unverified without a device: our IPA is built **unsigned**, and entitlements
normally travel inside the signature — whether AltStore reconstructs the app-group
entitlement from the `.entitlements` files in an unsigned archive is exactly the part
CI cannot prove. If it does not, the failure is quiet: the share sheet still confirms,
but the link never reaches the app. The
project files for all of this live in `ios/` and are wired into the Xcode project by
[scripts/add-ios-targets.mjs](scripts/add-ios-targets.mjs) (idempotent, no Mac
needed).

## Conventions

- **Vue Options API** (`data` / `computed` / `methods`). Never the Composition API.
- JavaScript. No TypeScript.
- Colours go through the `--q-*` tokens in [`app.css`](src/css/app.css) and
  [`theme.js`](src/utils/theme.js); Framework7's `--f7-*` variables are fed from them. No
  hardcoded colours in components. There is a test that every palette defines the same keys
  — and that a palette's accent is not merely a shade of its own text colour, which is how
  sepia ended up with a "primary" nobody could see.
- Framework7 renders inputs itself (`outline` + `floating-label`). Adding our own borders or
  dropdown arrows produces two of each — set tokens, do not rebuild the widgets.
- A comment explains a constraint the code cannot show. If something is unverified, it says
  so.
