const test = require('node:test');
const assert = require('node:assert/strict');

test('waitForMintTime runs scheduled hooks in order before release', async () => {
  const { waitForMintTime } = require('../dist/timer.js');
  const calls = [];
  const target = new Date(Date.now() + 80);
  const result = await waitForMintTime(target, {
    silent: true,
    spinWindowMs: 1,
    hooks: [
      { beforeMs: 55, run: async () => calls.push('early') },
      { beforeMs: 20, run: async () => calls.push('late') },
    ],
  });

  assert.deepEqual(calls, ['early', 'late']);
  assert.ok(result.releasedAtMs >= target.getTime() - 2);
  assert.ok(Math.abs(result.errorMs) < 30);
});

test('waitForMintTime executes overdue hooks before immediate release', async () => {
  const { waitForMintTime } = require('../dist/timer.js');
  let ran = false;
  await waitForMintTime(new Date(Date.now() - 1), {
    silent: true,
    hooks: [{ beforeMs: 10, run: async () => { ran = true; } }],
  });
  assert.equal(ran, true);
});

test('waitForMintTime polls every pollEveryMs and aborts when onPoll throws', async () => {
  const { waitForMintTime } = require('../dist/timer.js');
  const target = new Date(Date.now() + 500);
  let pollCount = 0;
  let aborted = false;
  try {
    await waitForMintTime(target, {
      silent: true,
      pollEveryMs: 60,
      onPoll: async () => {
        pollCount += 1;
        if (pollCount === 3) throw new Error('MINTED OUT');
      },
    });
  } catch (err) {
    aborted = err.message === 'MINTED OUT';
  }
  assert.equal(aborted, true);
  assert.ok(pollCount >= 3, `expected >= 3 polls, got ${pollCount}`);
});

test('waitForMintTime polling keeps T-0 precision and stops before release', async () => {
  const { waitForMintTime } = require('../dist/timer.js');
  const target = new Date(Date.now() + 500);
  const pollTimes = [];
  const result = await waitForMintTime(target, {
    silent: true,
    pollEveryMs: 40,
    onPoll: async () => { pollTimes.push(Date.now()); },
  });
  assert.ok(Math.abs(result.errorMs) < 30, `errorMs ${result.errorMs} outside tolerance`);
  const lastPoll = pollTimes[pollTimes.length - 1] ?? 0;
  assert.ok(target.getTime() - lastPoll > 100, `last poll ${target.getTime() - lastPoll}ms before target — too close`);
});
