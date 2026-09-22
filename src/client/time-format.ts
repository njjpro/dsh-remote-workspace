/**
 * Timestamp formatting for the remote workspace rows: a local calendar date plus a
 * zero-padded clock, e.g. "2026-08-19 10:35".
 *
 * Small and self-contained on purpose. The official plugin carries the same pair in
 * its `pair-api.ts` alongside the pairing HTTP client, which this package must not
 * depend on; copying two pure functions is cheaper than importing the whole client.
 */

/**
 * Zero-padded local clock, e.g. "10:35".
 * @param epochMs - epoch milliseconds.
 * @returns the formatted time.
 */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Local calendar date plus clock for last-seen timestamps.
 * @param epochMs - epoch milliseconds.
 * @returns the formatted timestamp, e.g. "2026-08-19 10:35".
 */
export function formatLastSeen(epochMs: number): string {
  const date = new Date(epochMs)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day} ${formatClock(epochMs)}`
}
