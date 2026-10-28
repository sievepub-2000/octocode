/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = path.resolve(extensionRoot, '../..');
const rootRequire = createRequire(path.join(desktopRoot, 'package.json'));
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'));
const outputRoot = process.env.OCTOCODE_SECURITY_TEST_OUTPUT;
assert.ok(outputRoot, 'Set OCTOCODE_SECURITY_TEST_OUTPUT to an owned test output directory');
if (process.platform === 'win32') assert.ok(path.resolve(outputRoot).toLowerCase().startsWith('e:\\program files\\octocode\\test\\'));
await mkdir(outputRoot, { recursive: true });

// Official reproducers: GHSA-vfgh-jcmw-g37q and GHSA-gfr2-rv44-r23c.
test('all three scoped markdown-it consumers bound the upstream pathological inputs', { timeout: 20000 }, async () => {
	const consumers = [
		['preview', extensionRequire],
		['extension-editing', createRequire(path.join(desktopRoot, 'extensions/extension-editing/package.json'))],
		['vsce', createRequire(path.join(desktopRoot, 'build/node_modules/@vscode/vsce/package.json'))],
	];
	for (const [name, require] of consumers) {
		const worker = new Worker(`
			const { parentPort, workerData } = require('node:worker_threads');
			const MarkdownIt = require(workerData);
			const md = new MarkdownIt({ html: true });
			const inputs = ['<!--', '<?x', '<!A', '<![CDATA['].map(opener => 'x ' + opener.repeat(64000));
			inputs.push('[a]: /u "' + 'x\\n'.repeat(200000), '[' + 'a\\n'.repeat(20000));
			const times = inputs.map(input => { const start = performance.now(); md.render(input); return performance.now() - start; });
			parentPort.postMessage(times);
		`, { eval: true, workerData: require.resolve('markdown-it') });
		try {
			const times = await new Promise((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error(`${name}: upstream DoS input exceeded 5 seconds`)), 5000);
				worker.once('message', value => { clearTimeout(deadline); resolve(value); });
				worker.once('error', error => { clearTimeout(deadline); reject(error); });
			});
			console.log(name, 'upstream PoC milliseconds:', times.map(ms => Math.round(ms)));
		} finally { await worker.terminate(); }
	}
});

