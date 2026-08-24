import { Contract, Wallet, JsonRpcProvider, parseUnits } from "ethers";
import type { WalletMintReport } from "./local-mint";

const ERC721_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

export interface SweepResult {
  idx: number;
  wallet: string;
  sent: number;
  txHashes: string[];
  error?: string;
}

// Transfer every NFT the successful wallets hold in `nftContract` to `to`.
// Wallets whose address equals `to` are skipped — nothing to send.
export async function sweepMintedNfts(
  opts: {
    nftContract: string;
    rpcUrl: string;
    to: string;
    walletKeys: string[];
    report: WalletMintReport[];
    maxFeePerGas: bigint;
    maxPriorityFee: bigint;
    gasLimit: number;
  },
  onProgress?: (line: string) => void
): Promise<SweepResult[]> {
  const { nftContract, rpcUrl, to, walletKeys, report } = opts;
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const erc = new Contract(nftContract, ERC721_ABI, provider);
  const target = to.toLowerCase();

  const successful = new Set(report.filter(r => r.status === "SUCCESS").map(r => r.idx));
  const results: SweepResult[] = [];

  for (const idx of [...successful].sort((a, b) => a - b)) {
    const key = walletKeys[idx];
    if (!key) continue;
    const wallet = new Wallet(key, provider);
    if (wallet.address.toLowerCase() === target) {
      results.push({ idx, wallet: wallet.address, sent: 0, txHashes: [], error: "wallet is the destination — skipped" });
      continue;
    }
    try {
      const balance: bigint = await erc.balanceOf(wallet.address);
      if (balance === 0n) {
        results.push({ idx, wallet: wallet.address, sent: 0, txHashes: [], error: "no NFTs held" });
        continue;
      }
      const hashes: string[] = [];
      for (let i = 0; i < balance; i++) {
        // Index 0 each time: every transfer shifts the enumeration.
        const tokenId: bigint = await erc.tokenOfOwnerByIndex(wallet.address, 0);
        const nft = new Contract(nftContract, ERC721_ABI, wallet);
        const tx = await nft.safeTransferFrom(wallet.address, to, tokenId, {
            maxFeePerGas: opts.maxFeePerGas,
            maxPriorityFeePerGas: opts.maxPriorityFee,
            gasLimit: opts.gasLimit,
          });
        onProgress?.(`[W${idx}] sending token #${tokenId}…`);
        await tx.wait();
        hashes.push(tx.hash);
      }
      results.push({ idx, wallet: wallet.address, sent: hashes.length, txHashes: hashes });
    } catch (err: any) {
      results.push({ idx, wallet: wallet.address, sent: 0, txHashes: [], error: err?.message ?? String(err) });
    }
  }

  return results;
}
