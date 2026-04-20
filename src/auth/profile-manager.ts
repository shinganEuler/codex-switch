import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { AuthData, ProfileSummary, StorageMode } from '../types'
import { getDefaultCodexAuthPath, loadAuthDataFromFile } from './auth-manager'
import { syncCodexAuthFile } from './codex-auth-sync'
import {
  SharedActiveProfile,
  SHARED_LEGACY_ACTIVE_PROFILE_FILENAME,
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedActiveProfilePath,
  getSharedActiveProfileFilename,
  getLegacySharedActiveProfilePath,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  writeJsonFile,
} from './shared-profile-store'

type ProfileTokens = Pick<
  AuthData,
  'idToken' | 'accessToken' | 'refreshToken' | 'accountId' | 'authJson'
>

interface ProfilesFileV1 {
  version: 1
  profiles: ProfileSummary[]
}

const PROFILES_FILENAME = 'profiles.json'
const ACTIVE_PROFILE_KEY = 'codexIdentityRouter.activeProfileId'
const LAST_PROFILE_KEY = 'codexIdentityRouter.lastProfileId'
const SECRET_PREFIX = 'codexIdentityRouter.profile.'

interface ExportedProfileEntryV1 {
  profile: ProfileSummary
  tokens: ProfileTokens
}

interface ExportedSettingsV1 {
  format: 'codex-identity-router-profile-export'
  version: 1
  exportedAt: string
  activeProfileId?: string
  lastProfileId?: string
  profiles: ExportedProfileEntryV1[]
}

interface ImportProfilesResult {
  created: number
  updated: number
  skipped: number
}

interface ParsedImportEntry {
  sourceProfileId?: string
  name: string
  authData: AuthData
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const v = value.trim()
  return v ? v : undefined
}

export class ProfileManager {
  constructor(private context: vscode.ExtensionContext) {}

  private lastSyncedProfileId: string | undefined

  private getConfiguredStorageMode(): StorageMode {
    const cfg = vscode.workspace.getConfiguration('codexIdentityRouter')
    const raw = cfg.get<StorageMode>('storageMode', 'auto')
    if (
      raw === 'secretStorage' ||
      raw === 'remoteFiles' ||
      raw === 'customRemoteFiles' ||
      raw === 'auto'
    ) {
      return raw
    }
    return 'auto'
  }

  private getConfiguredRemoteFilesRoot(): string | undefined {
    const raw = vscode.workspace
      .getConfiguration('codexIdentityRouter')
      .get<string>('remoteFilesRoot', '')
    const value = String(raw || '').trim()
    return value ? value : undefined
  }

  private getResolvedStorageMode(): Exclude<StorageMode, 'auto'> {
    const configured = this.getConfiguredStorageMode()
    if (configured === 'auto') {
      return vscode.env.remoteName === 'ssh-remote'
        ? 'remoteFiles'
        : 'secretStorage'
    }
    return configured
  }

  private isRemoteFilesMode(): boolean {
    const mode = this.getResolvedStorageMode()
    return mode === 'remoteFiles' || mode === 'customRemoteFiles'
  }

  private getSharedStoreRootPath(): string {
    const mode = this.getResolvedStorageMode()
    const configuredRoot =
      mode === 'customRemoteFiles'
        ? this.getConfiguredRemoteFilesRoot()
        : undefined
    return getSharedStoreRoot(configuredRoot)
  }

  private normalizeEmail(email: string | undefined): string {
    return String(email || '')
      .trim()
      .toLowerCase()
  }

  private normalizeIdentity(value: string | undefined): string {
    return String(value || '').trim()
  }

  private compareIdentityField(
    profileValue: string | undefined,
    authValue: string | undefined,
  ): boolean | undefined {
    const p = this.normalizeIdentity(profileValue)
    const a = this.normalizeIdentity(authValue)
    if (!p || !a) {
      return undefined
    }
    return p === a
  }

