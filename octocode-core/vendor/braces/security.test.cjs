const assert = require('node:assert/strict');
const { test } = require('node:test');
const braces = require('./');

test('ordinary braces, ranges and escapes retain upstream behavior', () => {
  assert.deepEqual(braces.expand('src/{api,core}/**/*.{ts,tsx}'), [
    'src/api/**/*.ts', 'src/api/**/*.tsx', 'src/core/**/*.ts', 'src/core/**/*.tsx'
  ]);
  assert.deepEqual(braces.expand('file{01..03}.ts'), ['file01.ts', 'file02.ts', 'file03.ts']);
  assert.equal(braces.compile('src/{api,core}'), 'src/(api|core)');
  assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
  assert.deepEqual(braces.expand('a\\{b,c\\}'), ['a{b,c}']);
});

test('all string entry points reject deep balanced and unbalanced patterns safely', () => {
  for (const pattern of [
    '{'.repeat(4998) + 'a,b' + '}'.repeat(4998),
    '{'.repeat(9999),
    '('.repeat(4998) + 'a' + ')'.repeat(4998),
    '{('.repeat(2498) + 'a,b' + ')}'.repeat(2498)
  ]) {
    for (const operation of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(pattern), { name: 'SyntaxError', message: /nesting exceeds 128 levels/ });
    }
  }
  assert.doesNotThrow(() => braces.compile('{'.repeat(64) + 'a,b' + '}'.repeat(64)));
});

test('caller supplied deep ASTs cannot bypass walker guards', () => {
  const ast = { type: 'root', nodes: [] };
  let parent = ast;
  for (let index = 0; index < 15000; index++) {
    const node = { type: 'brace', nodes: [], parent, commas: 0, ranges: 0 };
    parent.nodes.push(node);
    parent = node;
  }
  parent.nodes.push({ type: 'text', value: 'x' });
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(ast), { name: 'SyntaxError', message: /nesting exceeds 128 levels/ });
  }
});
