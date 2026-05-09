import { app, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createSerialQueue } from '#/main/util/serial-queue.ts'

/**
 * Encrypted secret storage for provider API keys.
 *
 * Uses Electron's built-in `safeStorage` API — no native dependency. On macOS
 * the key comes from the Keychain; on Windows from DPAPI; on Linux from the
 * secret-service (gnome-keyring / kwallet) *if available*. We refuse to
 * persist anything when encryption is unavailable rather than silently
 * downgrade to plaintext — the caller must surface a real error to the user.
 *
 * On-disk shape: `userData/secrets.json` holds a map
 *   { [providerId]: "<base64 of safeStorage.encryptString output>" }
 * The outer JSON is plaintext; only the values are encrypted. Keys (the
 * provider names) aren't secrets.
 */

/**
 * Provider id namespace.
 *
 * The three builtin ids (`anthropic` / `openai` / `google`) route through
 * pi-ai's model registry — the model ids are validated against what pi-ai
 * knows about.
 *
 * The three `custom-*` ids route through a user-supplied `baseUrl` + free-
 * form model id. The suffix selects the wire protocol:
 *   - `custom-openai`    → `openai-completions` (`/v1/chat/completions`,
 *     the ubiquitous "OpenAI-compatible" shape — OpenRouter, DeepSeek,
 *     Ollama, vLLM, llama.cpp, etc.)
 *   - `custom-anthropic` → `anthropic-messages` (`/v1/messages`)
 *   - `custom-responses` → `openai-responses` (`/v1/responses`, the newer
 *     OpenAI shape — some gateways use this instead of completions)
 *
 * Keys are bucketed per id so switching between a builtin and a custom
 * flavor doesn't clobber the other's key.
 */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'custom-openai' | 'custom-anthropic' | 'custom-responses'

export const KNOWN_PROVIDERS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'custom-openai',
  'custom-anthropic',
  'custom-responses',
] as const

export function isCustomProvider(id: ProviderId): boolean {
  return id.startsWith('custom-')
}

/** Path to the on-disk secrets file. Lazy-computed because `app.getPath`
 * isn't valid before `app.whenReady()`. */
function secretsFile(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function tempFile(target: string): string {
  return target + '.tmp'
}

/**
 * Whether persistent encrypted storage is available. Renderer-facing flows
 * should surface this so the user understands why "Save API key" is disabled.
 * Always true on macOS/Windows; depends on secret-service on Linux.
 */
export function isSecretsEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

type SecretsFile = Record<string, string>

async function readFileOrEmpty(): Promise<SecretsFile> {
  const file = secretsFile()
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as SecretsFile
  } catch {
    // Corrupt file — treat as empty. Callers that write new keys will
    // overwrite this atomically, so a one-off corruption doesn't block us.
  }
  return {}
}

async function writeAtomic(data: SecretsFile): Promise<void> {
  const file = secretsFile()
  const tmp = tempFile(file)
  // mode 0o600 — owner read/write only. The values are already
  // safeStorage-encrypted with a per-user key (Keychain / DPAPI /
  // secret-service), so cross-user reads of the blob can't be decrypted,
  // but the JSON keys (provider names) are plaintext and would otherwise
  // leak which AI services the user has configured. Default umask on
  // Linux yields 0644 — set explicitly to keep the file user-private.
  // No-op on Windows (mode is ignored; ACLs from the userData dir apply).
  // `rename` preserves the source file's mode, so this carries over.
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

// Serialize setSecret/clearSecret/wipeSecrets so the read-modify-write
// cycle isn't interleaved across concurrent callers. Reads (getSecret /
// listConfiguredProviders) stay outside — at worst they see a stale
// snapshot, never a corrupted one (writes are atomic via rename).
const { enqueue: enqueueWrite } = createSerialQueue()

/**
 * Return the decrypted API key for `provider`, or undefined if none is
 * stored / encryption is unavailable / the stored blob can't be decrypted.
 */
export async function getSecret(provider: ProviderId): Promise<string | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const data = await readFileOrEmpty()
  const blob = data[provider]
  if (!blob) return undefined
  try {
    const buf = Buffer.from(blob, 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    // Keychain re-keyed, user profile moved, file corrupt. Drop it so the
    // settings UI shows "not set" instead of looking stuck. Route the
    // self-repair write through the queue so it can't race a concurrent
    // setSecret on a different provider — that race would re-read the
    // map without the deletion and resurrect a key we just declared
    // unreadable.
    await setSecret(provider, '').catch(() => {})
    return undefined
  }
}

/**
 * Persist `key` for `provider`. Throws if safeStorage is unavailable — never
 * writes plaintext. Pass an empty string to clear the entry (same effect as
 * `clearSecret`).
 *
 * Concurrent calls are serialized through `writeQueue` so a second
 * setSecret arriving mid-flight can't read the pre-write map and
 * clobber the first call's contribution.
 */
export function setSecret(provider: ProviderId, key: string): Promise<void> {
  return enqueueWrite(() => doSetSecret(provider, key))
}

async function doSetSecret(provider: ProviderId, key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain not available — cannot store API key securely on this system')
  }
  const data = await readFileOrEmpty()
  if (key === '') {
    delete data[provider]
  } else {
    data[provider] = safeStorage.encryptString(key).toString('base64')
  }
  await writeAtomic(data)
}

export async function clearSecret(provider: ProviderId): Promise<void> {
  await setSecret(provider, '')
}

/**
 * List which providers currently have a stored key. Does NOT decrypt — just
 * checks presence. Used by the settings UI to render the "✓ configured /
 * not set" state without popping a Keychain prompt for every provider.
 */
export async function listConfiguredProviders(): Promise<Record<ProviderId, boolean>> {
  const data = await readFileOrEmpty()
  const out = {} as Record<ProviderId, boolean>
  for (const p of KNOWN_PROVIDERS) {
    out[p] = typeof data[p] === 'string' && data[p].length > 0
  }
  return out
}

/**
 * Delete the entire secrets file. Used on "Reset all secrets" or during
 * uninstall-style flows. Idempotent.
 *
 * Chained through the write queue so an in-flight setSecret can't
 * `rename` a fresh file into place after we've unlinked — that ordering
 * would resurrect a key we just declared deleted.
 */
export function wipeSecrets(): Promise<void> {
  return enqueueWrite(async () => {
    const file = secretsFile()
    if (existsSync(file)) await unlink(file).catch(() => {})
  })
}
