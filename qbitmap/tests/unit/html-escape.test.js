// Regression guard for the admin rich-text feature. These cases encode
// the exact allowlist promise: <b>/<i>/<u> survive, *everything* else
// becomes literal text. Break any of these and a future tweak could
// silently re-open an XSS hole in the message popup AI description.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, escapeHtmlAllowFormat } from '../../js/html-escape.js';

// ------- escapeHtml: baseline -------

test('escapeHtml: empty and nullish inputs return empty string', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: encodes every dangerous char', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('escapeHtml: plain text passes through unchanged', () => {
  assert.equal(escapeHtml('Merhaba dünya 123'), 'Merhaba dünya 123');
});

// ------- escapeHtmlAllowFormat: the allowlist -------

test('allowFormat: plain text unchanged (no tags → no swaps)', () => {
  assert.equal(escapeHtmlAllowFormat('Bugün hava güzel'), 'Bugün hava güzel');
});

test('allowFormat: real <b>, <i>, <u> pass through as live HTML', () => {
  assert.equal(
    escapeHtmlAllowFormat('Burada <b>ÖNEMLİ</b> <i>italik</i> <u>altı çizili</u> nokta'),
    'Burada <b>ÖNEMLİ</b> <i>italik</i> <u>altı çizili</u> nokta'
  );
});

test('allowFormat: nested and adjacent allowlist tags survive', () => {
  assert.equal(
    escapeHtmlAllowFormat('<b><i>iç içe</i></b> ve <u><b>bold-underline</b></u>'),
    '<b><i>iç içe</i></b> ve <u><b>bold-underline</b></u>'
  );
});

// ------- XSS: the whole point of this file -------

test('XSS: <script> payload cannot execute — rendered literal', () => {
  const out = escapeHtmlAllowFormat('<script>alert(1)</script>');
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!out.includes('<script'), 'live <script tag must not reappear');
});

test('XSS: <b> with attribute becomes literal — event handler cannot fire', () => {
  const out = escapeHtmlAllowFormat('<b onclick="alert(1)">x</b>');
  // <b onclick=...> is escaped first, then doesn't match the tight /&lt;b&gt;/
  // pattern (space after `b`), so attribute form stays escaped.
  assert.ok(out.startsWith('&lt;b onclick='), `attribute form must stay escaped, got: ${out}`);
  assert.ok(!out.includes('<b onclick'), 'no live attribute <b> may appear');
  // The literal ">x</b>" fragment: closing /b does get re-enabled because
  // &lt;/b&gt; IS in the allowlist — that's fine, it's a dangling tag with
  // no matching opener, the browser tolerates it and no attributes survive.
});

test('XSS: <img onerror> payload cannot execute', () => {
  const out = escapeHtmlAllowFormat('<img src=x onerror="alert(1)">');
  assert.ok(!out.includes('<img'), 'no live <img> tag may appear');
  assert.ok(out.includes('&lt;img'), 'img tag must stay escaped');
});

test('XSS: javascript: pseudo-protocol in href — no <a> allowlisted anyway', () => {
  const out = escapeHtmlAllowFormat('<a href="javascript:alert(1)">click</a>');
  // The literal text "href=" may remain (it's harmless prose at this
  // point); the point is the tag itself must stay escaped so no live
  // anchor element is constructed and no pseudo-protocol URL fires.
  assert.ok(!out.includes('<a '), 'no live <a> tag may appear');
  assert.ok(out.includes('&lt;a '), 'anchor tag must stay escaped');
  assert.ok(out.includes('&quot;'), 'quotes around href value must stay escaped');
});

test('XSS: tag-letter-plus-space fools no one (e.g. "<b >")', () => {
  // Regex demands `&lt;b&gt;` exactly; `<b >` escapes to `&lt;b &gt;`
  // which has a space between b and &gt; and therefore cannot match.
  const out = escapeHtmlAllowFormat('<b >hi</b >');
  assert.ok(!out.includes('<b >'), 'spaced-variant must not pass through');
});

test('XSS: uppercase <B> must not round-trip (allowlist is lowercase only)', () => {
  // Prevents case-insensitive browser parsing from giving attackers a
  // second bite. Admins type lowercase; uppercase gets escaped.
  const out = escapeHtmlAllowFormat('<B>yell</B>');
  assert.ok(!out.includes('<B>'), 'uppercase <B> must not pass through');
  assert.ok(out.includes('&lt;B&gt;'), 'uppercase <B> stays escaped');
});

test('XSS: quotes and ampersands in user text are still neutralised', () => {
  const out = escapeHtmlAllowFormat(`A&B "quoted" 'apos'`);
  assert.equal(out, 'A&amp;B &quot;quoted&quot; &#39;apos&#39;');
});

test('XSS: mixing allowed tag and <script> — only the allowed tag survives', () => {
  const out = escapeHtmlAllowFormat('<b>safe</b><script>evil()</script>');
  assert.equal(out, '<b>safe</b>&lt;script&gt;evil()&lt;/script&gt;');
});
