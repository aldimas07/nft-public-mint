# NFT Public Mint Sniper

A command-line tool and Telegram Bot for sniping **public** NFT mints on OpenSea's SeaDrop, across Ethereum, Base, and Robinhood Chain.

It builds the mint transaction from **on-chain data only** — price, fee recipient, and per-wallet limit all come straight from the SeaDrop contract. That means:

- **No OpenSea account, login, or access token required.**
- **No API rate limits** to lose a mint to.
- **Faster.** Every transaction is signed and serialised *before* the stage opens, so at the exact start time the only work left is writing bytes to the network.
- **Multi-wallet:** Paste as many keys as you like and they all fire in parallel.

---

## Requirements

- **Node.js 18 or newer** — check with `node --version`. Get it from [nodejs.org](https://nodejs.org).
- A wallet with native token (ETH) on the target chain.

---

## Quick Start

### Step 1 — Install

Run these **one line at a time**:

```bash
git clone https://github.com/morsyxbt/nft-public-mint.git
cd nft-public-mint
npm install
npm run build
```

Confirm the build worked:

```bash
npm start -- --help
```

### Step 2 — Configure `.env` (optional but recommended)

```bash
cp .env.example .env
```

Open `.env` and add a private RPC URL for the chain you'll mint on, e.g.:

```env
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

A free [Alchemy](https://alchemy.com) key takes two minutes and is the single biggest factor in winning a contested mint.

> **Never put private keys in `.env`.** You paste them into the CLI or Telegram Bot at runtime. They are held in RAM for that session only and never written to disk.

---

## Running the Interactive CLI Wizard

```bash
npm start
```

The wizard guides you through setup step-by-step:

| Step | Description |
|---|---|
| **1. Private keys** | Paste keys (one per line). Hidden as you type. Confirmed back via wallet address. |
| **2. Chain** | Ethereum, Base, or Robinhood Chain. |
| **3. Quantity** | Number of NFTs **per wallet**. |
| **4. NFT link** | OpenSea collection URL, item link, slug, or raw `0x` contract address. |
| **5. RPC** | Private Alchemy/QuickNode/Infura URL or key. Falls back to `.env` / public nodes. |
| **6. Gas** | Ceiling and priority tip (gwei). Live network base fee displayed above prompt. |
| **7. Timing** | Wait for stage open (T-0 countdown) or fire immediately if live. |

Nothing is broadcast until you confirm `Fire?`.

---

## Running via Telegram Bot

Create a Telegram bot via `@BotFather`, then add to `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USER_ID=123456789
```

Run the bot:

```bash
npm run bot
```

### Telegram Bot Features & Security:

- 🔐 **Privacy & Immediate Key Scrubbing:** Private key messages are auto-deleted from chat history immediately upon receipt. In-memory sessions automatically expire after 15 minutes of inactivity.
- ⛽ **One-Tap Gas Presets:** Select pre-calculated gas fees (`🟢 Safe`, `⚡ Fast`, `🔥 Aggressive`) or click `🔄 Refresh Fee` to fetch the live network base fee.
- 💰 **Financial Outflow Summary & Risk Warning:** View total max ETH exposure (`(Mint Cost + Reserved Gas) × Wallets`) with prominent warning badges for high-value mints (> 0.2 ETH).
- 🔄 **Sub-Step Navigation & Reset:** Seamless back-navigation and one-tap `🗑 Cancel` button to purge session memory instantly.

---

## Protections & Safety Features

The tool includes system-wide safeguards against common FCFS minting pitfalls and malicious owner actions:

- 🚫 **Minted-Out Watchdog:** Real-time on-chain supply monitoring (`totalSupply`/`maxSupply` + `eth_call` dry-run). If the stage sells out during pre-flight, countdown waiting, or dispatch, execution **aborts immediately** with clear supply metrics.
- ⚠️ **Price Hike Safety Abort:** Locks initial mint price upon setup. If the contract owner changes or increases `mintPrice` on-chain at any point before or during execution, the bot **stops immediately** for user safety.
- ⛽ **Ceiling & Balance Verification:** Pre-calculates exact upfront ETH reservation (`gasLimit × maxFee + mintPrice`) per wallet and alerts you if any wallet is underfunded.
- 🔗 **Chain ID Verification:** Verifies every RPC endpoint's chain ID to prevent sending transactions to the wrong network.
- 🛡 **Dev-Rug Price Hedge (CLI):** Option to set `MAX_MINT_PRICE_ETH` to reserve excess ETH up to a set cap — SeaDrop charges the exact price and refunds the excess.

---

## Supported Chains

| Chain | Chain ID | Explorer |
|---|---|---|
| Ethereum | 1 | etherscan.io |
| Base | 8453 | basescan.org |
| Robinhood Chain | 4663 | robinhoodchain.blockscout.com |

To add another network, append an entry to [`src/chains.ts`](src/chains.ts).

---

## Security

- Private keys are held strictly in temporary RAM during execution and **never logged or written to disk**.
- Output responses automatically redact 32-byte hex private key patterns (`sanitizeOutput`).
- `.env`, `wallets/`, and `*.key` are git-ignored.
- Use dedicated hot wallets funded only with what you intend to spend.

---

## Allowlist / FCFS Mints

Not supported. Allowlist stages require SeaDrop's `mintSigned()`, which relies on OpenSea's server-side signatures bound to a specific wallet. Public stages use unsigned `mintPublic()`, which can be built 100% on-chain.

---

## License

MIT
