import chalk from "chalk";
import { rpcTransport } from "./rpc-transport";

export interface WarmResult {
  url: string;
  ok: boolean;
}

export async function warmConnections(rpcUrls: string[], timeoutMs = 8_000): Promise<WarmResult[]> {
  console.log(chalk.gray("  Warming connections..."));
  const results = await Promise.all(
    rpcUrls.map(async (url) => ({ url, ok: await rpcTransport.warm(url, timeoutMs) }))
  );
  const ready = results.filter((result) => result.ok).length;
  console.log(chalk.green(`  Connections hot: ${ready}/${results.length}.`));
  return results;
}
