/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'de.quellfeed',
  // Home-Screen-Label. Der volle Name „Quell Feed – RSS und Lesezeichen" steht nur im
  // Store-Eintrag. Wirkt nur bei `cap add`; maßgeblich ist android/…/values/strings.xml.
  appName: 'Quell Feed',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      // The app hides the splash itself (App.vue), once the store is loaded and the
      // theme is applied. With auto-hide the splash used to vanish onto a white,
      // empty WebView for the half second the storage read takes.
      launchAutoHide: false,
      launchFadeOutDuration: 200,
      androidSplashResourceName: 'splash',
    },
  },
}

module.exports = config
