// calculator-test.js - Automated tests for OctoCode Calculator
// Run with: node calculator-test.js

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passed++; }
  catch(e) { console.log(`  FAIL: ${name} - ${e.message}`); failed++; }
}
function assert(val, msg) { if (!val) throw new Error(msg || 'assertion failed'); }

console.log('=== OctoCode Calculator Logic Tests ===\n');

// Simulate calculator state
let current, previous, operator, resetNext;
function clearAll() { current = '0'; previous = ''; operator = ''; resetNext = false; }
function appendDigit(d) {
  if (resetNext) { current = ''; resetNext = false; }
  if (current === '0' && d !== '.') current = '';
  current += d;
}
function appendDot() {
  if (resetNext) { current = '0'; resetNext = false; }
  if (!current.includes('.')) current += '.';
}
function setOp(op) {
  if (operator && !resetNext) calculate();
  previous = current; operator = op; resetNext = true;
}
function calculate() {
  if (!operator || !previous) return;
  const a = parseFloat(previous), b = parseFloat(current);
  let r;
  switch(operator) {
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '/': r = b === 0 ? 'Error' : a / b; break;
  }
  current = typeof r === 'number' ? parseFloat(r.toFixed(10)).toString() : r;
  operator = ''; previous = ''; resetNext = true;
}
function toggleSign() { current = (parseFloat(current) * -1).toString(); }
function percentage() { current = (parseFloat(current) / 100).toString(); }

// Tests
clearAll();
test('Initial state is 0', () => assert(current === '0'));

clearAll(); appendDigit('5'); appendDigit('3');
test('Digit input: 53', () => assert(current === '53'));

clearAll(); appendDigit('2'); setOp('+'); appendDigit('3'); calculate();
test('Addition: 2 + 3 = 5', () => assert(current === '5'));

clearAll(); appendDigit('9'); setOp('-'); appendDigit('4'); calculate();
test('Subtraction: 9 - 4 = 5', () => assert(current === '5'));

clearAll(); appendDigit('6'); setOp('*'); appendDigit('7'); calculate();
test('Multiplication: 6 * 7 = 42', () => assert(current === '42'));

clearAll(); appendDigit('1'); appendDigit('5'); setOp('/'); appendDigit('3'); calculate();
test('Division: 15 / 3 = 5', () => assert(current === '5'));

clearAll(); appendDigit('5'); setOp('/'); appendDigit('0'); calculate();
test('Division by zero = Error', () => assert(current === 'Error'));

clearAll(); appendDigit('1'); appendDigit('0'); setOp('+'); appendDigit('2'); appendDigit('0'); calculate(); setOp('*'); appendDigit('2'); calculate();
test('Chained: (10+20)*2 = 60', () => assert(current === '60'));

clearAll(); appendDigit('5'); appendDigit('0'); toggleSign();
test('Toggle sign: 50 -> -50', () => assert(current === '-50'));

clearAll(); appendDigit('2'); appendDigit('5'); percentage();
test('Percentage: 25 -> 0.25', () => assert(current === '0.25'));

clearAll(); appendDigit('3'); appendDot(); appendDigit('1'); appendDigit('4');
test('Decimal input: 3.14', () => assert(current === '3.14'));

clearAll(); appendDigit('1'); appendDot(); appendDot();
test('Double dot ignored: 1.', () => assert(current === '1.'));

console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);
process.exitCode = failed > 0 ? 1 : 0;
