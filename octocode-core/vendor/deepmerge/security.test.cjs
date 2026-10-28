const assert = require('node:assert/strict');
const test = require('node:test');

for (const entry of ['./dist/cjs.js', './dist/umd.js']) {
	const merge = require(entry);
	test(entry + ' does not copy target __proto__ through an inherited setter', () => {
		const target = JSON.parse('{"__proto__":{"poisoned":true},"safe":1}');
		const result = merge(target, { other: 2 });
		assert.equal(Object.getPrototypeOf(result), Object.prototype);
		assert.equal(result.poisoned, undefined);
		assert.equal(result.safe, 1);
		assert.equal(result.other, 2);
		assert.equal(Object.prototype.poisoned, undefined);
	});
	test(entry + ' keeps null-prototype sources and nested targets safe', () => {
		const source = JSON.parse('{"__proto__":{"poisoned":true}}');
		const result = merge(Object.create(null), source);
		assert.equal(Object.getPrototypeOf(result), Object.prototype);
		assert.equal(result.poisoned, undefined);
		const nested = merge({ nested: source, items: [source] }, {});
		assert.equal(Object.getPrototypeOf(nested.nested), Object.prototype);
		assert.equal(nested.nested.poisoned, undefined);
		assert.equal(nested.items[0].poisoned, undefined);
	});
	test(entry + ' preserves ordinary merge, symbols, arrays and custom options', () => {
		const symbol = Symbol('key');
		assert.deepEqual(merge({ list: [1], nested: { a: 1 } }, { list: [2], nested: { b: 2 } }), { list: [1, 2], nested: { a: 1, b: 2 } });
		assert.equal(merge({}, { [symbol]: 3 })[symbol], 3);
		assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
		assert.deepEqual(merge([1], [2], { arrayMerge: (_target, source) => source }), [2]);
	});
}
