/**
 * Analytics consent banner.
 *
 * Until the user opts in, Google Tag Manager isn't loaded at all and
 * window.gtag is a no-op, so no analytics beacon leaves the browser and
 * no third-party script runs on the origin. Stored choice is remembered
 * across sessions.
 */

const CONSENT_KEY = 'qbitmap_analytics_consent';
const GA_ID = 'G-5Y929W13D6';

function readChoice() {
  try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
}

function writeChoice(value) {
  try { localStorage.setItem(CONSENT_KEY, value); } catch {}
}

function loadGtm() {
  if (window.__qbitmapGtmLoaded) return;
  window.__qbitmapGtmLoaded = true;
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

function showBanner() {
  if (document.getElementById('qb-consent-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'qb-consent-banner';
  banner.className = 'qb-consent-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-labelledby', 'qb-consent-text');
  banner.innerHTML =
    '<p id="qb-consent-text" class="qb-consent-text">' +
      'Site kullanımını anlamak için anonim analiz çerezleri kullanıyoruz. ' +
      'İsterseniz reddedebilirsiniz — uygulamanın diğer özellikleri değişmez.' +
    '</p>' +
    '<div class="qb-consent-actions">' +
      '<button type="button" class="qb-consent-reject">Reddet</button>' +
      '<button type="button" class="qb-consent-accept">Kabul et</button>' +
    '</div>';
  document.body.appendChild(banner);

  const dismiss = () => banner.remove();
  banner.querySelector('.qb-consent-accept').addEventListener('click', () => {
    writeChoice('granted');
    loadGtm();
    dismiss();
  });
  banner.querySelector('.qb-consent-reject').addEventListener('click', () => {
    writeChoice('denied');
    dismiss();
  });
}

/**
 * Decides whether to load GTM immediately, suppress it, or prompt the
 * user. Safe to call multiple times — guards on state.
 */
export function initAnalyticsConsent() {
  const choice = readChoice();
  if (choice === 'granted') { loadGtm(); return; }
  if (choice === 'denied') return;
  // Defer the prompt so it doesn't compete with the first paint.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(showBanner, 1500);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(showBanner, 1500), { once: true });
  }
}
