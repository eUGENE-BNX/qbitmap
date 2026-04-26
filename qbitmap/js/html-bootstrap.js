/**
 * Page bootstrap previously inlined in index.html. Extracted so that the
 * Content-Security-Policy script-src directive can drop 'unsafe-inline'.
 *
 * Keep this file tiny and side-effect only — it is imported first by
 * main.js and needs to run before anything else touches window.gtag.
 */

// Google Analytics 4 tag bootstrap. The external gtag.js script is loaded
// via <script async> in index.html; it looks for window.dataLayer and
// replaces the push impl with the real handler when it arrives. Events
// pushed before then queue harmlessly. Pageviews are dispatched manually
// from js/analytics.js, so send_page_view is disabled here.
window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
gtag('config', 'G-5Y929W13D6', { send_page_view: false });
