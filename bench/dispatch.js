const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { blastToAll, prepareBlast } = require('../dist/rpc-blast.js');
const { rpcTransport } = require('../dist/rpc-transport.js');

const endpointCount = Number(process.env.BENCH_ENDPOINTS || 8);
const requestCount = Number(process.env.BENCH_REQUESTS || 20);
const arrivals = [];

function startServer(delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      arrivals.push(performance.now());
      req.resume();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","result":"0x' + '1'.repeat(64) + '","id":1}');
      }, delayMs);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

(async () => {
  const servers = await Promise.all(Array.from({ length: endpointCount }, () => startServer(0)));
  const endpoints = servers.map((server, i) => ({
    url: `http://127.0.0.1:${server.address().port}`,
    label: `local-${i}`,
  }));
  const prepared = prepareBlast('0x' + '01'.repeat(97));
  const originalLog = console.log;
  console.log = () => {};
  const start = performance.now();
  const responses = [];
  for (let i = 0; i < requestCount; i++) {
    responses.push(blastToAll(prepared, endpoints).responsePromise);
  }
  const enqueueMs = performance.now() - start;
  await Promise.all(responses);
  console.log = originalLog;
  const completionMs = performance.now() - start;
  const arrivalOffsets = arrivals.map((arrival) => arrival - start);
  const spreadMs = arrivals.length > 1 ? Math.max(...arrivals) - Math.min(...arrivals) : 0;
  process.stdout.write(JSON.stringify({
    endpoints: endpointCount,
    requests: requestCount,
    received: arrivals.length,
    enqueueMs: Number(enqueueMs.toFixed(3)),
    completionMs: Number(completionMs.toFixed(3)),
    arrivalMs: {
      p50: Number(percentile(arrivalOffsets, 50).toFixed(3)),
      p95: Number(percentile(arrivalOffsets, 95).toFixed(3)),
      p99: Number(percentile(arrivalOffsets, 99).toFixed(3)),
      spread: Number(spreadMs.toFixed(3)),
    },
  }, null, 2) + '\n');
  await rpcTransport.close();
  await Promise.all(servers.map(close));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
