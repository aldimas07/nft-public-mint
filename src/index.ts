#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { rpcTransport } from "./rpc-transport";

const HELP = `
NFT Public Mint Sniper

  Mints public SeaDrop stages. Calldata is built from on-chain state, so no
  OpenSea account or access token is required.

Usage
  npm start              run the interactive wizard
  npm start -- --help    show this message

Everything is asked interactively: keys, chain, quantity, NFT link, RPC,
gas and timing. Optional defaults can be set in .env (see .env.example).
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(HELP);
      return;
    }

    await runWizard();
  } catch (err: any) {
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exitCode = 1;
  } finally {
    closePrompts();
    await rpcTransport.close();
  }
}

void main();
