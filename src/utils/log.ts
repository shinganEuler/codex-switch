import * as vscode from 'vscode'

export function isDebugLoggingEnabled(): boolean {
  return !!vscode.workspace
    .getConfiguration('codexIdentityRouter')
    .get<boolean>('debugLogging', false)
}

export function debugLog(...args: unknown[]) {
  if (isDebugLoggingEnabled()) {
    // Never log secrets; keep debug logs high-level.
    console.log('[codex-identity-router]', ...args)
  }
}

export function warnLog(...args: unknown[]) {
  console.warn('[codex-identity-router]', ...args)
}

export function errorLog(...args: unknown[]) {
  console.error('[codex-identity-router]', ...args)
}
