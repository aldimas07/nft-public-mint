// Build SeaDrop public-mint calldata locally, with no OpenSea involvement.
//
// A public stage is unsigned: SeaDrop.mintPublic() takes only the drop's own
// parameters, so the whole transaction can be assembled from on-chain reads.
// That removes the access token, its expiry, OpenSea's rate limits, and — the
// part that actually matters for FCFS — the ~1s API round-trip from the
// critical path, because every tx can be signed before the stage even opens.
//
// The allowlist/FCFS stage is different in kind: mintSigned() carries a
// server-produced signature bound to one wallet, so that path still needs
// OpenSea and there is no local equivalent.

import { Contract, Interface, formatEther } from "ethers";
import { makeProvider } from "./chains";

export const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// OpenSea's standard fee collector — the usual allowed recipient on their drops.
// Only used when a drop leaves the recipient list empty and unrestricted, since
// SeaDrop rejects the zero address outright.
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

const PUBLIC_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
];

const IFACE = new Interface(PUBLIC_ABI);

export interface PublicDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface LocalMintPlan {
  to: string; // always the SeaDrop singleton
  data: string; // identical for every wallet — see minterIfNotPayer below
  value: bigint; // max(mintPrice, maxMintPrice) × quantity — see mintValue below
  drop: PublicDrop;
  feeRecipient: string;
  nftContract: string;
  quantity: number;
  maxMintPrice: bigint; // 0n = no over-provision cap (value = current mintPrice × qty)
}

function isUnsetDrop(drop: PublicDrop): boolean {
  // An unset mapping entry decodes to all zeros rather than reverting.
  return drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0;
}

// Reads the drop and THROWS on RPC failure — callers that want a nullable read
// use fetchPublicDrop; rebuildMintPlan needs to distinguish "RPC down" (keep
// prepared transactions) from "drop confirmed gone" (abort).
export async function readPublicDrop(rpcUrl: string, nftContract: string): Promise<PublicDrop> {
  const provider = makeProvider(rpcUrl);
  const seadrop = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);
  const raw = await seadrop.getPublicDrop(nftContract);
  return {
    mintPrice: BigInt(raw.mintPrice),
    startTime: Number(raw.startTime),
    endTime: Number(raw.endTime),
    maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
    feeBps: Number(raw.feeBps),
    restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
  };
}

// Returns null when this contract has no public drop on the SeaDrop singleton —
// either it isn't a SeaDrop collection at all, or it uses a newer variant that
// keeps drop config on the token contract itself.
export async function fetchPublicDrop(
  rpcUrl: string,
  nftContract: string
): Promise<PublicDrop | null> {
  try {
    const drop = await readPublicDrop(rpcUrl, nftContract);
    return isUnsetDrop(drop) ? null : drop;
  } catch {
    return null;
  }
}

// SeaDrop reverts on a zero fee recipient, and on a disallowed one when the drop
// restricts them — so this has to come from the chain, not a guess.
export async function resolveFeeRecipient(
  rpcUrl: string,
  nftContract: string,
  restricted: boolean
): Promise<{ address: string; source: string } | null> {
  const provider = makeProvider(rpcUrl);
  const seadrop = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);

  let allowed: string[] = [];
  try {
    allowed = await seadrop.getAllowedFeeRecipients(nftContract);
  } catch {
    allowed = [];
  }

  if (allowed.length > 0) {
    return { address: allowed[0], source: "allowed fee recipient on-chain" };
  }
  if (restricted) {
    // Nothing allowed and the drop enforces the list — a public mint cannot be
    // constructed at all, locally or otherwise.
    return null;
  }
  return { address: OPENSEA_FEE_RECIPIENT, source: "OpenSea default (drop does not restrict)" };
}

// minterIfNotPayer = address(0) means "credit the caller", so the calldata is
// byte-identical for every wallet and can be encoded once and shared.
export function encodeMintPublic(
  nftContract: string,
  feeRecipient: string,
  quantity: number
): string {
  return IFACE.encodeFunctionData("mintPublic", [
    nftContract,
    feeRecipient,
    "0x0000000000000000000000000000000000000000",
    BigInt(quantity),
  ]);
}

// SeaDrop charges exactly the CURRENT mintPrice × quantity at execution time and
// refunds any excess via _refundExcess(). Sending more than the current price
// is therefore a free hedge against the owner raising the price after we sign:
// the tx survives any bump up to `maxMintPrice`, and the overpayment comes
// back automatically. Downside: the wallet must hold the reserved amount
// through the mint (nodes require balance ≥ gasLimit × maxFee + value).
export function mintValue(mintPrice: bigint, maxMintPrice: bigint, quantity: number): bigint {
  // Free drop: never reserve a hedge on top of free — the cap bounds payment
  // risk, and a paid cap on a free drop only inflates node balance reserves.
  if (mintPrice === 0n) return 0n;
  const effective = maxMintPrice > mintPrice ? maxMintPrice : mintPrice;
  return effective * BigInt(quantity);
}

export async function buildLocalMintPlan(
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  maxMintPrice: bigint = 0n
): Promise<LocalMintPlan | null> {
  const drop = await fetchPublicDrop(rpcUrl, nftContract);
  if (!drop) return null;

  const fee = await resolveFeeRecipient(rpcUrl, nftContract, drop.restrictFeeRecipients);
  if (!fee) return null;

  return {
    to: SEADROP_ADDRESS,
    data: encodeMintPublic(nftContract, fee.address, quantity),
    value: mintValue(drop.mintPrice, maxMintPrice, quantity),
    drop,
    feeRecipient: fee.address,
    nftContract,
    quantity,
    maxMintPrice,
  };
}

