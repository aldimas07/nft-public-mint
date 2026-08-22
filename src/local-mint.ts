// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.

import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan, fetchMintStatus, fetchPublicDrop, rebuildMintPlan } from "./seadrop-public";
import { rpcTransport } from "./rpc-transport";

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart,
  } = opts;
  let plan = opts.plan; // reassigned when drop revalidation finds on-chain changes
  const initialMintPrice = plan.drop.mintPrice;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  console.log(chalk.bold.magenta("\n── LOCAL PUBLIC MINT (no OpenSea) ──"));
  console.log(chalk.gray(`  SeaDrop:       ${plan.to}`));
  console.log(chalk.gray(`  NFT:           ${nftContract}`));
  console.log(chalk.gray(`  Fee recipient: ${plan.feeRecipient}`));
  console.log(
    chalk.gray(
      `  Price:         ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} per wallet`
    )
  );
  console.log(chalk.gray(`  Calldata:      ${(plan.data.length - 2) / 2} bytes (identical for every wallet)`));

  // ── Warm sockets and pre-fetch everything the signature depends on ──
  await warmConnections(rpcUrls);

  let nonces = await Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending")));
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  let prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];
  const prepareTransactions = async (): Promise<void> => {
    const signStart = performance.now();
    prepared = await Promise.all(wallets.map(async (wallet, i) => {
      const rawTx = await wallet.signTransaction({
        to: plan.to,
        data: plan.data,
        value: plan.value,
        nonce: nonces[i],
        maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFee,
        gasLimit: gasLimit || 250_000,
        type: 2,
        chainId,
      });
      return { idx: i, address: wallet.address, blast: prepareBlast(rawTx) };
    }));
    console.log(chalk.green(
      `  ${prepared.length} tx(s) signed and serialised in ${(performance.now() - signStart).toFixed(1)}ms`
    ));
  };
  await prepareTransactions();

  // ── Wait for the stage, then blast pre-built bytes ──
  if (targetStart) {
    const hooks = [];
    if (targetStart.getTime() - Date.now() > 30_000) {
      hooks.push({ beforeMs: 30_000, run: () => warmConnections(rpcUrls, 5_000).then(() => undefined) });
    }
    if (targetStart.getTime() - Date.now() > 5_000) {
      hooks.push({
        beforeMs: 3_000,
        run: async () => {
          try {
            const [freshNonces, feeData] = await refreshSigningState(
              rpcUrls[0],
              wallets.map((wallet) => wallet.address),
              1_500
            );
            if (feeData.baseFeePerGas !== null && feeData.baseFeePerGas > maxFeePerGas) {
              const error = new Error(
                `Current base fee ${formatUnits(feeData.baseFeePerGas, "gwei")} gwei exceeds your hard cap; refusing a transaction that nodes will reject.`
              );
              error.name = "FeeCapExceededError";
              throw error;
            }

            let needsResign = false;
            const nonceChanged = freshNonces.some((nonce, i) => nonce !== nonces[i]);
            if (nonceChanged) {
              nonces = freshNonces;
              console.log(chalk.yellow("  Pending nonce changed; will re-sign."));
              needsResign = true;
            }

            // Dev-rug defense: the owner can updatePublicDrop() at any moment.
            // Re-read the drop and rebuild the plan if price / per-wallet cap /
            // window / fee recipient moved.
            const rebuilt = await rebuildMintPlan(rpcUrls[0], plan);
            if (rebuilt === null) {
              console.log(chalk.yellow("  Drop revalidation unavailable (RPC); keeping prepared transactions."));
            } else if ("removed" in rebuilt) {
              const error = new Error("SeaDrop public drop disappeared on-chain mid-run — aborting before blast.");
              error.name = "DropRemovedError";
              throw error;
            } else if (rebuilt.changes.length > 0) {
              if (rebuilt.plan.drop.mintPrice !== initialMintPrice) {
                const error = new Error(
                  `Mint price changed on-chain from ${formatEther(initialMintPrice)} ETH to ${formatEther(rebuilt.plan.drop.mintPrice)} ETH — stopping mint for safety.`
                );
                error.name = "PriceChangedError";
                throw error;
              }
              plan = rebuilt.plan;
              console.log(chalk.yellow(`  Drop changed on-chain: ${rebuilt.changes.join("; ")}`));
              needsResign = true;
            }

            if (needsResign) {
              console.log(chalk.yellow("  Re-signing prepared transactions with current on-chain state."));
              await prepareTransactions();
            }
          } catch (error) {
            if (
              error instanceof Error &&
              (error.name === "FeeCapExceededError" || error.name === "DropRemovedError" || error.name === "PriceChangedError" || error.name === "MintedOutError")
            ) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.log(chalk.yellow(`  Revalidation unavailable (${message}); keeping prepared transactions.`));
          }
          await warmConnections(rpcUrls, 1_000);
        },
      });
    } else {
      console.log(chalk.yellow("  Less than 5s to mint; skipping nonce refresh to preserve T-0 dispatch."));
    }
    await waitForMintTime(targetStart, {
      hooks,
      spinWindowMs: 2,
      // Watchdog: while we wait, check on-chain supply and price changes every 3s
      pollEveryMs: 3_000,
      onPoll: async () => {
        const status = await fetchMintStatus(rpcUrls[0], nftContract, plan, wallets[0].address);
        if (status.mintedOut) {
          const error = new Error(
            `NFT minted out on-chain while waiting — stopping before blast. ` +
            `(totalSupply ${status.totalSupply ?? "?"}${status.maxSupply !== null ? ` / ${status.maxSupply}` : ""})`
          );
          error.name = "MintedOutError";
          throw error;
        }

        const freshDrop = await fetchPublicDrop(rpcUrls[0], nftContract);
        if (freshDrop && freshDrop.mintPrice !== initialMintPrice) {
          const error = new Error(
            `Mint price changed on-chain from ${formatEther(initialMintPrice)} ETH to ${formatEther(freshDrop.mintPrice)} ETH — stopping mint for safety.`
          );
          error.name = "PriceChangedError";
          throw error;
        }
      },
    });
  } else {
    console.log(chalk.bold.yellow("\n  🚀 Running pre-flight checks before immediate fire..."));
    const status = await fetchMintStatus(rpcUrls[0], nftContract, plan, wallets[0].address);
    if (status.mintedOut) {
      const error = new Error(
        `NFT minted out on-chain — stopping before blast. ` +
        `(totalSupply ${status.totalSupply ?? "?"}${status.maxSupply !== null ? ` / ${status.maxSupply}` : ""})`
      );
      error.name = "MintedOutError";
      throw error;
    }

    const freshDrop = await fetchPublicDrop(rpcUrls[0], nftContract);
    if (freshDrop && freshDrop.mintPrice !== initialMintPrice) {
      const error = new Error(
        `Mint price changed on-chain from ${formatEther(initialMintPrice)} ETH to ${formatEther(freshDrop.mintPrice)} ETH — stopping mint for safety.`
      );
      error.name = "PriceChangedError";
      throw error;
    }
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired = prepared.map(({ idx, address, blast }) => {
    const { txHash, firstAcceptedPromise, responsePromise } = blastToAll(blast, endpoints);
    return { idx, address, txHash, firstAcceptedPromise, responsePromise };
  });

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);
  console.log(
    chalk.bold.green(`  ENQUEUED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`)
  );
  for (const f of fired) {
    console.log(chalk.gray(`    [W${f.idx}] ${f.txHash}`));
  }

  // Minted-out watchdog for the firing phase: once the supply is exhausted the
  // in-flight transactions are guaranteed to revert, so surface it immediately
  // and shrink the receipt wait instead of holding full timeouts for txs that
  // can never succeed. Stops as soon as every receipt has settled.
  let soldOut = false;
  let receiptsSettled = false;
  let receiptTimeoutMs = 60_000;
  const mintedOutWatcher = (async () => {
    const deadline = Date.now() + 90_000;
    while (!soldOut && !receiptsSettled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try {
        const status = await fetchMintStatus(rpcUrls[0], nftContract, plan, wallets[0].address);
        if (status.mintedOut) {
          soldOut = true;
          receiptTimeoutMs = 10_000;
          console.log(chalk.bold.red("\n  🚫 MINTED OUT on-chain — supply exhausted, in-flight tx(s) will revert."));
          console.log(chalk.gray(
            `     totalSupply ${status.totalSupply ?? "?"}${status.maxSupply !== null ? ` / ${status.maxSupply}` : ""}`
          ));
        }
      } catch {
        // Transient RPC error — keep watching.
      }
    }
  })();

  const acceptanceWork = fired.map(async (f) => {
    const acceptedBy = await f.firstAcceptedPromise;
    if (!acceptedBy) return { ...f, acceptedBy, receipt: null };
    const receipt = await waitForReceipt(f.txHash, rpcUrls[0], () => receiptTimeoutMs);
    return { ...f, acceptedBy, receipt };
  });

  const settled = await Promise.all(
    fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
  );
  const rejected = settled.filter(({ results }) =>
    !results.some((result) => result.txHash !== null || /already known|already exists/i.test(result.error ?? ""))
  );

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
    }
  }

  const acceptedWallets = await Promise.all(acceptanceWork);
  receiptsSettled = true; // stops the minted-out watcher — no dangling timers
  await mintedOutWatcher;
  const acceptedCount = acceptedWallets.filter((entry) => entry.acceptedBy !== null).length;
  if (acceptedCount === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
    return;
  }

  console.log(chalk.gray("\n  Receipt results:"));
  for (const { idx, txHash, acceptedBy, receipt } of acceptedWallets) {
    if (!acceptedBy) continue;
    if (!receipt) {
      console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, txHash)}`));
      continue;
    }
    const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
    console.log(color(
      `  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`
    ));
    console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`));
  }

  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
}

