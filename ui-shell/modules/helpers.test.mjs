// Node smoke tests for ui-shell/modules/helpers.js (P4 validation).
//
// Usage: `node ui-shell/modules/helpers.test.mjs`
//
// Bypasses DOM-dependent APIs (escapeHtml) by stubbing a minimal `document`
// before import. All other helpers are pure and verified end-to-end.

import assert from 'node:assert/strict';

// Minimal DOM stub: escapeHtml uses document.createElement('div') + textContent
// round-trip. The stub mirrors the browser behaviour for ASCII + basic HTML chars.
globalThis.document = {
  createElement() {
    const node = {
      _children: [],
      appendChild(child) {
        this._children.push(child);
        return child;
      },
      get innerHTML() {
        return this._children
          .map((c) => c._text || '')
          .join('')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      },
    };
    return node;
  },
  createTextNode(text) {
    return { _text: String(text) };
  },
};

const helpers = await import('./helpers.js');

// authHeaders
assert.deepEqual(helpers.authHeaders(''), {}, 'no token → empty headers');
assert.deepEqual(helpers.authHeaders('abc'), { 'X-Auth-Token': 'abc' });
assert.deepEqual(helpers.authHeaders('t', { 'Content-Type': 'application/json' }), {
  'Content-Type': 'application/json',
  'X-Auth-Token': 't',
});

// escapeHtml
assert.equal(helpers.escapeHtml('<script>'), '&lt;script&gt;');
assert.equal(helpers.escapeHtml('a & b'), 'a &amp; b');
assert.equal(helpers.escapeHtml(null), '');
assert.equal(helpers.escapeHtml(undefined), '');

// pathBaseName
assert.equal(helpers.pathBaseName('/foo/bar/baz.txt'), 'baz.txt');
assert.equal(helpers.pathBaseName('C:\\Users\\x\\y.md'), 'y.md');
assert.equal(helpers.pathBaseName('/foo/bar/'), 'bar');
assert.equal(helpers.pathBaseName(''), '-');
assert.equal(helpers.pathBaseName(null), '-');

// normalizePermissionValue
assert.equal(helpers.normalizePermissionValue('ReadOnly'), 'read-only');
assert.equal(helpers.normalizePermissionValue('readOnly'), 'read-only');
assert.equal(helpers.normalizePermissionValue('read-only'), 'read-only');
assert.equal(helpers.normalizePermissionValue('DangerFullAccess'), 'danger-full-access');
assert.equal(helpers.normalizePermissionValue('WorkspaceWrite'), 'workspace-write');
assert.equal(helpers.normalizePermissionValue('unknown'), 'workspace-write');
assert.equal(helpers.normalizePermissionValue(''), 'workspace-write');

// resolveSupportedLocale
assert.equal(helpers.resolveSupportedLocale('en-US'), 'en-US');
assert.equal(helpers.resolveSupportedLocale('zh-CN'), 'zh-CN');
assert.equal(helpers.resolveSupportedLocale('zh-TW'), 'zh-CN');
assert.equal(helpers.resolveSupportedLocale('ja'), 'ja-JP');
assert.equal(helpers.resolveSupportedLocale('ko'), 'ko-KR');
assert.equal(helpers.resolveSupportedLocale('de-DE'), 'en-US');
assert.equal(helpers.resolveSupportedLocale(''), 'zh-CN');
assert.equal(helpers.resolveSupportedLocale(null), 'zh-CN');

// formatTimestamp — cannot assert exact string (locale-dependent) but must
// return non-empty for valid input and empty for falsy.
assert.equal(helpers.formatTimestamp(0, 'en-US'), '');
assert.equal(helpers.formatTimestamp(null), '');
const formatted = helpers.formatTimestamp(Date.now(), 'en-US');
assert.ok(typeof formatted === 'string' && formatted.length > 0, 'formatTimestamp produces non-empty string');

// clamp
assert.equal(helpers.clamp(5, 0, 10), 5);
assert.equal(helpers.clamp(-1, 0, 10), 0);
assert.equal(helpers.clamp(99, 0, 10), 10);
assert.equal(helpers.clamp(Number.NaN, 3, 7), 3);

// formatBytes
assert.equal(helpers.formatBytes(0), '0 B');
assert.equal(helpers.formatBytes(-1), '0 B');
assert.equal(helpers.formatBytes(512), '512 B');
assert.equal(helpers.formatBytes(2048), '2.0 KB');
assert.equal(helpers.formatBytes(1024 * 1024), '1.0 MB');
assert.equal(helpers.formatBytes(1024 * 1024 * 1024 * 3), '3.0 GB');
assert.equal(helpers.formatBytes('not-a-number'), '0 B');

// formatNumber
assert.equal(helpers.formatNumber(0), '0');
assert.equal(helpers.formatNumber(1234, 'en-US'), '1,234');
assert.equal(helpers.formatNumber(1000000, 'en-US'), '1,000,000');
assert.equal(helpers.formatNumber('not-a-number'), '0');
assert.equal(helpers.formatNumber(null), '0');

// truncate
assert.equal(helpers.truncate('hello', 10), 'hello');
assert.equal(helpers.truncate('abcdefghij', 5), 'abcd…');
assert.equal(helpers.truncate('abcdefghij', 5, '...'), 'ab...');
assert.equal(helpers.truncate(null, 10), '');
assert.equal(helpers.truncate(undefined, 10), '');
assert.equal(helpers.truncate(12345, 3), '12…');

// parseUrlQuery
assert.deepEqual(helpers.parseUrlQuery(''), {});
assert.deepEqual(helpers.parseUrlQuery(null), {});
assert.deepEqual(helpers.parseUrlQuery('?a=1&b=2'), { a: '1', b: '2' });
assert.deepEqual(helpers.parseUrlQuery('a=1&b=2'), { a: '1', b: '2' });
assert.deepEqual(helpers.parseUrlQuery('a=hello+world'), { a: 'hello world' });
assert.deepEqual(helpers.parseUrlQuery('name=%E5%91%A8%E6%B5%A9'), { name: '周浩' });
assert.deepEqual(helpers.parseUrlQuery('k'), { k: '' });
// duplicate key → last wins
assert.deepEqual(helpers.parseUrlQuery('a=1&a=2'), { a: '2' });

console.log('ui-shell/modules/helpers.js — all smoke tests passed.');