  private matchesAuth(profile: ProfileSummary, authData: AuthData): boolean {
    const hasProfileOrganizationId = Boolean(
      this.normalizeIdentity(profile.defaultOrganizationId),
    )
    const hasAuthOrganizationId = Boolean(
      this.normalizeIdentity(authData.defaultOrganizationId),
    )
    const organizationIdMatch = this.compareIdentityField(
      profile.defaultOrganizationId,
      authData.defaultOrganizationId,
    )

    // Team/Business tenants can share account_id across different users.
    // Match by user identity fields first.
    // If identity matches and both sides know the selected workspace/org, require it too.
    const identityMatches = [
      this.compareIdentityField(profile.chatgptUserId, authData.chatgptUserId),
      this.compareIdentityField(profile.userId, authData.userId),
      this.compareIdentityField(profile.subject, authData.subject),
    ].filter((v): v is boolean => v !== undefined)

    if (identityMatches.length > 0) {
      if (identityMatches.some((v) => !v)) {
        return false
      }
      if (hasProfileOrganizationId || hasAuthOrganizationId) {
        // If workspace is known only on one side, avoid collapsing profiles.
        if (organizationIdMatch === undefined) {
          return false
        }
        return organizationIdMatch
      }
      return true
    }

    const pe = this.normalizeEmail(profile.email)
    const ae = this.normalizeEmail(authData.email)
    const hasComparableEmail =
      Boolean(pe) && Boolean(ae) && pe !== 'unknown' && ae !== 'unknown'
    const hasComparableAccountId =
      Boolean(authData.accountId) && Boolean(profile.accountId)
    const accountIdMatch = hasComparableAccountId
      ? authData.accountId === profile.accountId
      : false
    const hasComparableOrganizationId = organizationIdMatch !== undefined

    if (
      (hasProfileOrganizationId || hasAuthOrganizationId) &&
      !hasComparableOrganizationId
    ) {
      // Workspace is known only on one side: treat as distinct to avoid false matches.
      return false
    }

    if (
      hasComparableEmail &&
      hasComparableAccountId &&
      hasComparableOrganizationId
    ) {
      return pe === ae && accountIdMatch && organizationIdMatch === true
    }

    if (hasComparableEmail && hasComparableOrganizationId) {
      return pe === ae && organizationIdMatch === true
    }

    if (hasComparableEmail && hasComparableAccountId) {
      return pe === ae && accountIdMatch
    }

    if (hasComparableAccountId && hasComparableOrganizationId) {
      return accountIdMatch && organizationIdMatch === true
    }

    if (hasComparableEmail) {
      return pe === ae
    }

    return false
  }

  private getStorageDir(): string {
    if (this.isRemoteFilesMode()) {
      return this.getSharedStoreRootPath()
    }
    return this.context.globalStorageUri.fsPath
  }

  private getProfilesPath(): string {
    if (this.isRemoteFilesMode()) {
      return getSharedProfilesPath(this.getSharedStoreRootPath())
    }
    return path.join(this.getStorageDir(), PROFILES_FILENAME)
  }

  private ensureStorageDir() {
    if (this.isRemoteFilesMode()) {
      ensureSharedStoreDirs(this.getSharedStoreRootPath())
      return
    }

    const dir = this.getStorageDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private parseProfilesFile(raw: string): ProfilesFileV1 {
    const parsed: any = JSON.parse(raw)

    // Legacy format: plain array of profiles.
    if (Array.isArray(parsed)) {
      return { version: 1, profiles: parsed as ProfileSummary[] }
    }

    // Legacy format: { profiles: [...] } without a version.
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.profiles)
    ) {
      return { version: 1, profiles: parsed.profiles as ProfileSummary[] }
    }

