const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mintValue,
  encodeMintPublic,
  classifyMintedOut,
  SEADROP_ADDRESS,
} = require('../dist/seadrop-public.js');

test('mintValue without a cap sends exactly the current price × qty', () => {
  assert.equal(mintValue(1000n, 0n, 3), 3000n);
});

test('mintValue over-provisions when a cap above the current price is set', () => {
  assert.equal(mintValue(1000n, 5000n, 3), 15000n);
});

test('mintValue never sends below the current price (cap below price is ignored)', () => {
  assert.equal(mintValue(5000n, 1000n, 3), 15000n);
});

test('classifyMintedOut: supply views exhausted', () => {
  assert.equal(classifyMintedOut(100n, 100n, null), true);
  assert.equal(classifyMintedOut(101n, 100n, null), true);
  assert.equal(classifyMintedOut(99n, 100n, null), false);
});

test('classifyMintedOut: unknown views fall back to the dry-run selector', () => {
  assert.equal(classifyMintedOut(null, null, '0x4ef4aa66'), true);
  assert.equal(classifyMintedOut(50n, null, '0x4ef4aa66'), true);
  assert.equal(classifyMintedOut(null, null, '0xef074e54'), false); // other revert
});

test('encodeMintPublic is deterministic and identical regardless of price', () => {
  const a = encodeMintPublic('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 2);
  const b = encodeMintPublic('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 2);
  assert.equal(a, b);
  assert.ok(a.startsWith('0x'));
});
