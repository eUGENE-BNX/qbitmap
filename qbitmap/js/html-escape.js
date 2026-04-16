// Pure HTML-escape helpers. Zero imports so this module can be loaded
// directly by the node:test runner without a window/DOM shim (utils.js
// re-exports these for the rest of the app).

/**
 * Escape HTML to prevent XSS.
 * Safe for text content, attribute values, and inline JS strings.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Alias kept for legacy callers. */
export function sanitize(str) {
  return escapeHtml(str);
}

/**
 * HTML escape with <b>/<i>/<u> allowlist. For admin-editable text where
 * bold/italic/underline vurgusu istenir ama keyfi HTML verilmez.
 *
 * Why this is safe: escape the entire string first, then swap ONLY the
 * exact six strings `&lt;b&gt;`, `&lt;/b&gt;`, `&lt;i&gt;`, `&lt;/i&gt;`,
 * `&lt;u&gt;`, `&lt;/u&gt;` back to real tags. Anything else — attributes,
 * event handlers, nested scripts — has already been escaped and cannot
 * re-emerge because the swap patterns demand the closing `&gt;`
 * immediately after the tag letter.
 */
export function escapeHtmlAllowFormat(str) {
  if (!str) return '';
  return escapeHtml(str)
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;i&gt;/g, '<i>').replace(/&lt;\/i&gt;/g, '</i>')
    .replace(/&lt;u&gt;/g, '<u>').replace(/&lt;\/u&gt;/g, '</u>');
}
