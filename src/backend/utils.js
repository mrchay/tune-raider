/**
 * utils.js — Shared utilities.
 */

/**
 * Generate a filesystem-safe filename from arbitrary text.
 * Strips all non-ASCII characters, collapses whitespace, removes illegal chars.
 */
function safeFilename(name) {
  return (name || 'unknown')
    // Replace common Unicode chars with ASCII equivalents
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics (é→e, ö→o, etc.)
    // Replace remaining non-ASCII with underscore
    .replace(/[^\x20-\x7E]/g, '_')
    // Remove filesystem-illegal and unwanted characters
    .replace(/[<>:"/\\|?*!#$&'.;]/g, '_')
    // Collapse multiple underscores/spaces
    .replace(/[_\s]+/g, ' ')
    .trim()
    .slice(0, 200);
}

module.exports = { safeFilename };
