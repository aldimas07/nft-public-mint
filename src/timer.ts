import chalk from "chalk";
import ora from "ora";
import { performance } from "perf_hooks";

export interface WaitHook {
  beforeMs: number;
  run: () => Promise<void> | void;
}

export interface WaitOptions {
  earlyFireMs?: number;
  hooks?: WaitHook[];
  silent?: boolean;
  spinWindowMs?: number;
  // Optional periodic check during the wait. Throwing from onPoll aborts the
  // wait immediately (e.g. "minted out on-chain — stop"). Polling pauses in
  // the last `pollEveryMs + 100` ms before release so T-0 precision is kept.
  pollEveryMs?: number;
  onPoll?: () => Promise<void> | void;
}

interface WaitPoll {
  everyMs: number;
  run: () => Promise<void> | void;
}

export interface WaitResult {
  targetMs: number;
  releasedAtMs: number;
  errorMs: number;
}

export async function waitForMintTime(
  mintTime: Date,
  earlyFireOrOptions: number | WaitOptions = 0
): Promise<WaitResult> {
  const options: WaitOptions = typeof earlyFireOrOptions === "number"
    ? { earlyFireMs: earlyFireOrOptions }
    : earlyFireOrOptions;
  const earlyFireMs = options.earlyFireMs ?? 0;
  const targetMs = mintTime.getTime() - earlyFireMs;
  const wallStartMs = Date.now();
  const monoStartMs = performance.now();
  const deadlineMonoMs = monoStartMs + (targetMs - wallStartMs);
  const hooks = [...(options.hooks ?? [])].sort((a, b) => b.beforeMs - a.beforeMs);
  const firstHookMonoMs = hooks.length > 0
    ? deadlineMonoMs - hooks[0].beforeMs
    : deadlineMonoMs;
  const poll: WaitPoll | undefined =
    options.pollEveryMs && options.onPoll
      ? { everyMs: options.pollEveryMs, run: options.onPoll }
      : undefined;

  if (!options.silent) {
    console.log(chalk.bold.white(`\nMint time: ${mintTime.toISOString()}`));
    if (earlyFireMs > 0) console.log(chalk.bold.yellow(`  Early fire: ${earlyFireMs}ms`));
  }

  // Keep the operator informed while waiting for the first scheduled hook.
  if (!options.silent && firstHookMonoMs - performance.now() > 10_000) {
    const spinner = ora({
      text: formatCountdown(firstHookMonoMs - performance.now(), hooks.length > 0 ? "Next preparation" : "Mint"),
      color: "cyan",
    }).start();
    let lastPollMs = 0;
    while (firstHookMonoMs - performance.now() > 5_000) {
      await sleep(Math.min(500, Math.max(1, firstHookMonoMs - performance.now() - 5_000)));
      spinner.text = formatCountdown(
        firstHookMonoMs - performance.now(),
        hooks.length > 0 ? "Next preparation" : "Mint"
      );
      if (poll && performance.now() - lastPollMs >= poll.everyMs) {
        lastPollMs = performance.now();
        await poll.run();
      }
    }
    spinner.stop();
  } else {
    await sleepUntil(firstHookMonoMs, 0, poll);
  }

  for (const hook of hooks) {
    await sleepUntil(deadlineMonoMs - hook.beforeMs, 0, poll);
    await hook.run();
  }

  await sleepUntil(deadlineMonoMs, Math.max(0, options.spinWindowMs ?? 2), poll);
  const releasedAtMs = wallStartMs + (performance.now() - monoStartMs);
  return { targetMs, releasedAtMs, errorMs: releasedAtMs - targetMs };
}

async function sleepUntil(deadlineMonoMs: number, spinWindowMs: number, poll?: WaitPoll): Promise<void> {
  let remaining = deadlineMonoMs - performance.now();
  if (remaining <= 0) return;

  // Long waits wake periodically to run the poll. An exception from poll.run()
  // aborts the wait immediately — no dangling timers, since we throw from
  // within the loop and never schedule the next sleep.
  if (poll && remaining > poll.everyMs + 100) {
    while ((remaining = deadlineMonoMs - performance.now()) > poll.everyMs + 100) {
      await sleep(Math.min(poll.everyMs, remaining - poll.everyMs - 100));
      await poll.run();
    }
    remaining = deadlineMonoMs - performance.now();
    if (remaining <= 0) return;
  }

  if (remaining > spinWindowMs + 10) {
    await sleep(remaining - spinWindowMs - 5);
  }
  while ((remaining = deadlineMonoMs - performance.now()) > spinWindowMs) {
    await sleep(Math.max(0, Math.min(1, remaining - spinWindowMs)));
  }
  while (performance.now() < deadlineMonoMs) {
    // Deliberately bounded to the configured final precision window.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCountdown(diffMs: number, label: string): string {
  const safe = Math.max(0, diffMs);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  if (hours > 0) return `  ${label} in ${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `  ${label} in ${minutes}m ${seconds}s`;
  return `  ${label} in ${seconds}s`;
}
