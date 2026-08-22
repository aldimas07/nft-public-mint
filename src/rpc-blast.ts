import chalk from "chalk";
import { keccak256 } from "ethers";
import { rpcTransport } from "./rpc-transport";

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface BlastResult {
  label: string;
  txHash: string | null;
  error: string | null;
}

// Parse RPC URLs and assign labels
export function parseRpcEndpoints(rpcUrls: string[]): RpcEndpoint[] {
  return rpcUrls.map((url, i) => ({
    url,
    label: labelFromUrl(url, i),
  }));
}

function labelFromUrl(url: string, index: number): string {
  const lower = url.toLowerCase();
  if (lower.includes("sequencer.base.org")) return "mainnet-sequencer.base.org";
  if (lower.includes("sequencer.mainnet.chain.robinhood.com")) return "robinhood-sequencer";
  if (lower.includes("rpc.mainnet.chain.robinhood.com")) return "robinhood-public";
  if (lower.includes("alchemy")) return "ALCHEMY";
  if (lower.includes("flashbots")) return "FLASHBOTS-PROTECT";
  if (lower.includes("llamarpc")) {
    // llamarpc serves several networks — keep the host so the label stays honest
    try { return new URL(url).hostname; } catch { return "llamarpc"; }
  }
  if (lower.includes("quicknode")) return "QUICKNODE";
  if (lower.includes("infura")) return "INFURA";
  if (lower.includes("ankr")) return "ANKR";
  if (lower.includes("publicnode")) return "PUBLICNODE";
  if (lower.includes("cloudflare")) return "CLOUDFLARE";
  try {
    const hostname = new URL(url).hostname;
    return hostname;
  } catch {
    return `RPC[${index}]`;
  }
}

export interface PreparedBlast {
  txHash: string;
  body: string;
}

// Call this BEFORE the fire moment (after signing) — does all compute work upfront
export function prepareBlast(rawTx: string): PreparedBlast {
  return {
    txHash: keccak256(rawTx) as string,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [rawTx],
      id: 1,
    }),
  };
}

// Blast a raw signed tx to all RPC endpoints simultaneously — FIRE AND FORGET
// Returns immediately after initiating fetch calls (sub-ms dispatch)
// Responses are collected via the returned promise for logging later
export interface BlastDispatch {
  txHash: string;
  firstAcceptedPromise: Promise<BlastResult | null>;
  responsePromise: Promise<BlastResult[]>;
}

export function blastToAll(
  rawTxOrPrepared: string | PreparedBlast,
  endpoints: RpcEndpoint[]
): BlastDispatch {
  const prepared: PreparedBlast =
    typeof rawTxOrPrepared === "string"
      ? prepareBlast(rawTxOrPrepared)
      : rawTxOrPrepared;

  const { txHash, body } = prepared;

  let resolveFirstAccepted: (result: BlastResult | null) => void;
  const firstAcceptedPromise = new Promise<BlastResult | null>((resolve) => {
    resolveFirstAccepted = resolve;
  });
  let remaining = endpoints.length;
  let accepted = false;
  const complete = (result: BlastResult): BlastResult => {
    const isAccepted = result.txHash !== null || /already known|already exists/i.test(result.error ?? "");
    if (isAccepted && !accepted) {
      accepted = true;
      resolveFirstAccepted(result);
    }
    remaining -= 1;
    if (remaining === 0 && !accepted) resolveFirstAccepted(null);
    return result;
  };
  if (remaining === 0) resolveFirstAccepted!(null);

  const startedAt = performance.now();
  const firePromises = endpoints.map(async (ep, i): Promise<BlastResult> => {
    const enqueuedAt = performance.now();
    try {
      const { response, text } = await rpcTransport.requestText(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }, 8_000);
      const respondedAt = performance.now();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        const error = `HTTP ${response.status ?? "?"}: non-JSON response`;
        return complete({ label: ep.label, txHash: null, error });
      }
      if (json.result) {
        console.log(chalk.green(`  [${i}] ${ep.label}  TX: ${json.result}  +${(respondedAt - startedAt).toFixed(1)}ms`));
        return complete({ label: ep.label, txHash: json.result, error: null });
      }
      const error = json.error?.message || JSON.stringify(json.error || json);
      if (error.includes("already known") || error.includes("already exists")) {
        console.log(chalk.yellow(`  [${i}] ${ep.label}  ERR: already known  +${(respondedAt - startedAt).toFixed(1)}ms`));
      } else {
        console.log(chalk.red(`  [${i}] ${ep.label}  ERR: ${error}`));
      }
      return complete({ label: ep.label, txHash: null, error });
    } catch (err: any) {
      const error = err?.name === "AbortError" ? "request timeout" : err?.message || String(err);
      console.log(chalk.red(`  [${i}] ${ep.label}  ERR: ${error} (queued +${(enqueuedAt - startedAt).toFixed(2)}ms)`));
      return complete({ label: ep.label, txHash: null, error });
    }
  });

  const responsePromise = Promise.all(firePromises);

  // Return IMMEDIATELY — txHash computed locally, fetches already in flight
  return { txHash, firstAcceptedPromise, responsePromise };
}

// Wait for tx receipt and return block info.
// timeoutMs may be a function so the cap can shrink mid-wait (e.g. once a mint
// is confirmed sold out, stop waiting full timeouts for the remaining txs).
export async function waitForReceipt(
  txHash: string,
  rpcUrl: string,
  timeoutMs: number | (() => number) = 30000
): Promise<{ block: number; position: number; gasUsed: number; status: string } | null> {
  const start = Date.now();

  while (true) {
    const limit = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
    if (Date.now() - start >= limit) break;
    try {
      const { text } = await rpcTransport.rpc(
        rpcUrl,
        "eth_getTransactionReceipt",
        [txHash],
        Math.min(5_000, limit)
      );
      const json = JSON.parse(text) as any;
      const receipt = json.result;

      if (receipt) {
        return {
          block: parseInt(receipt.blockNumber, 16),
          position: parseInt(receipt.transactionIndex, 16),
          gasUsed: parseInt(receipt.gasUsed, 16),
          status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
        };
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}
