const assert = require('node:assert/strict');
const sum = require('./sum.cjs');
assert.equal(sum(2, 3), 5);
assert.equal(sum(-1, 1), 0);
console.log('Observed: both sum checks passed.');
