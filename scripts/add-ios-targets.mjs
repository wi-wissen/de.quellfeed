// Wires the hand-written iOS native code into ios/App/App.xcodeproj — WITHOUT Xcode.
//
// This project is developed on Windows; the pbxproj cannot be edited through Xcode's
// GUI here, and editing it by hand is how projects rot. So this script does the two
// pieces of project surgery once, through the `xcode` npm package (the pbxproj
// library Cordova has used for years):
//
//   1. Adds the app-target sources (ShareIntentPlugin.swift, MediaControlPlugin.swift,
//      AppViewController.swift) and the App Group entitlements to the App target.
//   2. Creates the QuellShare share-extension target: sources, Info.plist,
//      entitlements, build settings, the Embed-App-Extensions copy phase on the App
//      target and the target dependency App → QuellShare.
//
// Idempotent by design: every step checks whether its result already exists, so a
// second run is a no-op ("already present" all the way down). Run from the repo root:
//
//   node scripts/add-ios-targets.mjs
//
// Verification without a Mac (all done by this script or CI):
//   - the script re-parses its own output (round-trip through the same parser),
//   - a second run must report no changes,
//   - the real proof is the macOS release workflow, which builds the archive.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import xcode from 'xcode'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const projectPath = join(repoRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj')

const APP_GROUP_FILES = [
  'AppViewController.swift',
  'ShareIntentPlugin.swift',
  'MediaControlPlugin.swift',
]

const EXTENSION_NAME = 'QuellShare'
const EXTENSION_BUNDLE_ID = 'de.quellfeed.QuellShare'

// Everything the app target's own configs already pin down and the extension must
// match. Values are written exactly as pbxproj wants them (quoting included).
const EXTENSION_BUILD_SETTINGS = {
  INFOPLIST_FILE: '"QuellShare/Info.plist"',
  PRODUCT_BUNDLE_IDENTIFIER: `"${EXTENSION_BUNDLE_ID}"`,
  PRODUCT_NAME: '"$(TARGET_NAME)"',
  CODE_SIGN_ENTITLEMENTS: '"QuellShare/QuellShare.entitlements"',
  CODE_SIGN_STYLE: 'Automatic',
  // Same floor as the app (see the App target's configs) — an extension newer than
  // its host will not install.
  IPHONEOS_DEPLOYMENT_TARGET: '13.0',
  SWIFT_VERSION: '5.0',
  TARGETED_DEVICE_FAMILY: '"1,2"',
  MARKETING_VERSION: '1.0',
  CURRENT_PROJECT_VERSION: '1',
  SKIP_INSTALL: 'YES',
  LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function parseProject() {
  const project = xcode.project(projectPath)
  project.parseSync()
  return project
}

/** All XCBuildConfiguration objects belonging to a configuration list. */
function configsOf(project, configurationListUuid) {
  const lists = project.hash.project.objects.XCConfigurationList
  const configs = project.hash.project.objects.XCBuildConfiguration
  return lists[configurationListUuid].buildConfigurations.map(ref => configs[ref.value])
}

function addAppTargetSources(project, appGroupKey, appTargetUuid) {
  let changed = false
  for (const file of APP_GROUP_FILES) {
    // hasFile matches the file-reference path as written into the group.
    if (project.hasFile(file)) continue
    project.addSourceFile(file, { target: appTargetUuid }, appGroupKey)
    changed = true
  }
  return changed
}

function addAppEntitlements(project, appGroupKey, appTargetUuid) {
  let changed = false

  if (!project.hasFile('App.entitlements')) {
    project.addFile('App.entitlements', appGroupKey)
    changed = true
  }

  const target = project.hash.project.objects.PBXNativeTarget[appTargetUuid]
  for (const config of configsOf(project, target.buildConfigurationList)) {
    if (config.buildSettings.CODE_SIGN_ENTITLEMENTS !== '"App/App.entitlements"') {
      config.buildSettings.CODE_SIGN_ENTITLEMENTS = '"App/App.entitlements"'
      changed = true
    }
  }
  return changed
}

function addExtensionTarget(project, appTargetUuid) {
  const targets = project.hash.project.objects.PBXNativeTarget
  const exists = Object.keys(targets).some(
    key => !key.endsWith('_comment') && targets[key].name?.replace(/"/g, '') === EXTENSION_NAME
  )
  if (exists) return false

  // The library's addTargetDependency() SILENTLY does nothing when the pbxproj has
  // no PBXTargetDependency / PBXContainerItemProxy sections yet — and the Capacitor
  // template has neither, because its single target depends on nothing. Seed them,
  // or the App target would never wait for (nor embed a fresh) QuellShare.appex.
  const objects = project.hash.project.objects
  objects.PBXTargetDependency = objects.PBXTargetDependency || {}
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {}

  // Creates the target, its product (.appex), a Copy Files phase (dstSubfolderSpec 13,
  // PlugIns) on the FIRST target — which is App — with the product in it, and the
  // App → QuellShare dependency. Verified against xcode/lib/pbxProject.js addTarget().
  const target = project.addTarget(EXTENSION_NAME, 'app_extension', EXTENSION_NAME, EXTENSION_BUNDLE_ID)

  // The library seeds INFOPLIST_FILE via path.join(), which produces a backslash on
  // Windows, and it knows nothing about Swift or entitlements — overwrite the build
  // settings wholesale with what this project actually needs.
  for (const config of configsOf(project, target.pbxNativeTarget.buildConfigurationList)) {
    Object.assign(config.buildSettings, EXTENSION_BUILD_SETTINGS)
    if (config.name === 'Debug') {
      config.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = 'DEBUG'
      config.buildSettings.DEBUG_INFORMATION_FORMAT = 'dwarf'
    } else {
      config.buildSettings.DEBUG_INFORMATION_FORMAT = '"dwarf-with-dsym"'
    }
    // The library seeds C-preprocessor defines; the extension is Swift-only, so
    // they would just be noise in the diff.
    delete config.buildSettings.GCC_PREPROCESSOR_DEFINITIONS
  }

  // Give Xcode's sidebar a QuellShare folder and attach it to the project root group.
  const group = project.addPbxGroup([], EXTENSION_NAME, EXTENSION_NAME)
  const rootGroupKey = project.getFirstProject().firstProject.mainGroup
  project.hash.project.objects.PBXGroup[rootGroupKey].children.push({
    value: group.uuid,
    comment: EXTENSION_NAME,
  })

  // The extension compiles exactly one file. Group path is QuellShare, so the file
  // path is relative to it.
  project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
  project.addSourceFile('ShareViewController.swift', { target: target.uuid }, group.uuid)

  // Plain file references (build settings point at them; no build phase involved).
  // The Info.plist reference is written by hand: the library's duplicate check keys
  // on the group-relative path, and "Info.plist" collides with App/Info.plist —
  // addFile() would silently do nothing.
  const infoRefUuid = project.generateUuid()
  objects.PBXFileReference[infoRefUuid] = {
    isa: 'PBXFileReference',
    lastKnownFileType: 'text.plist.xml',
    path: 'Info.plist',
    sourceTree: '"<group>"',
  }
  objects.PBXFileReference[`${infoRefUuid}_comment`] = 'Info.plist'
  objects.PBXGroup[group.uuid].children.push({ value: infoRefUuid, comment: 'Info.plist' })

  project.addFile('QuellShare.entitlements', group.uuid)

  // Cosmetics with a purpose: name the copy phase what Xcode would have named it,
  // and mark the appex RemoveHeadersOnCopy the way Xcode does.
  const copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase
  for (const key of Object.keys(copyPhases)) {
    if (key.endsWith('_comment')) continue
    if (copyPhases[key].dstSubfolderSpec === 13) {
      copyPhases[key].name = '"Embed App Extensions"'
      for (const file of copyPhases[key].files) {
        const buildFile = project.hash.project.objects.PBXBuildFile[file.value]
        if (buildFile) buildFile.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] }
      }
    }
  }

  return true
}

