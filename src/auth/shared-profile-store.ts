import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const SHARED_STORE_DIRNAME = '.codex-switch'
export const SHARED_PROFILES_DIRNAME = 'profiles'
export const SHARED_PROFILES_FILENAME = 'profiles.json'
export const SHARED_ACTIVE_PROFILE_FILENAME = 'active-profile.json'

export interface SharedActiveProfile {
  profileId: string
  updatedAt: string
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

export function getSharedStoreRoot(storeRoot?: string): string {
  const raw = String(storeRoot || '').trim()
  if (!raw) {
    return path.join(os.homedir(), SHARED_STORE_DIRNAME)
  }
  return path.resolve(expandHomePath(raw))
}

export function getSharedProfilesDir(storeRoot?: string): string {
  return path.join(getSharedStoreRoot(storeRoot), SHARED_PROFILES_DIRNAME)
}

export function getSharedProfilesPath(storeRoot?: string): string {
  return path.join(getSharedStoreRoot(storeRoot), SHARED_PROFILES_FILENAME)
}

export function getSharedActiveProfilePath(storeRoot?: string): string {
  return path.join(getSharedStoreRoot(storeRoot), SHARED_ACTIVE_PROFILE_FILENAME)
}

export function getSharedProfileSecretsPath(
  profileId: string,
  storeRoot?: string,
): string {
  return path.join(getSharedProfilesDir(storeRoot), `${profileId}.json`)
}

export function ensureSharedStoreDirs(storeRoot?: string): void {
  fs.mkdirSync(getSharedStoreRoot(storeRoot), { recursive: true, mode: 0o700 })
  fs.mkdirSync(getSharedProfilesDir(storeRoot), { recursive: true, mode: 0o700 })
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function deleteFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // ignore cleanup failures
  }
}
