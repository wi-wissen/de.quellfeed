import { Preferences } from '@capacitor/preferences'

export async function storageGet(key) {
  const { value } = await Preferences.get({ key })
  return value ? JSON.parse(value) : null
}

export async function storageSet(key, value) {
  await Preferences.set({ key, value: JSON.stringify(value) })
}

export async function storageRemove(key) {
  await Preferences.remove({ key })
}

export async function storageRemoveByPrefix(prefix) {
  const { keys } = await Preferences.keys()
  const matchingKeys = keys.filter(key => key.startsWith(prefix))
  await Promise.all(matchingKeys.map(key => Preferences.remove({ key })))
  return matchingKeys.length
}
