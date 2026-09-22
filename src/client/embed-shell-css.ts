/**
 * The embed-shell layout override (peer GUI inside the device workspace).
 *
 * The embedded shell hides the local chrome and collapses the official
 * app-frame grid down to the chat column. The official frame is a CSS grid
 * whose in-flow children are the side columns plus the center column; which
 * class name carries the right-hand panel varies by cohort line
 * (`_rightbarCol` on the current shell, `_detailsCol` on the classic one), so
 * every known side column is hidden explicitly.
 *
 * Placement is the load-bearing part. Hiding the side columns does NOT move
 * the center column into the flexible track: grid auto-placement walks from
 * the first line, so with a `0 minmax(0,1fr) 0` template the center column
 * lands in the leading 0-width track — a 0 px pane that renders as a blank
 * white surface while the DOM, the iframe and hit-testing all stay healthy.
 * The template is therefore reduced to a single flexible track and the center
 * column is pinned to it, which also keeps the override independent of the
 * center column's class name.
 */

/** Id of the injected style element (single-instance guard). */
export const EMBED_SHELL_STYLE_ID = 'dshRemoteEmbedStyle'

/** Attribute the embed marker sets on the document element. */
export const EMBED_SHELL_ATTR = 'data-dsh-remote-embed'

/**
 * Build the embed-shell style sheet.
 * @returns the CSS text injected into the embedded document.
 */
export function embedShellCss(): string {
  const scope = `html[${EMBED_SHELL_ATTR}='1']`
  return [
    // One flexible track, and the chat column explicitly on it: a multi-track
    // template would hand the flexible track to whichever column happens to
    // come second in flow order.
    `${scope} [class$='_frame']{grid-template-columns:minmax(0,1fr) !important}`,
    `${scope} [class$='_centerCol']{grid-column:1 !important}`,
    // Side columns: the right-hand panel (`_rightbarCol`) and its classic name
    // (`_detailsCol`), plus the sidebar.
    `${scope} [class$='_sidebarCol'],${scope} [class$='_detailsCol'],${scope} [class$='_rightbarCol']{display:none !important}`,
    // No local surfaces either: the host desktop has its own device bar.
    `${scope} [data-dsh-plugin='remote-web-ui']{display:none !important}`,
  ].join('\n')
}