export interface DropChanges {
  plan: LocalMintPlan;
  changes: string[];
}

export type RebuildResult = DropChanges | { removed: true } | null;

// Re-read the drop right before firing and rebuild the plan if the owner
// changed anything that would break the pre-signed transactions (mint price,
// per-wallet cap, window, fee recipient). Returns:
//   null              — RPC unavailable; the caller should keep prepared txs
//   { removed: true } — drop confirmed gone/unbuildable; firing would only revert
//   { plan, changes } — a plan rebuilt from current state; changes lists what moved
export async function rebuildMintPlan(rpcUrl: string, plan: LocalMintPlan): Promise<RebuildResult> {
  let drop: PublicDrop;
  try {
    drop = await readPublicDrop(rpcUrl, plan.nftContract);
  } catch {
    return null;
  }
  if (isUnsetDrop(drop)) return { removed: true };

  const fee = await resolveFeeRecipient(rpcUrl, plan.nftContract, drop.restrictFeeRecipients);
  if (!fee) return { removed: true };

  const changes: string[] = [];
  if (drop.mintPrice !== plan.drop.mintPrice) {
    changes.push(`mintPrice ${formatEther(plan.drop.mintPrice)} → ${formatEther(drop.mintPrice)} ETH`);
  }
  if (drop.startTime !== plan.drop.startTime) changes.push("startTime changed");
  if (drop.endTime !== plan.drop.endTime) changes.push("endTime changed");
  if (drop.maxTotalMintableByWallet !== plan.drop.maxTotalMintableByWallet) {
    changes.push(
      `maxTotalMintableByWallet ${plan.drop.maxTotalMintableByWallet} → ${drop.maxTotalMintableByWallet}`
    );
  }
  if (drop.restrictFeeRecipients !== plan.drop.restrictFeeRecipients) {
    changes.push(
      `restrictFeeRecipients ${plan.drop.restrictFeeRecipients} → ${drop.restrictFeeRecipients}`
    );
  }
  if (fee.address !== plan.feeRecipient) changes.push(`feeRecipient → ${fee.address}`);

  let quantity = plan.quantity;
  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    quantity = drop.maxTotalMintableByWallet;
    changes.push(`quantity ${plan.quantity} → ${quantity} (per-wallet cap)`);
  }

  return {
    plan: {
      to: SEADROP_ADDRESS,
      data: encodeMintPublic(plan.nftContract, fee.address, quantity),
      value: mintValue(drop.mintPrice, plan.maxMintPrice, quantity),
      drop,
      feeRecipient: fee.address,
      nftContract: plan.nftContract,
      quantity,
      maxMintPrice: plan.maxMintPrice,
    },
    changes,
  };
}

// ── Minted-out (supply exhausted) detection ────────────────────────────────
//
// "Sold out" is on-chain state, not an OpenSea API flag: SeaDrop reverts the
// mint with MintQuantityExceedsMaxSupply() once totalSupply reaches the
// collection cap. Detected two ways, best effort:
//   1. totalSupply() >= maxSupply() when the NFT contract exposes both views.
//   2. A dry-run eth_call of our own mint — if it reverts with the supply
//      selector, the stage is exhausted even when the views are absent.
// A dry-run that reverts for any OTHER reason (NotActive before start, price
// bumped, ...) is deliberately NOT treated as minted out — the existing
// drop revalidation handles those.

export const MINT_QUANTITY_EXCEEDS_MAX_SUPPLY_SELECTOR = "0x4ef4aa66";

const SUPPLY_ABI = [
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
];

export interface MintStatus {
  totalSupply: bigint | null;
  maxSupply: bigint | null;
  mintedOut: boolean;
  revertSelector: string | null;
}

// Pure classification — kept separate from the RPC reads so it is unit-testable.
export function classifyMintedOut(
  totalSupply: bigint | null,
  maxSupply: bigint | null,
  revertSelector: string | null
): boolean {
  const supplyExhausted =
    totalSupply !== null && maxSupply !== null && totalSupply >= maxSupply;
  return (
    supplyExhausted || revertSelector === MINT_QUANTITY_EXCEEDS_MAX_SUPPLY_SELECTOR
  );
}

export async function fetchMintStatus(
  rpcUrl: string,
  nftContract: string,
  plan: LocalMintPlan,
  from: string
): Promise<MintStatus> {
  const provider = makeProvider(rpcUrl);
  const nft = new Contract(nftContract, SUPPLY_ABI, provider);

  let totalSupply: bigint | null = null;
  let maxSupply: bigint | null = null;
  try {
    totalSupply = BigInt(await nft.totalSupply());
  } catch {
    // Contract has no totalSupply view — fall back to the dry-run below.
  }
  try {
    maxSupply = BigInt(await nft.maxSupply());
  } catch {
    // No maxSupply view either — the dry-run is the source of truth.
  }

  let revertSelector: string | null = null;
  try {
    // eth_call simulates the exact mint we would broadcast. SeaDrop checks
    // msg.value, not the sender's balance, so this is accurate regardless of
    // how much ETH the wallet actually holds.
    await provider.call({ to: plan.to, data: plan.data, value: plan.value, from });
  } catch (error: any) {
    const data = error?.data ?? error?.info?.error?.data ?? "";
    if (typeof data === "string" && data.startsWith("0x")) {
      revertSelector = data.slice(0, 10).toLowerCase();
    }
  }

  const mintedOut = classifyMintedOut(totalSupply, maxSupply, revertSelector);

  return { totalSupply, maxSupply, mintedOut, revertSelector };
}