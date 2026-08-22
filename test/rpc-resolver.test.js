const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function server(payload, delayMs = 0) {
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

function url(instance) {
  return `http://127.0.0.1:${instance.address().port}`;
}

function close(instance) {
  return new Promise((resolve) => instance.close(resolve));
}

test('planRpcs ranks matching endpoints and excludes wrong-chain and hard failures', async () => {
  const { planRpcs } = require('../dist/rpc-resolver.js');
  const fast = await server({ result: '0x2105' }, 1);
  const slow = await server({ result: '0x2105' }, 20);
  const wrong = await server({ result: '0x1' });
  const sendOnly = await server({ error: { message: 'method not found' } });
  const hardFailure = await server({ error: { message: 'invalid API key' } });
  try {
    const plan = await planRpcs(
      [url(slow), url(hardFailure), url(sendOnly), url(wrong), url(fast)],
      8453
    );
    assert.deepEqual(plan.urls, [url(fast), url(slow), url(sendOnly)]);
    assert.deepEqual(plan.sendOnly, [url(sendOnly)]);
    assert.equal(plan.dropped[0].url, url(wrong));
    assert.equal(plan.failures[0].url, url(hardFailure));
  } finally {
    await Promise.all([fast, slow, wrong, sendOnly, hardFailure].map(close));
  }
});
