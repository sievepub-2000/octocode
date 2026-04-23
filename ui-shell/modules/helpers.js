/* ════════════════════════════════════════════════════════════
   Octocode Workbench — modules/helpers.js (P3 extraction)
   Pure utility functions extracted from ui-shell/app.js.
   Safe to import as ES module or attach to window for IIFE
   compatibility. DO NOT add DOM-mutation logic here.
   ════════════════════════════════════════════════════════════ */

const BUILT_IN_LOCALES = ['en-US', 'ja-JP', 'ko-KR', 'zh-CN'];

/**
 * Build request headers with X-Auth-Token injected when present.
 * @param {string} token current auth token (may be empty)
 * @param {object} [extra] additional header key-value pairs
 * @returns {Record<string, string>}
 */
export function authHeaders(token, extra = {}) {
  const headers = { ...extra };
  if (token) headers['X-Auth-Token'] = token;
  return headers;
}

/**
 * Escape a string for safe HTML insertion.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(value || '')));
  return div.innerHTML;
}

/**
 * Extract the base name of a file-system path (Windows/POSIX agnostic).
 * @param {string} path
 * @returns {string}
 */
export function pathBaseName(path) {
  if (!path) return '-';
  const normalized = String(path).replace(/\\/g, '/').replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : normalized;
}

/**
 * Normalize a permission string from varied casings to the canonical
 * kebab-case form used across the WebUI.
 * @param {unknown} value
 * @returns {'read-only'|'workspace-write'|'danger-full-access'}
 */
export function normalizePermissionValue(value) {
  switch (String(value || '')) {
    case 'ReadOnly':
    case 'readOnly':
    case 'read-only':
      return 'read-only';
    case 'DangerFullAccess':
    case 'dangerFullAccess':
    case 'danger-full-access':
      return 'danger-full-access';
    case 'WorkspaceWrite':
    case 'workspaceWrite':
    case 'workspace-write':
      return 'workspace-write';
    default:
      return 'workspace-write';
  }
}

/**
 * Resolve a user-provided locale to one of the built-in locales
 * supported by the WebUI.
 * @param {string|null|undefined} locale
 * @returns {string}
 */
export function resolveSupportedLocale(locale) {
  if (!locale) return 'zh-CN';
  if (BUILT_IN_LOCALES.includes(locale)) return locale;
  if (locale.startsWith('zh')) return 'zh-CN';
  if (locale.startsWith('ja')) return 'ja-JP';
  if (locale.startsWith('ko')) return 'ko-KR';
  return 'en-US';
}

/**
 * Format a unix millisecond timestamp or Date-coercible value as HH:MM:SS
 * using the given locale. Returns empty string on failure.
 * @param {number|string|Date|null|undefined} timestamp
 * @param {string} locale
 * @returns {string}
 */
export function formatTimestamp(timestamp, locale = 'zh-CN') {
  if (!timestamp) return '';
  try {
    const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

/**
 * Clamp a number into a closed range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a byte count using SI-adjacent units (KB, MB, GB...).
 * @param {number} bytes
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const scaled = n / Math.pow(1024, i);
  const fixed = i === 0 ? String(Math.round(scaled)) : scaled.toFixed(decimals);
  return `${fixed} ${units[i]}`;
}

/**
 * Format a non-negative integer with thousand separators using the
 * current locale. Invalid inputs fall back to the string '0'.
 * @param {number|string} value
 * @param {string} [locale='en-US']
 * @returns {string}
 */
export function formatNumber(value, locale = 'en-US') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  try {
    return n.toLocaleString(locale);
  } catch (_) {
    return String(Math.trunc(n));
  }
}

export const BUILT_IN_LOCALES_LIST = BUILT_IN_LOCALES;