function verify(written) {
  const must = [
    'MediaControlPlugin.swift',
    'ShareIntentPlugin.swift',
    'AppViewController.swift',
    'App.entitlements',
    'ShareViewController.swift',
    `productType = "com.apple.product-type.app-extension"`,
    'Embed App Extensions',
    'dstSubfolderSpec = 13',
    `PRODUCT_BUNDLE_IDENTIFIER = "${EXTENSION_BUNDLE_ID}"`,
    'CODE_SIGN_ENTITLEMENTS = "QuellShare/QuellShare.entitlements"',
    'CODE_SIGN_ENTITLEMENTS = "App/App.entitlements"',
    'PBXTargetDependency',
  ]
  for (const needle of must) {
    if (!written.includes(needle)) fail(`expected pbxproj to contain: ${needle}`)
  }
  if (written.includes('\\\\')) fail('pbxproj contains a backslash path — Windows path.join leaked through')

  // Round-trip: the same parser must accept what was written.
  parseProject()
}

// ── Main ─────────────────────────────────────────────────────────────────────

for (const required of [
  'ios/App/App/AppViewController.swift',
  'ios/App/App/ShareIntentPlugin.swift',
  'ios/App/App/MediaControlPlugin.swift',
  'ios/App/App/App.entitlements',
  'ios/App/QuellShare/ShareViewController.swift',
  'ios/App/QuellShare/Info.plist',
  'ios/App/QuellShare/QuellShare.entitlements',
]) {
  if (!existsSync(join(repoRoot, required))) fail(`missing ${required} — create the source files first`)
}

const project = parseProject()
const appTargetUuid = project.getFirstTarget().uuid
const appGroupKey = project.findPBXGroupKey({ path: 'App' })
if (!appGroupKey) fail('could not find the App group in the pbxproj')

const before = readFileSync(projectPath, 'utf8')

const changed = [
  addAppTargetSources(project, appGroupKey, appTargetUuid),
  addAppEntitlements(project, appGroupKey, appTargetUuid),
  addExtensionTarget(project, appTargetUuid),
].some(Boolean)

if (!changed) {
  console.log('✓ nothing to do — pbxproj already contains all targets and files')
  verify(before)
  process.exit(0)
}

writeFileSync(projectPath, project.writeSync())
verify(readFileSync(projectPath, 'utf8'))
console.log('✓ pbxproj updated: App sources, entitlements, QuellShare extension target')
