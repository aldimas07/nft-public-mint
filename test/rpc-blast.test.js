const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

function server(delayMs, payload) {
  return new Promise((resolve) => {
    const instance = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }, delayMs);
    });
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function endpoint(instance, label) {
  return { url: `http://127.0.0.1:${instance.address().port}`, label };
}

function close(instance) {
  return new Promise((resolve) => instance.close(resolve));
}

test('blastToAll exposes first acceptance before slow endpoints finish', async () => {
  const { blastToAll, prepareBlast } = require('../dist/rpc-blast.js');
  const acceptedHash = '0x' + '1'.repeat(64);
  const fast = await server(5, { result: acceptedHash });
  const slow = await server(120, { error: { message: 'late rejection' } });
  try {
    const start = performance.now();
    const dispatch = blastToAll(prepareBlast('0x' + '01'.repeat(97)), [
      endpoint(slow, 'slow'),
      endpoint(fast, 'fast'),
    ]);
    const accepted = await dispatch.firstAcceptedPromise;
    const acceptedAt = performance.now() - start;
    const all = await dispatch.responsePromise;
    const completedAt = performance.now() - start;

    assert.equal(accepted.txHash, acceptedHash);
    assert.equal(all.length, 2);
    assert.ok(acceptedAt < completedAt - 50, `${acceptedAt} should precede ${completedAt}`);
  } finally {
    await Promise.all([fast, slow].map(close));
  }
});