test('real notebook preview and upstream DOMPurify attack boundaries remain safe', { timeout: 30000 }, async () => {
	const { chromium } = rootRequire('@playwright/test');
	const context = await chromium.launchPersistentContext(path.join(outputRoot, 'browser-profile'), {
		channel: process.env.OCTOCODE_SECURITY_BROWSER_CHANNEL || 'msedge', headless: true,
	});
	const assets = new Map([
		['/', { type: 'text/html', body: '<!doctype html><html><head><style id="_defaultStyles"></style></head><body></body></html>' }],
		['/renderer.js', { type: 'text/javascript', body: await readFile(path.join(extensionRoot, 'notebook-out/index.js')) }],
		['/purify.js', { type: 'text/javascript', body: await readFile(path.join(extensionRoot, 'node_modules/dompurify/dist/purify.js')) }],
	]);
	const server = createServer((request, response) => {
		const asset = assets.get(request.url);
		response.writeHead(asset ? 200 : 404, { 'Content-Type': asset?.type || 'text/plain' });
		response.end(asset?.body || 'not found');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const page = await context.newPage();
		const origin = `http://127.0.0.1:${server.address().port}`;
		const dialogs = [];
		const errors = [];
		page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
		page.on('pageerror', error => errors.push(error.message));
		await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
		await page.goto(origin);
		await page.addScriptTag({ url: origin + '/purify.js' });
		const result = await page.evaluate(async () => {
			const { activate } = await import('/renderer.js');
			const renderer = activate({ workspace: { isTrusted: false } });
			window.previewXss = 0;
			const target = document.createElement('div');
			document.body.appendChild(target);
			renderer.renderOutputItem({ mime: 'text/markdown', text: () => '## Safe preview\n\n[Safe link](https://example.com)\n\n<img src="/missing" onerror="window.previewXss=1"><script>window.previewXss=1</script><svg><a><animate attributeName="href" values="x;javascript:alert(1)"/></a></svg>' }, target);
			const preview = target.shadowRoot.getElementById('preview');
			const previewResult = { heading: preview.querySelector('h2')?.textContent,
				link: preview.querySelector('a')?.getAttribute('href'),
				unsafe: preview.querySelectorAll('script,[onerror],animate,[href^="javascript:"]').length };
			const start = performance.now();
			renderer.renderOutputItem({ mime: 'text/markdown', text: () => '[a]: /u "' + 'x\n'.repeat(100000) }, target);
			const previewPocMs = performance.now() - start;
			renderer.renderOutputItem({ mime: 'text/markdown', text: () => '## Safe preview\n\n[Safe link](https://example.com)' }, target);
			// GHSA-cg2g-xh64-v4q7: split expression inside an attached shadow root.
			const host = document.createElement('div');
			const shadow = host.attachShadow({ mode: 'open' });
			shadow.append(document.createTextNode('$'), document.createElement('object'), document.createTextNode('{alert(document.domain)}'));
			window.DOMPurify.sanitize(host, { IN_PLACE: true, SAFE_FOR_TEMPLATES: true });
			shadow.normalize();
			const shadowExpressionSurvived = shadow.textContent.includes('${');
			// GHSA-mrv2-3pqr-j5jr: detach a parent or later sibling from a sanitizing hook.
			const detachedHandlers = [];
			for (const mode of ['self', 'parent', 'nextSibling']) {
				const purify = window.DOMPurify(window);
				const root = document.createElement('div');
				root.innerHTML = '<figure><img class="bad" src="/missing"><img id="evil" src="/missing" onerror="alert(1)"></figure><p>ok</p>';
				const evil = root.querySelector('#evil');
				purify.addHook('afterSanitizeAttributes', node => {
					if (node.getAttribute?.('class') === 'bad') {
						if (mode === 'self') node.remove();
						if (mode === 'parent') node.parentNode.remove();
						if (mode === 'nextSibling') node.nextElementSibling.remove();
					}
				});
				purify.sanitize(root, { IN_PLACE: true });
				detachedHandlers.push(evil.getAttribute('onerror'));
			}
			// GHSA-c6gr-qvv4-5v3f: XHTML case-preserving SMIL attribute name.
			const xhtml = window.DOMPurify.sanitize('<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="x;javascript:alert(1)"/></a></svg>', {
				PARSER_MEDIA_TYPE: 'application/xhtml+xml', ALLOWED_TAGS: ['svg', 'a', 'animate'], ALLOWED_ATTR: ['attributeName', 'values'],
			});
			return { previewResult, previewPocMs, shadowExpressionSurvived, detachedHandlers,
				xhtmlHrefAnimationSurvived: /attributeName="href"/i.test(String(xhtml)), dompurify: window.DOMPurify.version };
		});
		await page.waitForTimeout(150);
		assert.deepEqual(result.previewResult, { heading: 'Safe preview', link: 'https://example.com', unsafe: 0 });
		assert.ok(result.previewPocMs < 5000, 'Actual notebook renderer must bound the upstream reference-definition PoC');
		assert.equal(result.shadowExpressionSurvived, false);
		assert.deepEqual(result.detachedHandlers, [null, null, null]);
		assert.equal(result.xhtmlHrefAnimationSurvived, false);
		assert.equal(await page.evaluate(() => window.previewXss), 0);
		assert.deepEqual(dialogs, []);
		assert.deepEqual(errors, []);
		await page.screenshot({ path: path.join(outputRoot, 'notebook-preview.png'), fullPage: true });
		await writeFile(path.join(outputRoot, 'verification.json'), JSON.stringify(result, null, 2));
		console.log('Actual notebook and DOMPurify PoCs:', result);
	} finally {
		await context.close();
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