    // Current format: { version: 1, profiles: [...] }
    if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) {
      return { version: 1, profiles: parsed.profiles as ProfileSummary[] }
    }

    return { version: 1, profiles: [] }
  }

  private async readProfilesFile(): Promise<ProfilesFileV1> {
    this.ensureStorageDir()
    const filePath = this.getProfilesPath()
    if (!fs.existsSync(filePath)) {
      return { version: 1, profiles: [] }
    }

    try {
      if (this.isRemoteFilesMode()) {
        const parsed = readJsonFile<any>(filePath)
        if (parsed == null) {
          return { version: 1, profiles: [] }
        }
        return this.parseProfilesFile(JSON.stringify(parsed))
      }
      const raw = fs.readFileSync(filePath, 'utf8')
      return this.parseProfilesFile(raw)
    } catch {
      // If corrupted, don't crash the extension.
      return { version: 1, profiles: [] }
    }
  }

  private writeProfilesFile(data: ProfilesFileV1) {
    this.ensureStorageDir()
    if (this.isRemoteFilesMode()) {
      writeJsonFile(this.getProfilesPath(), data)
      return
    }

    fs.writeFileSync(this.getProfilesPath(), JSON.stringify(data, null, 2), {
      encoding: 'utf8',
    })
  }

  private secretKey(profileId: string): string {
    return `${SECRET_PREFIX}${profileId}`
  }

  private readSharedActiveProfile(): SharedActiveProfile | null {
    if (!this.isRemoteFilesMode()) {
      return null
    }
    const storeRoot = this.getSharedStoreRootPath()
    return (
      readJsonFile<SharedActiveProfile>(getSharedActiveProfilePath(storeRoot)) ||
      readJsonFile<SharedActiveProfile>(getLegacySharedActiveProfilePath(storeRoot))
    )
  }

  private writeSharedActiveProfile(profileId: string): void {
    if (!this.isRemoteFilesMode()) {
      return
    }
    const storeRoot = this.getSharedStoreRootPath()
    writeJsonFile(getSharedActiveProfilePath(storeRoot), {
      profileId,
      updatedAt: new Date().toISOString(),
      machineName: getSharedActiveProfileFilename()
        .replace(/^active-profile@/, '')
        .replace(/\.json$/, ''),
    } satisfies SharedActiveProfile)
  }

  private deleteSharedActiveProfile(): void {
    if (!this.isRemoteFilesMode()) {
      return
    }
    const storeRoot = this.getSharedStoreRootPath()
    deleteFileIfExists(getSharedActiveProfilePath(storeRoot))
    deleteFileIfExists(getLegacySharedActiveProfilePath(storeRoot))
  }

  private readRemoteProfileTokens(profileId: string): ProfileTokens | null {
    return readJsonFile<ProfileTokens>(
      getSharedProfileSecretsPath(profileId, this.getSharedStoreRootPath()),
    )
  }

  private async readStoredTokens(
    profileId: string,
  ): Promise<ProfileTokens | null> {
    if (this.isRemoteFilesMode()) {
      return this.readRemoteProfileTokens(profileId)
    }

    const raw = await this.context.secrets.get(this.secretKey(profileId))
    if (!raw) {
      return null
    }

    try {
      return JSON.parse(raw) as ProfileTokens
    } catch {
      return null
    }
  }

  private async writeStoredTokens(
    profileId: string,
    tokens: ProfileTokens,
  ): Promise<void> {
    if (this.isRemoteFilesMode()) {
      const storeRoot = this.getSharedStoreRootPath()
      ensureSharedStoreDirs(storeRoot)
      writeJsonFile(getSharedProfileSecretsPath(profileId, storeRoot), tokens)
      return
    }

    await this.context.secrets.store(
      this.secretKey(profileId),
      JSON.stringify(tokens),
    )
  }

  private async deleteStoredTokens(profileId: string): Promise<void> {
    if (this.isRemoteFilesMode()) {
      deleteFileIfExists(
        getSharedProfileSecretsPath(profileId, this.getSharedStoreRootPath()),
      )
      return
    }

    await this.context.secrets.delete(this.secretKey(profileId))
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const file = await this.readProfilesFile()
    return [...file.profiles].sort((a, b) => a.name.localeCompare(b.name))
  }

  async getProfile(profileId: string): Promise<ProfileSummary | undefined> {
    const profiles = await this.listProfiles()
    return profiles.find((p) => p.id === profileId)
  }

  async exportProfilesForTransfer(): Promise<{
    data: ExportedSettingsV1
    skipped: number
  }> {
    const profiles = await this.listProfiles()
    const activeProfileId = await this.getActiveProfileId()
    const lastProfileId = await this.getLastProfileId()

    const exportedProfiles: ExportedProfileEntryV1[] = []
    let skipped = 0

    for (const profile of profiles) {
      const tokens = await this.readStoredTokens(profile.id)
      if (!tokens) {
        skipped += 1
        continue
      }
      exportedProfiles.push({ profile, tokens })
    }

    const data: ExportedSettingsV1 = {
      format: 'codex-identity-router-profile-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      activeProfileId,
      lastProfileId,
      profiles: exportedProfiles,
    }

    return { data, skipped }
  }

  private parseImportEntry(value: unknown): ParsedImportEntry | null {
    const entry = asObject(value)
    if (!entry) {
      return null
    }

    const profile = asObject(entry.profile)
    const tokens = asObject(entry.tokens)
    if (!profile || !tokens) {
      return null
    }

    const idToken = asOptionalString(tokens.idToken)
    const accessToken = asOptionalString(tokens.accessToken)
    const refreshToken = asOptionalString(tokens.refreshToken)
    if (!idToken || !accessToken || !refreshToken) {
      return null
    }

    const email = asOptionalString(profile.email) || 'Unknown'
    const planType = asOptionalString(profile.planType) || 'Unknown'
    const name =
      asOptionalString(profile.name) ||
      (email !== 'Unknown' ? email.split('@')[0] : undefined) ||
      'profile'

    const authJson = asObject(tokens.authJson) || undefined
    const accountId =
      asOptionalString(tokens.accountId) || asOptionalString(profile.accountId)

    return {
      sourceProfileId: asOptionalString(profile.id),
      name,
      authData: {
        idToken,
        accessToken,
        refreshToken,
        accountId,
        defaultOrganizationId: asOptionalString(profile.defaultOrganizationId),
        defaultOrganizationTitle: asOptionalString(
          profile.defaultOrganizationTitle,
        ),
        chatgptUserId: asOptionalString(profile.chatgptUserId),
        userId: asOptionalString(profile.userId),
        subject: asOptionalString(profile.subject),
        email,
        planType,
        authJson,
      },
    }
  }

  async importProfilesFromTransfer(
    value: unknown,
  ): Promise<ImportProfilesResult> {
    const payload = asObject(value)
    if (!payload) {
      throw new Error('Invalid settings file format.')
    }

    const format = asOptionalString(payload.format)
    if (format !== 'codex-identity-router-profile-export') {
      throw new Error('Unsupported settings file format.')
    }

    if (payload.version !== 1) {
      throw new Error('Unsupported settings export version.')
    }

    if (!Array.isArray(payload.profiles)) {
      throw new Error('Invalid settings file: profiles must be an array.')
    }

    const sourceToTargetId = new Map<string, string>()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const rawEntry of payload.profiles) {
      const parsed = this.parseImportEntry(rawEntry)
      if (!parsed) {
        skipped += 1
        continue
      }

      const duplicate = await this.findDuplicateProfile(parsed.authData)
      if (duplicate) {
        await this.replaceProfileAuth(duplicate.id, parsed.authData)
        if (parsed.sourceProfileId) {
          sourceToTargetId.set(parsed.sourceProfileId, duplicate.id)
        }
        updated += 1
        continue
      }

      const createdProfile = await this.createProfile(
        parsed.name,
        parsed.authData,
      )
      if (parsed.sourceProfileId) {
        sourceToTargetId.set(parsed.sourceProfileId, createdProfile.id)
      }
      created += 1
    }

    const importedActiveProfileId = asOptionalString(payload.activeProfileId)
    if (importedActiveProfileId) {
      const targetId = sourceToTargetId.get(importedActiveProfileId)
      if (targetId) {
        await this.setActiveProfileId(targetId)
      }
    }

    const importedLastProfileId = asOptionalString(payload.lastProfileId)
    if (importedLastProfileId) {
      const targetId = sourceToTargetId.get(importedLastProfileId)
      if (targetId) {
        await this.setLastProfileId(targetId)
      }
    }

    return { created, updated, skipped }
  }

  private async inferActiveProfileIdFromAuthFile(): Promise<
    string | undefined
  > {
    const authData = await loadAuthDataFromFile(getDefaultCodexAuthPath())
    if (!authData) {
      return undefined
    }

    const file = await this.readProfilesFile()
    const match = file.profiles.find((p) => this.matchesAuth(p, authData))
    return match?.id
  }

  async findDuplicateProfile(
    authData: AuthData,
  ): Promise<ProfileSummary | undefined> {
    const file = await this.readProfilesFile()
    return file.profiles.find((p) => this.matchesAuth(p, authData))
  }

  private authJsonEquals(
    left: Record<string, unknown> | undefined,
    right: Record<string, unknown> | undefined,
  ): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  }

  private getLastRefreshMs(
    authJson: Record<string, unknown> | undefined,
  ): number | undefined {
    const value = authJson?.last_refresh

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    if (typeof value !== 'string') {
      return undefined
    }

    const raw = value.trim()
    if (!raw) {
      return undefined
    }

    const numeric = Number(raw)
    if (Number.isFinite(numeric)) {
      return numeric
    }

    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  private hasSameStoredTokens(
    tokens: ProfileTokens | null,
    authData: AuthData,
  ): boolean {
    if (!tokens) {
      return false
    }

    return (
      tokens.idToken === authData.idToken &&
      tokens.accessToken === authData.accessToken &&
      tokens.refreshToken === authData.refreshToken &&
      (tokens.accountId || '') === (authData.accountId || '') &&
      this.authJsonEquals(tokens.authJson, authData.authJson)
    )
  }

  private shouldPersistCurrentAuth(
    storedTokens: ProfileTokens | null,
    authData: AuthData,
  ): boolean {
    if (!storedTokens) {
      return true
    }

    if (this.hasSameStoredTokens(storedTokens, authData)) {
      return false
    }

    const storedLastRefresh = this.getLastRefreshMs(storedTokens.authJson)
    const currentLastRefresh = this.getLastRefreshMs(authData.authJson)

    if (storedLastRefresh != null && currentLastRefresh != null) {
      return currentLastRefresh >= storedLastRefresh
    }

    if (currentLastRefresh != null) {
      return true
    }

    if (storedLastRefresh != null) {
      return false
    }

    // If freshness is unavailable on both sides, keep the stored copy to avoid
    // clobbering a possibly newer profile snapshot with an older runtime file.
    return false
  }

  private async maybePersistCurrentAuthForProfile(
    profileId: string | undefined,
  ): Promise<void> {
    if (!profileId) {
      return
    }

    const profile = await this.getProfile(profileId)
    if (!profile) {
      return
    }

    const authData = await loadAuthDataFromFile(getDefaultCodexAuthPath())
    if (!authData || !this.matchesAuth(profile, authData)) {
      return
    }

    const storedTokens = await this.readStoredTokens(profileId)
    if (!this.shouldPersistCurrentAuth(storedTokens, authData)) {
      return
    }

    await this.replaceProfileAuth(profileId, authData)
  }

  private async recoverMissingTokens(
    profileId: string,
  ): Promise<AuthData | null> {
    const profile = await this.getProfile(profileId)
    const recoverLabel = vscode.l10n.t('Recover from remote store')
    const importLabel = vscode.l10n.t('Import current ~/.codex/auth.json')
    const deleteLabel = vscode.l10n.t('Delete broken profile')

    const canRecoverFromRemote =
      !this.isRemoteFilesMode() &&
      this.readRemoteProfileTokens(profileId) != null

    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Profile "{0}" is missing tokens. Restore it before switching.',
        profile?.name || profileId,
      ),
      { modal: true },
      ...(canRecoverFromRemote ? [recoverLabel] : []),
      importLabel,
      deleteLabel,
    )

    if (pick === recoverLabel) {
      const tokens = this.readRemoteProfileTokens(profileId)
      if (tokens) {
        await this.writeStoredTokens(profileId, tokens)
        return this.loadAuthData(profileId)
      }
    }

    if (pick === importLabel) {
      const authData = await loadAuthDataFromFile(getDefaultCodexAuthPath())
      if (!authData) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Could not read auth from {0}. Run "codex login" first.',
            getDefaultCodexAuthPath(),
          ),
        )
        return null
      }
      await this.replaceProfileAuth(profileId, authData)
      return authData
    }

    if (pick === deleteLabel) {
      await this.deleteProfile(profileId)
    }

    return null
  }

  async replaceProfileAuth(
    profileId: string,
    authData: AuthData,
  ): Promise<boolean> {
    const file = await this.readProfilesFile()
    const idx = file.profiles.findIndex((p) => p.id === profileId)
    if (idx === -1) {
      return false
    }

    file.profiles[idx] = {
      ...file.profiles[idx],
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      updatedAt: new Date().toISOString(),
    }
    this.writeProfilesFile(file)

    const tokens: ProfileTokens = {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
    }
    await this.writeStoredTokens(profileId, tokens)
    return true
  }

  private async maybeSyncToCodexAuthFile(profileId: string): Promise<void> {
    if (!profileId) {
      return
    }
    if (this.lastSyncedProfileId === profileId) {
      return
    }

    const authData = await this.loadAuthData(profileId)
    if (!authData) {
      return
    }

    syncCodexAuthFile(getDefaultCodexAuthPath(), authData)
    this.lastSyncedProfileId = profileId
  }

  async createProfile(
    name: string,
    authData: AuthData,
  ): Promise<ProfileSummary> {
    const now = new Date().toISOString()
    const id = randomUUID()

    const profile: ProfileSummary = {
      id,
      name,
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      createdAt: now,
      updatedAt: now,
    }

    const file = await this.readProfilesFile()
    file.profiles.push(profile)
    this.writeProfilesFile(file)

    const tokens: ProfileTokens = {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: authData.authJson,
    }
    await this.writeStoredTokens(id, tokens)

    return profile
  }

  async renameProfile(profileId: string, newName: string): Promise<boolean> {
    const file = await this.readProfilesFile()
    const idx = file.profiles.findIndex((p) => p.id === profileId)
    if (idx === -1) {
      return false
    }
    file.profiles[idx] = {
      ...file.profiles[idx],
      name: newName,
      updatedAt: new Date().toISOString(),
    }
    this.writeProfilesFile(file)
    return true
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const file = await this.readProfilesFile()
    const before = file.profiles.length
    file.profiles = file.profiles.filter((p) => p.id !== profileId)
    if (file.profiles.length === before) {
      return false
    }
    this.writeProfilesFile(file)

    await this.deleteStoredTokens(profileId)

    // Clean up active/last if they point to deleted profile.
    const active = await this.getActiveProfileId()
    const last = await this.getLastProfileId()
    if (active === profileId) {
      await this.setActiveProfileId(undefined)
    }
    if (last === profileId) {
      await this.setLastProfileId(undefined)
    }
    return true
  }

  async loadAuthData(profileId: string): Promise<AuthData | null> {
    const profile = await this.getProfile(profileId)
    if (!profile) {
      return null
    }

    const tokens = await this.readStoredTokens(profileId)
    if (!tokens) {
      return null
    }

    return {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId || profile.accountId,
      defaultOrganizationId: profile.defaultOrganizationId,
      defaultOrganizationTitle: profile.defaultOrganizationTitle,
      chatgptUserId: profile.chatgptUserId,
      userId: profile.userId,
      subject: profile.subject,
      email: profile.email,
      planType: profile.planType,
      authJson: tokens.authJson,
    }
  }

  private getStateBucket(): vscode.Memento {
    const scope = vscode.workspace
      .getConfiguration('codexIdentityRouter')
      .get<'global' | 'workspace'>('activeProfileScope', 'global')
    return scope === 'workspace'
      ? this.context.workspaceState
      : this.context.globalState
  }

  async getActiveProfileId(): Promise<string | undefined> {
    if (this.isRemoteFilesMode()) {
      const explicit = this.readSharedActiveProfile()?.profileId
      const inferred = await this.inferActiveProfileIdFromAuthFile()

      if (inferred) {
        if (explicit !== inferred) {
          this.writeSharedActiveProfile(inferred)
        }
        return inferred
      }

      return explicit
    }

    const bucket = this.getStateBucket()
    const v = bucket.get<string>(ACTIVE_PROFILE_KEY)
    if (v) {
      return v
    }
    return undefined
  }

  async setActiveProfileId(profileId: string | undefined): Promise<boolean> {
    const bucket = this.getStateBucket()
    const prev = this.isRemoteFilesMode()
      ? await this.getActiveProfileId()
      : bucket.get<string>(ACTIVE_PROFILE_KEY)

    await this.maybePersistCurrentAuthForProfile(prev)

    let authData: AuthData | null = null
    if (profileId) {
      authData = await this.loadAuthData(profileId)
      if (!authData) {
        authData = await this.recoverMissingTokens(profileId)
        if (!authData) {
          return false
        }
      }
    }

    if (prev && profileId && prev !== profileId) {
      await this.setLastProfileId(prev)
    }

    if (this.isRemoteFilesMode()) {
      if (profileId) {
        this.writeSharedActiveProfile(profileId)
      } else {
        this.deleteSharedActiveProfile()
      }
    } else {
      await bucket.update(ACTIVE_PROFILE_KEY, profileId)
    }

    if (profileId && authData) {
      // We already validated tokens above; avoid a second secret read.
      syncCodexAuthFile(getDefaultCodexAuthPath(), authData)
      this.lastSyncedProfileId = profileId
    }
    return true
  }

  async getLastProfileId(): Promise<string | undefined> {
    const bucket = this.getStateBucket()
    const v = bucket.get<string>(LAST_PROFILE_KEY)
    if (v) {
      return v
    }
    return undefined
  }

  private async setLastProfileId(profileId: string | undefined): Promise<void> {
    const bucket = this.getStateBucket()
    await bucket.update(LAST_PROFILE_KEY, profileId)
  }

  async toggleLastProfileId(): Promise<string | undefined> {
    const active = await this.getActiveProfileId()
    const last = await this.getLastProfileId()
    if (!last) {
      return undefined
    }

    const ok = await this.setActiveProfileId(last)
    if (ok && active) {
      // Swap so a second click toggles back.
      await this.setLastProfileId(active)
    }
    return ok ? last : undefined
  }

  async syncActiveProfileToCodexAuthFile(): Promise<void> {
    const active = await this.getActiveProfileId()
    if (!active) {
      return
    }
    await this.maybePersistCurrentAuthForProfile(active)
    await this.maybeSyncToCodexAuthFile(active)
  }

  createWatchers(onChanged: () => void): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = []
    const fire = () => {
      try {
        onChanged()
      } catch {
        // ignore refresh errors from file watchers
      }
    }

    const authDir = path.dirname(getDefaultCodexAuthPath())
    const authWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(authDir), 'auth.json'),
    )
    authWatcher.onDidCreate(fire)
    authWatcher.onDidChange(fire)
    authWatcher.onDidDelete(fire)
    disposables.push(authWatcher)

    if (this.isRemoteFilesMode()) {
      const profilesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(this.getSharedStoreRootPath()),
          PROFILES_FILENAME,
        ),
      )
      profilesWatcher.onDidCreate(fire)
      profilesWatcher.onDidChange(fire)
      profilesWatcher.onDidDelete(fire)
      disposables.push(profilesWatcher)

      const activeWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(this.getSharedStoreRootPath()),
          getSharedActiveProfileFilename(),
        ),
      )
      activeWatcher.onDidCreate(fire)
      activeWatcher.onDidChange(fire)
      activeWatcher.onDidDelete(fire)
      disposables.push(activeWatcher)

      const legacyActiveWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(this.getSharedStoreRootPath()),
          SHARED_LEGACY_ACTIVE_PROFILE_FILENAME,
        ),
      )
      legacyActiveWatcher.onDidCreate(fire)
      legacyActiveWatcher.onDidChange(fire)
      legacyActiveWatcher.onDidDelete(fire)
      disposables.push(legacyActiveWatcher)

      const tokenWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(getSharedProfilesDir(this.getSharedStoreRootPath())),
          '*.json',
        ),
      )
      tokenWatcher.onDidCreate(fire)
      tokenWatcher.onDidChange(fire)
      tokenWatcher.onDidDelete(fire)
      disposables.push(tokenWatcher)
    }

    return disposables
  }
}
