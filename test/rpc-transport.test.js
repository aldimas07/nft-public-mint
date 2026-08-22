const test = require('node:test');
const assert = require('node:assert/strict');

test('RpcTransport warm drains a successful JSON-RPC response', async () => {
  const { RpcTransport } = require('../dist/rpc-transport.js');
  let consumed = false;
  const fetchImpl = async () => ({
    ok: true,
    text: async () => {
      consumed = true;
      return '{"jsonrpc":"2.0","result":"0x1"}';
    },
  });
  const transport = new RpcTransport({ fetchImpl, timeoutMs: 25 });

  assert.equal(await transport.warm('https://rpc.example'), true);
  assert.equal(consumed, true);
});

test('RpcTransport requestText aborts when a response body stalls', async () => {
  const { RpcTransport } = require('../dist/rpc-transport.js');
  const fetchImpl = async (_url, options) => ({
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('body aborted')));
    }),
  });
  const transport = new RpcTransport({ fetchImpl, timeoutMs: 5 });

  await assert.rejects(
    () => transport.requestText('https://rpc.example', { method: 'POST' }),
    /body aborted/
  );
});

test('RpcTransport warm returns false when an endpoint times out', async () => {
  const { RpcTransport } = require('../dist/rpc-transport.js');
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const transport = new RpcTransport({ fetchImpl, timeoutMs: 5 });

  assert.equal(await transport.warm('https://rpc.example'), false);
});