async function refreshSigningState(
  rpcUrl: string,
  addresses: string[],
  timeoutMs: number
): Promise<[number[], { baseFeePerGas: bigint | null }]> {
  const nonceCalls = addresses.map((address, id) => ({
    jsonrpc: "2.0",
    method: "eth_getTransactionCount",
    params: [address, "pending"],
    id,
  }));
  const feeId = addresses.length;
  const { text } = await rpcTransport.requestText(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      ...nonceCalls,
      { jsonrpc: "2.0", method: "eth_maxPriorityFeePerGas", params: [], id: feeId },
      { jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: feeId + 1 },
    ]),
  }, timeoutMs);
  const responses = JSON.parse(text) as { id: number; result?: any; error?: { message?: string } }[];
  if (!Array.isArray(responses)) throw new Error("RPC batch response was not an array");
  const byId = new Map(responses.map((response) => [response.id, response]));
  const nonces = addresses.map((_, id) => {
    const response = byId.get(id);
    if (!response?.result) throw new Error(response?.error?.message || `missing nonce response ${id}`);
    return parseInt(response.result, 16);
  });
  const baseFeeRaw = byId.get(feeId + 1)?.result?.baseFeePerGas;
  const baseFeePerGas = baseFeeRaw ? BigInt(baseFeeRaw) : null;
  return [nonces, { baseFeePerGas }];
}
