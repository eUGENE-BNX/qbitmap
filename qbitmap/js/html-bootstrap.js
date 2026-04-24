/**
 * Page bootstrap previously inlined in index.html. Extracted so that the
 * Content-Security-Policy script-src directive can drop 'unsafe-inline'.
 *
 * Keep this file tiny and side-effect only — it is imported first by
 * main.js and needs to run before anything else touches window.gtag or
 * the Plyr stylesheet.
 */

// Google Analytics 4 tag bootstrap. gtag.js is NOT loaded statically any
// more — loading defers to js/consent-banner.js, which only injects the
// <script> tag after the user accepts. We set up window.gtag + dataLayer
// eagerly so js/analytics.js can dispatch events unconditionally: if the
// user hasn't opted in, events just queue in dataLayer and are dropped.
window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
gtag('config', 'G-5Y929W13D6', { send_page_view: false });

// Kick off the consent banner once we're past the critical path.
import('./consent-banner.js')
  .then((m) => m.initAnalyticsConsent?.())
  .catch(() => {});

// Plyr CSS is injected with media="print" so it doesn't block first paint.
// Now that JS is running, swap to media="all" so the browser applies the
// rules once the stylesheet finishes downloading. Plyr only renders when
// the user opens a video, which happens much later than this bootstrap.
const plyrCss = document.getElementById('plyr-css');
if (plyrCss && plyrCss.media === 'print') {
  plyrCss.media = 'all';
}
