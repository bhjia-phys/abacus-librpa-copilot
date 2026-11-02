/**
 * Machine-specific settings, kept out of version control.
 *
 * The published `cordis.patch.yml` carries no personal paths. Settings that only make sense on
 * one machine — the folder to scan, the database index, the SSH alias of a cluster — live in a
 * git-ignored `local-config.json` beside `package.json` (see `local-config.example.json`).
 *
 * Precedence: a key present in the plugin config (the patch) always wins; the local file only
 * fills keys the patch leaves out. A missing or unreadable file is the same as an empty one, so
 * the plugin still starts — with a blank scan root and no database, as on a fresh machine.
 *
 * The file may also hold a `dev` block (sample-data locations for tests and preview scripts);
 * the host ignores it.
 *
 * @module abacusflow/host/local-config
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `<package>/local-config.json`. */
export const LOCAL_CONFIG_FILE = fileURLToPath(new URL('../../local-config.json', import.meta.url));

/** Plugin settings the local file may supply. */
export const LOCAL_CONFIG_KEYS = Object.freeze([
  'defaultScanRoot',
  'maxDepth',
  'maxTasks',
  'remoteLocalRoot',
  'remoteHost',
  'libraryRoot',
  'libraryAssetCacheDir',
]);

/**
 * @param {string} [file]
 * @returns {object} the parsed object, or `{}` when absent or invalid
 */
export function readLocalConfig(file = LOCAL_CONFIG_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Fill the settings the plugin config leaves out from the local file.
 *
 * @param {object|undefined} raw the row's `config` from cordis.patch.yml
 * @param {object} [local] the local settings (defaults to `readLocalConfig()`)
 * @returns {object} a new object; `raw` is not modified
 */
export function withLocalConfig(raw, local = readLocalConfig()) {
  const merged = raw && typeof raw === 'object' ? { ...raw } : {};
  for (const key of LOCAL_CONFIG_KEYS) {
    if (merged[key] === undefined && local[key] !== undefined) merged[key] = local[key];
  }
  return merged;
}
