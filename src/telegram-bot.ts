// Telegram bot for NFT Public Mint Sniper
// Wraps the CLI wizard into a smooth Telegram conversation flow with rich UI/UX, security, & safety guards

import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import dotenv from "dotenv";
import path from "path";
import { Wallet, JsonRpcProvider, formatEther, getAddress, isAddress, parseEther } from "ethers";
import { CHAINS, ChainProfile, makeProvider, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug } from "./slug-resolver";
import {
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
  toRpcUrl,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import { buildLocalMintPlan, fetchMintStatus, LocalMintPlan, readPublicDrop } from "./seadrop-public";
import { localPublicSnipe, WalletMintReport } from "./local-mint";
import { sweepMintedNfts } from "./sweep";
import { istTimeToDate, toIST } from "./time-format";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ============================================
// Types & Session State
// ============================================

type Step =
  | "idle"
  | "keys"
  | "chain"
  | "quantity"
  | "target"
  | "target_chain_confirm"
  | "target_address_confirm"
  | "target_chain_confirm_slug"
  | "rpc"
  | "rpc_verify_confirm"
  | "gas"
  | "timing"
  | "timing_custom"
  | "confirm"
  | "minting"
  | "sweep"
  | "done";

interface MintSession {
  step: Step;
  walletKeys: string[];
  chainKey?: string;
  quantity?: number;
  nftContract?: string;
  nftLabel?: string;
  rpcUrls?: string[];
  maxFeeGwei?: number;
  priorityGwei?: number;
  gasLimit?: number;
  targetStart?: Date | null;
  mintPlan?: LocalMintPlan;
  timingLabel?: string;
  // For navigation
  previousStep?: Step;
  // Temp data
  pendingTarget?: any;
  pendingAddress?: string;
  pendingChain?: string;
  pendingContract?: string;
  pendingLabel?: string;
  pendingCustomTime?: Date;
  // Security & Privacy
  keyMessageIds?: number[];
  lastActivityTime?: number;
  // Fast path: user pasted an OpenSea link while idle — chain detected from
  // the URL, target resolved automatically after quantity, skipping the
  // chain/target prompts.
  pendingFastLink?: string;
  // Post-mint sweep: successful wallets held for a possible "send all minted
  // NFTs to one address" action.
  lastMintReport?: WalletMintReport[];
  sweepStep?: "ask" | "address";
}

type MyContext = Context & SessionFlavor<MintSession>;

const initialSession = (): MintSession => ({
  step: "idle",
  walletKeys: [],
  targetStart: undefined,
  previousStep: undefined,
  keyMessageIds: [],
  lastActivityTime: Date.now(),
});

const STEP_ORDER: Step[] = ["keys", "chain", "quantity", "target", "rpc", "gas", "timing", "confirm"];

// ============================================
// Bot Setup & Security Middleware
// ============================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID ? BigInt(process.env.TELEGRAM_ALLOWED_USER_ID) : null;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set in .env");
  process.exit(1);
}

const bot = new Bot<MyContext>(BOT_TOKEN);

bot.use(session({ initial: initialSession }));

// Authorization & Idle Timeout Guard (15 minutes)
bot.use(async (ctx, next) => {
  if (ALLOWED_USER_ID && BigInt(ctx.from?.id ?? 0) !== ALLOWED_USER_ID) {
    await ctx.reply("🚫 Unauthorized. This bot is private.");
    return;
  }

  const s = ctx.session;
  if (s && s.step !== "idle") {
    const now = Date.now();
    if (s.lastActivityTime && now - s.lastActivityTime > 15 * 60 * 1000) {
      await cleanupKeyMessages(ctx);
      ctx.session = initialSession();
      await ctx.reply("⏳ <b>Session Expired</b>\n\nSession was cleared automatically after 15 minutes of inactivity for privacy & security.", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    s.lastActivityTime = now;
  }

  await next();
});

// ============================================
// Helpers & Sanitizers
// ============================================

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeOutput(text: string): string {
  // Redact any 64-char hex private key pattern from text output
  return escapeHtml(text.replace(/0x[a-fA-F0-9]{64}/gi, "0x****************************************************************"));
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function normalizeAddress(raw: string): { address: string; checksumWarning: boolean } | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei === null || wei === undefined ? null : Number(wei) / 1e9;
  } catch {
    return null;
  }
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function getEffectiveStep(step: Step): Step {
  switch (step) {
    case "target_chain_confirm":
    case "target_address_confirm":
    case "target_chain_confirm_slug":
      return "target";
    case "rpc_verify_confirm":
      return "rpc";
    case "timing_custom":
      return "timing";
    default:
      return step;
  }
}

function progressBar(currentStep: Step): string {
  const effectiveStep = getEffectiveStep(currentStep);
  const idx = STEP_ORDER.indexOf(effectiveStep);
  if (idx < 0) return "";
  const filled = "▓".repeat(idx + 1);
  const empty = "░".repeat(STEP_ORDER.length - idx - 1);
  const pct = Math.round(((idx + 1) / STEP_ORDER.length) * 100);
  return `<code>[${filled}${empty}] ${pct}% (${idx + 1}/${STEP_ORDER.length})</code>`;
}

function stepSummary(s: MintSession): string {
  const lines: string[] = [];
  if (s.walletKeys.length) lines.push(`🔐 <b>Keys:</b> ${s.walletKeys.length} wallet(s) loaded`);
  if (s.chainKey) lines.push(`🔗 <b>Chain:</b> ${escapeHtml(resolveChain(s.chainKey)?.name ?? s.chainKey)}`);
  if (s.quantity) lines.push(`🔢 <b>Qty:</b> ${s.quantity} per wallet`);
  if (s.nftLabel) lines.push(`🎯 <b>Target:</b> ${escapeHtml(s.nftLabel)}`);
  if (s.rpcUrls && s.rpcUrls.length > 0) lines.push(`🌐 <b>RPC:</b> ${s.rpcUrls.length} endpoint(s) active`);
  if (s.maxFeeGwei !== undefined) lines.push(`⛽ <b>Gas:</b> ${s.maxFeeGwei} max / ${s.priorityGwei} tip gwei`);
  if (s.targetStart) lines.push(`⏰ <b>Timing:</b> ${toIST(s.targetStart)} IST`);
  else if (s.timingLabel) lines.push(`⏰ <b>Timing:</b> ${escapeHtml(s.timingLabel)}`);
  return lines.join("\n");
}

// ============================================
// Keyboards
// ============================================

function keysKeyboard(hasKeys: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasKeys) {
    kb.text("✅ Done (Continue to Chain)", "keys_done").row();
  }
  kb.text("❌ Cancel", "confirm_no");
  return kb;
}

function chainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ethereum", "chain_ethereum")
    .text("Base", "chain_base")
    .text("Robinhood", "chain_robinhood")
    .text("Ink (Kraken L2)", "chain_ink")
    .row()
    .text("⬅️ Back", "nav_back")
    .text("🗑 Cancel", "cmd_cancel");
}

function quantityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "qty_1")
    .text("2", "qty_2")
    .text("3", "qty_3")
    .text("5", "qty_5")
    .row()
    .text("10", "qty_10")
    .text("20", "qty_20")
    .text("50", "qty_50")
    .row()
    .text("Custom…", "qty_custom")
    .row()
    .text("⬅️ Back", "nav_back")
    .text("🗑 Cancel", "cmd_cancel");
}

function rpcKeyboard(hasEnv: boolean, hasPublicEndpoints: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasEnv) kb.text("⚡ Use .env RPCs", "rpc_use_env").row();
  if (hasPublicEndpoints) kb.text("🌐 Use Public RPC", "rpc_use_public").row();
  kb.text("⬅️ Back", "nav_back").text("🗑 Cancel", "cmd_cancel");
  return kb;
}

function gasKeyboard(baseFee: number | null, envMax: number, envPriority: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (baseFee !== null && baseFee > 0) {
    const safe = Math.ceil((baseFee * 1.1 + envPriority) * 100) / 100;
    const fast = Math.ceil((baseFee * 1.3 + envPriority) * 100) / 100;
    const agg = Math.ceil((baseFee * 1.6 + envPriority) * 100) / 100;
    kb.text(`🟢 Safe (${safe}g)`, `gas_preset_${safe}_${envPriority}`)
      .text(`⚡ Fast (${fast}g)`, `gas_preset_${fast}_${envPriority}`)
      .row()
      .text(`🔥 Aggressive (${agg}g)`, `gas_preset_${agg}_${envPriority}`)
      .text(`🔄 Refresh Fee`, "gas_refresh")
      .row();
  }
  kb.text("⬅️ Back", "nav_back").text("🗑 Cancel", "cmd_cancel");
  return kb;
}

function timingKeyboard(startsInFuture: boolean, startTime: Date): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (startsInFuture) {
    kb.text("⏳ Wait for Stage Open", "timing_wait");
  } else {
    kb.text("🚀 Fire Immediately", "timing_now");
  }
  kb.text("🕐 Custom Time", "timing_custom").row();
  kb.text("🔄 Refresh Mint Price", "price_refresh").row();
  kb.text("⬅️ Back", "nav_back").text("🗑 Cancel", "cmd_cancel");
  return kb;
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🚀 FIRE MINT NOW", "confirm_yes")
    .row()
    .text("⬅️ Back", "nav_back")
    .text("❌ Abort & Clear", "confirm_no");
}

function yesNoKeyboard(callbackPrefix: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Yes", `${callbackPrefix}_yes`)
    .text("❌ No", `${callbackPrefix}_no`)
    .row()
    .text("⬅️ Back", "nav_back");
}

function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Start New Mint", "cmd_mint")
    .text("📊 Status", "cmd_status")
    .row()
    .text("❓ Help", "cmd_help");
}

function errorKeyboard(callback: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Retry", callback)
    .text("⬅️ Back", "nav_back")
    .text("🗑 Cancel", "cmd_cancel");
}

// ============================================
// Navigation
// ============================================

function goBack(ctx: MyContext): void {
  const s = ctx.session;
  switch (s.step) {
    case "target_chain_confirm":
    case "target_address_confirm":
    case "target_chain_confirm_slug":
      s.step = "target";
      return;
    case "rpc_verify_confirm":
      s.step = "rpc";
      return;
    case "timing_custom":
      s.step = "timing";
      return;
  }
  const currentIdx = STEP_ORDER.indexOf(s.step);
  if (currentIdx > 0) {
    s.step = STEP_ORDER[currentIdx - 1];
  } else {
    s.step = "idle";
  }
}

async function sendStepHeader(ctx: MyContext, title: string, body: string, keyboard: InlineKeyboard): Promise<void> {
  const s = ctx.session;
  const progress = progressBar(s.step);
  const summary = stepSummary(s);
  let msg = `<b>${title}</b>\n${progress}\n`;
  if (summary) msg += `\n${summary}\n`;
  msg += `\n${body}`;
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
}

async function editStepHeader(ctx: MyContext, title: string, body: string, keyboard: InlineKeyboard): Promise<void> {
  const s = ctx.session;
  const progress = progressBar(s.step);
  const summary = stepSummary(s);
  let msg = `<b>${title}</b>\n${progress}\n`;
  if (summary) msg += `\n${summary}\n`;
  msg += `\n${body}`;
  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
}

// ============================================
// Command Handlers
// ============================================

bot.command("start", async (ctx) => {
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.reply(
    "🎯 <b>NFT Public Mint Sniper</b>\n\n" +
    "Mints public SeaDrop stages directly from chain — no OpenSea token needed.\n\n" +
    "Tap <b>Start New Mint</b> to begin.",
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
  );
});

bot.command("mint", async (ctx) => {
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await startKeysStep(ctx);
});

bot.command("status", async (ctx) => {
  const s = ctx.session;
  if (s.step === "idle") {
    await ctx.reply("No active mint session. Use /mint to start.", { reply_markup: mainMenuKeyboard() });
    return;
  }
  await ctx.reply(`📋 <b>Current Session Summary</b>\n\n${progressBar(s.step)}\n\n${stepSummary(s)}`, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
});

bot.command("cancel", async (ctx) => {
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.reply("❌ Session cancelled and keys scrubbed. Use /mint to start over.", { reply_markup: mainMenuKeyboard() });
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "💡 <b>NFT Public Mint Sniper Guide</b>\n\n" +
    "<b>Commands:</b>\n" +
    "/mint — Start interactive setup\n" +
    "/status — View current configuration\n" +
    "/cancel — Cancel and scrub memory\n" +
    "/help — Show this guide\n\n" +
    "<b>Privacy & Security:</b>\n" +
    "• Private key messages are deleted immediately after receipt.\n" +
    "• Keys exist only in active RAM — never logged or stored to disk.\n" +
    "• Sessions automatically expire after 15 minutes of inactivity.",
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
  );
});

// ============================================
// Navigation & Action Callback Handlers
// ============================================

bot.callbackQuery("nav_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  goBack(ctx);
  const s = ctx.session;
  switch (s.step) {
    case "keys": await startKeysStep(ctx); break;
    case "chain": await sendChainStep(ctx); break;
    case "quantity": await sendQuantityStep(ctx); break;
    case "target": await sendTargetStep(ctx); break;
    case "rpc": await proceedToRpcStep(ctx); break;
    case "gas": await proceedToGasStep(ctx); break;
    case "timing": await sendTimingStep(ctx); break;
    case "confirm": await showConfirmStep(ctx); break;
    default: await ctx.reply("Use /mint to start.", { reply_markup: mainMenuKeyboard() });
  }
});

bot.callbackQuery("cmd_cancel", async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.reply("❌ Session cancelled and memory scrubbed. Use /mint to start over.", { reply_markup: mainMenuKeyboard() });
});

bot.callbackQuery("cmd_mint", async (ctx) => {
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.answerCallbackQuery();
  await startKeysStep(ctx);
});

bot.callbackQuery("keys_done", async (ctx) => {
  const s = ctx.session;
  if (s.walletKeys.length === 0) {
    await ctx.answerCallbackQuery("Need at least 1 key");
    await ctx.reply("❌ Need at least one valid key. Send a key or press Cancel.", { reply_markup: keysKeyboard(false) });
    return;
  }
  await ctx.answerCallbackQuery(`Loaded ${s.walletKeys.length} wallet(s)`);
  await cleanupKeyMessages(ctx);
  if (s.pendingFastLink) {
    // Fast path: chain already detected from the pasted link.
    s.step = "quantity";
    await ctx.reply(`✅ Loaded ${s.walletKeys.length} wallet(s).`);
    await sendQuantityStep(ctx);
    return;
  }
  s.step = "chain";
  await ctx.reply(`✅ Loaded ${s.walletKeys.length} wallet(s).`);
  await sendChainStep(ctx);
});

bot.callbackQuery("cmd_status", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = ctx.session;
  if (s.step === "idle") {
    await ctx.reply("No active mint session. Use /mint to start.", { reply_markup: mainMenuKeyboard() });
    return;
  }
  await ctx.reply(`📋 <b>Current Session Summary</b>\n\n${progressBar(s.step)}\n\n${stepSummary(s)}`, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
});

bot.callbackQuery("cmd_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "💡 <b>NFT Public Mint Sniper Guide</b>\n\n" +
    "<b>Commands:</b>\n" +
    "/mint — Start interactive setup\n" +
    "/status — View current configuration\n" +
    "/cancel — Cancel and scrub memory\n" +
    "/help — Show this guide\n\n" +
    "<b>Privacy & Security:</b>\n" +
    "• Private key messages are deleted immediately after receipt.\n" +
    "• Keys exist only in active RAM — never logged or stored to disk.\n" +
    "• Sessions automatically expire after 15 minutes of inactivity.",
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
  );
});

bot.callbackQuery(/^chain_(.+)$/, async (ctx) => {
  const chainKey = ctx.match[1];
  const chain = resolveChain(chainKey);
  if (!chain) { await ctx.answerCallbackQuery("Invalid chain"); return; }
  ctx.session.chainKey = chainKey;
  ctx.session.step = "quantity";
  await ctx.answerCallbackQuery(`Selected ${chain.name}`);
  await sendQuantityStep(ctx);
});

bot.callbackQuery(/^qty_(\d+)$/, async (ctx) => {
  const qty = parseInt(ctx.match[1], 10);
  ctx.session.quantity = qty;
  await ctx.answerCallbackQuery(`Quantity: ${qty}`);
  const s = ctx.session;
  if (s.pendingFastLink) {
    // Fast path — resolve the stored link, skipping the target prompt.
    const link = s.pendingFastLink;
    s.pendingFastLink = undefined;
    s.step = "target";
    await handleTargetStep(ctx, link);
    return;
  }
  ctx.session.step = "target";
  await sendTargetStep(ctx);
});

bot.callbackQuery("qty_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  await editStepHeader(ctx, "🔢 Quantity", "Send custom quantity (1-100):", new InlineKeyboard().text("⬅️ Back", "nav_back"));
  ctx.session.step = "quantity";
});

bot.callbackQuery("rpc_use_env", async (ctx) => {
  await ctx.answerCallbackQuery("Checking .env RPCs…");
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  const fromEnv = privateRpcsFromEnv(chainProfile.key);
  await processAndApplyRpcs(ctx, fromEnv);
});

bot.callbackQuery("rpc_use_public", async (ctx) => {
  await ctx.answerCallbackQuery("Using public RPC endpoints…");
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  const publicUrls = chainProfile.rpc.public ?? [];
  await processAndApplyRpcs(ctx, publicUrls);
});

bot.callbackQuery(/^gas_preset_([\d.]+)_([\d.]+)$/, async (ctx) => {
  const maxFee = parseFloat(ctx.match[1]);
  const priority = parseFloat(ctx.match[2]);
  const s = ctx.session;
  s.maxFeeGwei = maxFee;
  s.priorityGwei = priority;
  s.gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;
  await ctx.answerCallbackQuery(`Gas preset: ${maxFee} / ${priority} gwei`);
  await sendTimingStep(ctx);
});

bot.callbackQuery("gas_refresh", async (ctx) => {
  await ctx.answerCallbackQuery("Refreshing base fee…");
  await proceedToGasStep(ctx);
});

bot.callbackQuery("price_refresh", async (ctx) => {
  await ctx.answerCallbackQuery("Re-reading mint price from chain…");
  await sendTimingStep(ctx);
});

bot.callbackQuery(/^timing_(.+)$/, async (ctx) => {
  const pick = ctx.match[1];
  const s = ctx.session;
  const startTimeSec = s.mintPlan?.drop.startTime ?? 0;
  const startsInFuture = startTimeSec * 1000 > Date.now();
  const at = new Date(startTimeSec * 1000);

  if (pick === "wait" && startsInFuture) {
    s.targetStart = at;
    s.timingLabel = `wait for stage — ${toIST(at)} IST`;
  } else if (pick === "now" && !startsInFuture) {
    s.targetStart = null;
    s.timingLabel = "fire immediately";
  } else if (pick === "custom") {
    await ctx.answerCallbackQuery();
    await editStepHeader(ctx, "⏰ Custom Time", "Send time in <b>HH:MM</b> format (24-hour IST, today):", new InlineKeyboard().text("⬅️ Back", "nav_back"));
    s.step = "timing_custom";
    return;
  } else {
    await ctx.answerCallbackQuery("Invalid option for current stage state");
    return;
  }

  s.step = "confirm";
  await ctx.answerCallbackQuery();
  await showConfirmStep(ctx);
});

bot.callbackQuery("confirm_yes", async (ctx) => {
  await ctx.answerCallbackQuery("Firing…");
  await executeMint(ctx);
});

bot.callbackQuery("confirm_no", async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.editMessageText("❌ Session cancelled and memory scrubbed. Use /mint to start over.", { reply_markup: mainMenuKeyboard() });
});

// Yes/No confirmation handlers
bot.callbackQuery(/^confirm_(.+)_(yes|no)$/, async (ctx) => {
  const [, type, answer] = ctx.match;
  await ctx.answerCallbackQuery();

  if (answer === "no") {
    await handleNo(ctx, type);
    return;
  }

  switch (type) {
    case "chain_switch":
      await handleChainSwitchYes(ctx);
      break;
    case "address_checksum":
      await handleAddressChecksumYes(ctx);
      break;
    case "slug_chain_switch":
      await handleSlugChainSwitchYes(ctx);
      break;
    case "rpc_verify":
      await handleRpcVerifyYes(ctx);
      break;
    case "rpc_single":
      await handleRpcSingleYes(ctx);
      break;
    case "timing_early":
      await handleTimingEarlyYes(ctx);
      break;
  }
});

async function handleNo(ctx: MyContext, type: string) {
  const s = ctx.session;
  switch (type) {
    case "chain_switch":
    case "address_checksum":
    case "slug_chain_switch":
      await ctx.editMessageText("OK, send a different link/address:");
      s.step = "target";
      delete s.pendingTarget;
      delete s.pendingAddress;
      delete s.pendingChain;
      delete s.pendingContract;
      delete s.pendingLabel;
      break;
    case "rpc_verify":
      await ctx.editMessageText("Send different RPC endpoints:");
      s.step = "rpc";
      break;
    case "rpc_single":
      // Accept the single-endpoint risk and continue to gas setup.
      await ctx.editMessageText("⚠️ Proceeding with 1 endpoint — single point of failure at fire time.");
      await proceedToGasStep(ctx);
      break;
    case "timing_early":
      delete s.pendingCustomTime;
      await ctx.editMessageText("Send time in <b>HH:MM</b> format (24-hour IST, today):", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Back", "nav_back") });
      s.step = "timing_custom";
      break;
  }
}

bot.callbackQuery("sweep_start", async (ctx) => {
  const s = ctx.session;
  if (s.step !== "sweep" || !s.lastMintReport) { await ctx.answerCallbackQuery("No mint results"); return; }
  await ctx.answerCallbackQuery();
  s.sweepStep = "address";
  await ctx.reply(
    `📤 <b>Sweep Minted NFTs</b>\nSend the <b>destination address</b> (0x…).\n\nWallets that ARE the destination are skipped automatically (NFTs already there).`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑 Cancel", "sweep_skip") }
  );
});

bot.callbackQuery("sweep_skip", async (ctx) => {
  await ctx.answerCallbackQuery("Session finished");
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
  await ctx.reply("✅ Session closed. Use /mint to start another.", { reply_markup: mainMenuKeyboard() });
});

bot.callbackQuery("sweep_confirm_yes", async (ctx) => {
  const s = ctx.session;
  if (s.step !== "sweep" || !s.lastMintReport || !s.pendingAddress) { await ctx.answerCallbackQuery("No sweep pending"); return; }
  await ctx.answerCallbackQuery("Sweeping…");
  const dest = s.pendingAddress;
  await ctx.reply(`📤 <b>Sweeping NFTs to ${shortAddr(dest)}…</b>`, { parse_mode: "HTML" });

  try {
    const results = await sweepMintedNfts({
      nftContract: s.nftContract!,
      rpcUrl: s.rpcUrls![0],
      to: dest,
      walletKeys: s.walletKeys,
      report: s.lastMintReport,
      maxFeePerGas: gweiToWei(s.maxFeeGwei!),
      maxPriorityFee: gweiToWei(s.priorityGwei!),
      gasLimit: s.gasLimit!,
    });

    const explorer = resolveChain(s.chainKey!)?.explorer ?? "";
    let msg = `📦 <b>Sweep Complete</b>\n`;
    for (const r of results) {
      if (r.sent > 0) {
        msg += `\n✅ [W${r.idx}] <code>${shortAddr(r.wallet)}</code> — ${r.sent} NFT(s) sent`;
        for (const h of r.txHashes) msg += `\n     🔗 <a href="${explorer}/tx/${h}">${shortAddr(h)}</a>`;
      } else {
        msg += `\n⏭️ [W${r.idx}] <code>${shortAddr(r.wallet)}</code> — skipped (${escapeHtml(sanitizeOutput(r.error ?? "no NFTs"))})`;
      }
    }
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
  } catch (err: any) {
    await ctx.reply(`❌ <b>Sweep Failed:</b> ${sanitizeOutput(err.message)}`, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
  }
  await cleanupKeyMessages(ctx);
  ctx.session = initialSession();
});

bot.callbackQuery("sweep_confirm_no", async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  ctx.session = initialSession();
  await ctx.reply("Sweep cancelled. Session closed — use /mint to start another.", { reply_markup: mainMenuKeyboard() });
});

// ============================================
// Message Handler
// ============================================

bot.on("message:text", async (ctx) => {
  const s = ctx.session;
  const text = ctx.message.text.trim();

  // Fast path: paste an OpenSea link (or contract address) while idle — no
  // /mint needed. Chain is detected from the URL, the target auto-resolves
  // after quantity selection, and the user goes straight to key entry.
  if (s.step === "idle" && /opensea\.io\//i.test(text)) {
    let parsed;
    try {
      parsed = parseNftLink(text);
    } catch (err: any) {
      await ctx.reply(`❌ ${sanitizeOutput(err.message)}\nUse /mint for the full setup flow.`);
      return;
    }
    const hinted = parsed.chainHint ? resolveChain(parsed.chainHint) : null;
    if (!hinted) {
      // Slug links (opensea.io/collection/<slug>) carry no chain segment —
      // fall back to resolving the slug via OpenSea's API, which reports the
      // collection's chain. If that fails, ask for an item URL instead.
      if (parsed.kind === "slug") {
        const apiKey = (process.env.OPENSEA_API_KEY || "").trim();
        try {
          await ctx.reply(`🔎 Resolving collection "${escapeHtml(parsed.value)}"…`);
          const info = await resolveSlug(parsed.value, apiKey || undefined);
          const slugChain = info.chain ? resolveChain(info.chain) : null;
          if (!slugChain) throw new Error(`collection is on "${info.chain || "unknown chain"}" — not supported here`);
          s.chainKey = slugChain.key;
          s.pendingFastLink = text;
          s.walletKeys = [];
          s.keyMessageIds = [];
          s.step = "keys";
          await ctx.reply(
            `⚡ <b>Fast Mint</b>\n🔗 Chain detected: <b>${escapeHtml(slugChain.name)}</b> (ID ${slugChain.chainId})\n🎯 Target: ${escapeHtml(info.name || parsed.value)}\n\n` +
            `Now send your <b>private key(s)</b> (one per line).\n🔒 Key messages are auto-deleted immediately. Tap <b>Done</b> when finished.`,
            { parse_mode: "HTML", reply_markup: keysKeyboard(false) }
          );
          return;
        } catch (err: any) {
          await ctx.reply(
            `❌ Could not detect the chain from a slug link (${sanitizeOutput(err.message)}).\nPaste the <b>item</b> URL instead: opensea.io/item/&lt;chain&gt;/0x…/&lt;id&gt;`
          );
          return;
        }
      }
      await ctx.reply(
        `❌ Could not detect the chain from that link${parsed.chainHint ? ` ("${escapeHtml(parsed.chainHint)}" is unsupported here)` : ""}.\nSupported: ${CHAINS.map(c => c.name).join(", ")}.`
      );
      return;
    }
    s.chainKey = hinted.key;
    s.pendingFastLink = text; // re-parsed after keys — target resolves post-quantity
    s.walletKeys = [];
    s.keyMessageIds = [];
    s.step = "keys";
    await ctx.reply(
      `⚡ <b>Fast Mint</b>\n🔗 Chain detected from link: <b>${escapeHtml(hinted.name)}</b> (ID ${hinted.chainId})\n🎯 Target: ${escapeHtml(parsed.kind === "slug" ? parsed.value : shortAddr(parsed.value))}\n\n` +
      `Now send your <b>private key(s)</b> (one per line).\n🔒 Key messages are auto-deleted immediately. Tap <b>Done</b> when finished.`,
      { parse_mode: "HTML", reply_markup: keysKeyboard(false) }
    );
    return;
  }

  // Custom quantity input
  if (s.step === "quantity") {
    if (!/^\d+$/.test(text)) {
      await ctx.reply("❌ Enter a valid quantity number (1-100).");
      return;
    }
    const qty = parseInt(text, 10);
    if (isNaN(qty) || qty < 1 || qty > 100) {
      await ctx.reply("❌ Enter a valid quantity number (1-100).");
      return;
    }
    s.quantity = qty;
    if (s.pendingFastLink) {
      // Fast path — resolve the stored link now, skipping the target prompt.
      const link = s.pendingFastLink;
      s.pendingFastLink = undefined;
      s.step = "target";
      await handleTargetStep(ctx, link);
      return;
    }
    s.step = "target";
    await sendTargetStep(ctx);
    return;
  }

  // Custom time input
  if (s.step === "timing_custom") {
    try {
      const custom = istTimeToDate(text);
      const startTimeSec = s.mintPlan?.drop.startTime ?? 0;
      if (custom.getTime() < startTimeSec * 1000) {
        s.pendingCustomTime = custom;
        await ctx.reply(
          `⚠️ That is before the stage opens (${toIST(new Date(startTimeSec * 1000))} IST) — it will revert.\nProceed anyway?`,
          { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_timing_early") }
        );
        return;
      }
      s.targetStart = custom;
      s.timingLabel = `custom — ${toIST(custom)} IST`;
      s.step = "confirm";
      await showConfirmStep(ctx);
    } catch (err: any) {
      await ctx.reply(`❌ ${sanitizeOutput(err.message)}\nTry again (HH:MM IST):`, { reply_markup: new InlineKeyboard().text("⬅️ Back", "nav_back") });
    }
    return;
  }

  // Gas input (single message: "max priority" or just "max")
  if (s.step === "gas") {
    const parts = text.split(/\s+/).map(p => parseFloat(p)).filter(n => !isNaN(n));
    if (parts.length === 0) {
      await ctx.reply("❌ Enter max fee and priority fee (e.g. \"2 0.05\" or select a preset below).");
      return;
    }
    const maxFee = parts[0];
    const priority = parts[1] ?? Math.min(0.05, maxFee);

    const provider = makeProvider(s.rpcUrls![0]);
    const baseFeeGwei = await currentBaseFeeGwei(provider);

    if (baseFeeGwei !== null && maxFee < baseFeeGwei) {
      await ctx.reply(`❌ Max fee must be at least ${baseFeeGwei.toFixed(6)} gwei (current base fee).`);
      return;
    }
    if (priority > maxFee) {
      await ctx.reply(`❌ Priority fee cannot exceed max fee.`);
      return;
    }

    s.maxFeeGwei = maxFee;
    s.priorityGwei = priority;
    s.gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

    await sendTimingStep(ctx);
    return;
  }

  // Sweep destination address input
  if (s.step === "sweep" && s.sweepStep === "address") {
    const normalized = normalizeAddress(text);
    if (!normalized) {
      await ctx.reply("❌ Not a valid address (0x…). Try again or press Cancel.");
      return;
    }
    const dest = normalized.address;
    const report = s.lastMintReport!;
    const successWallets = report.filter(r => r.status === "SUCCESS");
    const skipped = successWallets.filter(r => r.address.toLowerCase() === dest.toLowerCase()).length;

    let confirmMsg = `📤 <b>Sweep Confirmation</b>\nTo: <code>${dest}</code>\nFrom: ${successWallets.length - skipped} successful wallet(s)`;
    if (skipped > 0) confirmMsg += `\n⏭️ ${skipped} wallet(s) ARE the destination — skipped (no tx needed)`;
    confirmMsg += `\n\nEach NFT is one safeTransferFrom tx (gas per tx). Execute?`;
    s.pendingAddress = dest;
    await ctx.reply(confirmMsg, { parse_mode: "HTML", reply_markup: yesNoKeyboard("sweep_confirm") });
    return;
  }

  // Step handlers
  if (s.step === "keys") {
    await handleKeysStep(ctx, text);
    return;
  }
  if (s.step === "target") {
    await handleTargetStep(ctx, text);
    return;
  }
  if (s.step === "rpc") {
    await handleRpcStep(ctx, text);
    return;
  }

  // Unknown state
  await ctx.reply("Use /mint to start a new session.", { reply_markup: mainMenuKeyboard() });
});

// ============================================
// Step Implementations
// ============================================

async function cleanupKeyMessages(ctx: MyContext) {
  const s = ctx.session;
  if (s?.keyMessageIds && s.keyMessageIds.length > 0) {
    for (const msgId of s.keyMessageIds) {
      try { await ctx.api.deleteMessage(ctx.chat!.id, msgId); } catch {}
    }
  }
  if (s) s.keyMessageIds = [];
}

async function startKeysStep(ctx: MyContext) {
  const s = ctx.session;
  s.step = "keys";
  s.walletKeys = [];
  s.keyMessageIds = [];
  await sendStepHeader(ctx,
    "🔐 Step 1: Private Keys",
    "Send private keys (one per line or one per message).\n\n" +
    "🔒 <b>Security & Privacy Guarantee:</b>\n" +
    "• Key messages are auto-deleted immediately from chat.\n" +
    "• Keys exist only in RAM during execution — never saved.\n\n" +
    "Tap <b>Done (Continue to Chain)</b> below when finished (minimum 1 key).",
    keysKeyboard(false)
  );
}

async function handleKeysStep(ctx: MyContext, text: string) {
  const s = ctx.session;
  
  // Track & immediately delete user message containing private key
  if (ctx.message?.message_id) {
    (s.keyMessageIds ??= []).push(ctx.message.message_id);
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id);
    } catch {}
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // "done" on a line of its own finishes the step
  const doneLine = lines.find(l => l.toLowerCase() === "done");
  if (doneLine && s.walletKeys.length === 0) {
    await ctx.reply("❌ Need at least one valid key. Send a key or press Cancel.", { reply_markup: keysKeyboard(false) });
    return;
  }

  let added = 0, dupes = 0, invalid = 0;
  for (const raw of lines) {
    if (raw.toLowerCase() === "done") continue;

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      invalid++;
      continue;
    }

    const dup = s.walletKeys.some(k => new Wallet(k).address.toLowerCase() === wallet.address.toLowerCase());
    if (dup) {
      dupes++;
      continue;
    }

    s.walletKeys.push(normalized);
    added++;
  }

  // One summary per message instead of one reply per key — bulk paste stays fast.
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`✅ Added ${added} wallet(s):`);
    parts.push(...s.walletKeys.slice(-added).map((k, i) =>
      `<b>[W${s.walletKeys.length - added + i}]</b> <code>${new Wallet(k).address}</code>`));
  }
  if (dupes > 0) parts.push(`⚠️ ${dupes} duplicate(s) skipped`);
  if (invalid > 0) parts.push(`❌ ${invalid} invalid line(s) skipped`);

  if (parts.length > 0) {
    await ctx.reply(parts.join("\n"), { parse_mode: "HTML", reply_markup: keysKeyboard(s.walletKeys.length > 0) });
  }

  if (doneLine) {
    await cleanupKeyMessages(ctx);
    if (s.pendingFastLink) {
      // Fast path: chain already detected from the pasted link — skip the
      // chain picker and go straight to quantity.
      s.step = "quantity";
      await ctx.reply(`✅ Loaded ${s.walletKeys.length} wallet(s).`);
      await sendQuantityStep(ctx);
      return;
    }
    s.step = "chain";
    await ctx.reply(`✅ Loaded ${s.walletKeys.length} wallet(s).`);
    await sendChainStep(ctx);
  }
}

async function sendChainStep(ctx: MyContext) {
  await sendStepHeader(ctx,
    "🔗 Step 2: Chain",
    "Select the EVM target network for this mint:",
    chainKeyboard()
  );
}

async function sendQuantityStep(ctx: MyContext) {
  const defaultQty = 1;
  await sendStepHeader(ctx,
    "🔢 Step 3: Quantity",
    `Select NFTs to mint per wallet [default: ${defaultQty}]:\nTap a button or enter a custom amount (1-100):`,
    quantityKeyboard()
  );
}

async function sendTargetStep(ctx: MyContext) {
  await sendStepHeader(ctx,
    "🎯 Step 4: NFT Target",
    "Paste an OpenSea collection link, item URL, collection slug, or contract address (0x…):",
    new InlineKeyboard().text("⬅️ Back", "nav_back").text("🗑 Cancel", "cmd_cancel")
  );
}

async function handleTargetStep(ctx: MyContext, text: string) {
  const s = ctx.session;
  let parsed;
  try {
    parsed = parseNftLink(text);
  } catch (err: any) {
    await ctx.reply(`❌ ${sanitizeOutput(err.message)}`);
    return;
  }

  let activeChain = s.chainKey!;

  // Chain hint check
  if (parsed.chainHint && parsed.chainHint !== activeChain && resolveChain(parsed.chainHint)) {
    const hinted = resolveChain(parsed.chainHint)!;
    s.pendingTarget = parsed;
    await ctx.reply(
      `⚠️ Link targets <b>${escapeHtml(hinted.name)}</b>, but session is set to <b>${escapeHtml(resolveChain(activeChain)!.name)}</b>.\nSwitch chain to ${escapeHtml(hinted.name)}?`,
      { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_chain_switch") }
    );
    s.step = "target_chain_confirm";
    return;
  }

  if (parsed.kind === "address") {
    const normalized = normalizeAddress(parsed.value);
    if (!normalized) {
      await ctx.reply(`❌ "${escapeHtml(parsed.value)}" is not a valid 20-byte EVM address.`);
      return;
    }
    if (normalized.checksumWarning) {
      s.pendingAddress = normalized.address;
      await ctx.reply(
        `⚠️ Mixed-case address with invalid checksum — possible typo.\nUse anyway?`,
        { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_address_checksum") }
      );
      s.step = "target_address_confirm";
      return;
    }
    s.nftContract = normalized.address;
    s.nftLabel = shortAddr(normalized.address);
    s.chainKey = activeChain;
    await proceedToRpcStep(ctx);
    return;
  }

  // Slug resolution
  const apiKey = (process.env.OPENSEA_API_KEY || "").trim();
  try {
    await ctx.reply(`Resolving collection "${escapeHtml(parsed.value)}"${apiKey ? "" : " (public API lookup)"}...`);
    const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
    const resolved = normalizeAddress(info.contractAddress);
    if (!resolved) {
      await ctx.reply(`❌ Unusable address returned: ${escapeHtml(info.contractAddress)}`);
      return;
    }
    s.nftContract = resolved.address;
    s.nftLabel = info.name || parsed.value;
    if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
      s.pendingChain = info.chain;
      s.pendingTarget = parsed;
      s.pendingContract = resolved.address;
      s.pendingLabel = info.name || parsed.value;
      await ctx.reply(
        `⚠️ Collection listed on "<b>${escapeHtml(info.chain)}</b>", not "<b>${escapeHtml(activeChain)}</b>".\nSwitch chain to ${escapeHtml(resolveChain(info.chain)!.name)}?`,
        { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_slug_chain_switch") }
      );
      s.step = "target_chain_confirm_slug";
      return;
    }
    await proceedToRpcStep(ctx);
  } catch (err: any) {
    await ctx.reply(
      `❌ ${sanitizeOutput(err.message)}\n\n` +
      `Paste the raw contract address (0x…) instead.`,
      { reply_markup: new InlineKeyboard().text("⬅️ Back", "nav_back") }
    );
  }
}

async function proceedToRpcStep(ctx: MyContext) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  s.step = "rpc";

  const fromEnv = privateRpcsFromEnv(chainProfile.key);
  let msg = `🌐 <b>Step 5: RPC Endpoints for ${escapeHtml(chainProfile.name)}</b>\n\n`;
  msg += "Private RPCs (Alchemy / QuickNode / Infura) provide high-speed execution.\n";
  if (chainProfile.rpc.alchemyHost) {
    msg += `Paste full URL or key → https://${chainProfile.rpc.alchemyHost}/v2/<code>key</code>\n`;
  }
  msg += "Comma-separate multiple endpoints for RPC blasting.\n\n";
  if (fromEnv.length > 0) {
    msg += `📄 <b>.env RPCs found:</b> ${fromEnv.map(u => escapeHtml(maskRpc(u) ?? u)).join(", ")}\n`;
  } else {
    msg += `⚠️ No private RPCs in .env for ${escapeHtml(chainProfile.name)}.\n`;
  }

  const hasPublicEndpoints = (chainProfile.rpc.public?.length ?? 0) > 0;
  if (!fromEnv.length && hasPublicEndpoints) {
    msg += `\n🔗 <b>Public endpoints:</b> ${chainProfile.rpc.public.map(u => `<code>${escapeHtml(u)}</code>`).join(", ")}`;
  }

  await sendStepHeader(ctx, "🌐 Step 5: RPC Setup", msg, rpcKeyboard(fromEnv.length > 0, hasPublicEndpoints));
}

async function processAndApplyRpcs(ctx: MyContext, manualUrls: string[]) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  const { urls: candidateRpcs } = resolveRpcsForChain(s.chainKey!, manualUrls);
  const preferred = privateRpcsFromEnv(chainProfile.key);

  await ctx.reply(`Probing ${candidateRpcs.length} RPC endpoint(s)...`);
  const plan = await planRpcs(candidateRpcs, chainProfile.chainId, preferred);

  // ponytail: single batched report instead of one reply per endpoint — faster flow, less chat noise
  const lines: string[] = [];
  for (const badEp of plan.dropped) {
    const wrong = resolveChain(badEp.chainId);
    lines.push(`✗ <code>${escapeHtml(badEp.url)}</code> is on chain ${badEp.chainId}${wrong ? ` (${escapeHtml(wrong.name)})` : ""} — dropped`);
  }
  for (const ep of parseRpcEndpoints(plan.urls)) {
    const failure = plan.failures.find(f => f.url === ep.url);
    if (failure) {
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
      lines.push(`${benign ? "•" : "⚠"} ${escapeHtml(ep.label)}  ${escapeHtml(failure.message.slice(0, 90))}`);
    } else {
      lines.push(`✅ ${escapeHtml(ep.label)}`);
    }
  }
  await ctx.reply(`🔎 <b>RPC Probe Results (${plan.urls.length} usable):</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });

  if (plan.urls.length === 0) {
    await ctx.reply(`❌ No usable RPC endpoint for ${escapeHtml(chainProfile.name)}.`, { reply_markup: errorKeyboard("rpc") });
    s.step = "rpc";
    return;
  }

  s.rpcUrls = plan.urls;

  // War-readiness gate: a single live endpoint is a single point of failure —
  // in the inkopus war one congested gateway dropped 7/11 txs on the floor.
  const blastable = plan.urls.length;
  if (plan.verified && blastable === 1) {
    await ctx.reply(
      `⚠️ <b>Only 1 usable endpoint (${escapeHtml(parseRpcEndpoints(plan.urls)[0].label)}).</b>\n` +
      `In a mint war this is a single point of failure — if it rate-limits or times out at T-0, txs never broadcast.\n\n` +
      `Add more endpoints? (paste comma-separated URLs, or pick "Use Public RPC")`,
      { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_rpc_single") }
    );
    s.step = "rpc_verify_confirm";
    return;
  }

  if (!plan.verified) {
    await ctx.reply(
      `⚠️ No endpoint confirmed chain id ${chainProfile.chainId}.\nContinue anyway?`,
      { parse_mode: "HTML", reply_markup: yesNoKeyboard("confirm_rpc_verify") }
    );
    s.step = "rpc_verify_confirm";
    return;
  }

  await ctx.reply(`✅ Confirmed Chain ID ${chainProfile.chainId} (${escapeHtml(chainProfile.name)})`);
  await proceedToGasStep(ctx);
}

async function handleRpcStep(ctx: MyContext, text: string) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;

  if (!text.trim()) {
    const fromEnv = privateRpcsFromEnv(chainProfile.key);
    await processAndApplyRpcs(ctx, fromEnv);
    return;
  }

  const parts = text.split(",").map(s => s.trim()).filter(Boolean);
  const urls: string[] = [];
  let bad = false;
  for (const part of parts) {
    const url = toRpcUrl(part, chainProfile.key);
    if (!url) {
      await ctx.reply(`❌ "${escapeHtml(part)}" is not a valid URL or API key.`, { reply_markup: errorKeyboard("rpc") });
      bad = true;
      break;
    }
    urls.push(url);
  }
  if (bad || urls.length === 0) return;

  for (const url of urls) await ctx.reply(`✅ ${escapeHtml(maskRpc(url) ?? url)}`);

  await processAndApplyRpcs(ctx, urls);
}

async function proceedToGasStep(ctx: MyContext) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  if (!s.rpcUrls || s.rpcUrls.length === 0) {
    await ctx.reply(`❌ No active RPC endpoints set for ${escapeHtml(chainProfile.name)}.`, { reply_markup: new InlineKeyboard().text("⬅️ Back", "nav_back") });
    s.step = "rpc";
    return;
  }

  const provider = makeProvider(s.rpcUrls[0]);

  // Build mint plan from on-chain SeaDrop data
  let maxMintPrice = 0n;
  const rawMaxPrice = process.env.MAX_MINT_PRICE_ETH;
  if (rawMaxPrice && rawMaxPrice.trim() !== "") {
    try { maxMintPrice = parseEther(rawMaxPrice.trim()); } catch {}
  }

  let mintPlan: LocalMintPlan | null = null;
  try {
    mintPlan = await buildLocalMintPlan(s.rpcUrls[0], s.nftContract!, s.quantity!, maxMintPrice);
    // Clamp to the drop's per-wallet cap up front — a pre-signed tx with qty
    // above the cap is a guaranteed revert and burns every wallet's FCFS slot.
    if (mintPlan) {
      const cap = mintPlan.drop.maxTotalMintableByWallet;
      if (cap > 0 && s.quantity! > cap) {
        const oldQty = s.quantity!;
        s.quantity = cap;
        mintPlan = await buildLocalMintPlan(s.rpcUrls[0], s.nftContract!, s.quantity, maxMintPrice);
        await ctx.reply(
          `⚠️ Quantity clamped <b>${oldQty} → ${cap}</b> per wallet (on-chain per-wallet cap).`,
          { parse_mode: "HTML" }
        );
      }
    }
  } catch (err: any) {
    await ctx.reply(`❌ Failed to query drop on-chain: ${sanitizeOutput(err.message)}`, { reply_markup: new InlineKeyboard().text("⬅️ Back to Target", "nav_back") });
    s.step = "target";
    return;
  }

  if (!mintPlan) {
    await ctx.reply(
      `❌ No SeaDrop public drop readable for <code>${escapeHtml(s.nftContract!)}</code> on ${escapeHtml(chainProfile.name)}.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Back to Target", "nav_back") }
    );
    s.step = "target";
    return;
  }
  s.mintPlan = mintPlan;

  // Early check: if collection is already minted out (sold out) on-chain, stop setup immediately
  const dummyWallet = s.walletKeys.length > 0 ? new Wallet(s.walletKeys[0]).address : "0x0000000000000000000000000000000000000000";
  try {
    const mintStatus = await fetchMintStatus(s.rpcUrls[0], s.nftContract!, mintPlan, dummyWallet);
    if (mintStatus.mintedOut) {
      const supplyInfo = `totalSupply ${mintStatus.totalSupply ?? "?"}${mintStatus.maxSupply !== null ? ` / ${mintStatus.maxSupply}` : ""}`;
      await ctx.reply(
        `🚫 <b>Collection Sold Out On-Chain!</b>\n\n` +
        `Target: <b>${escapeHtml(s.nftLabel ?? "")}</b>\n` +
        `Contract: <code>${escapeHtml(s.nftContract!)}</code>\n` +
        `Supply Status: <b>${escapeHtml(supplyInfo)}</b>\n\n` +
        `This stage is already fully minted out. Setup stopped — no further action required.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🎯 Change Target", "nav_back")
            .text("🔄 Start New Mint", "cmd_mint"),
        }
      );
      s.step = "target";
      return;
    }
  } catch {
    // Non-fatal if mint status probe fails — proceed with setup
  }

  const drop = mintPlan.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = Date.now() >= startsAt.getTime() && Date.now() < endsAt.getTime();

  await ctx.reply(
    `✅ <b>On-Chain SeaDrop Drop Details:</b>\n` +
    `  • <b>Fee Recipient:</b> <code>${escapeHtml(mintPlan.feeRecipient)}</code>\n` +
    `  • <b>Mint Price:</b> ${formatEther(drop.mintPrice)} ETH × ${s.quantity} = <b>${formatEther(drop.mintPrice * BigInt(s.quantity!))} ETH</b> per wallet\n` +
    `  • <b>Max Cap/Wallet:</b> ${drop.maxTotalMintableByWallet || "unlimited"}\n` +
    `  • <b>Stage Window:</b> ${toIST(startsAt)} IST → ${toIST(endsAt)} IST\n` +
    `  • <b>Stage Status:</b> ${live ? "🟢 <b>LIVE NOW</b>" : `🟡 Opens in ${formatRemaining(startsAt.getTime() - Date.now())}`}`,
    { parse_mode: "HTML" }
  );

  const baseFeeGwei = await currentBaseFeeGwei(provider);
  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (s.chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (s.chainKey === "ethereum" ? 5 : 0.05));

  s.step = "gas";
  let msg = "⛽ <b>Step 6: Gas Fee Configuration</b>\n\n";
  if (baseFeeGwei !== null) {
    msg += `🌐 <b>Live Network Base Fee:</b> <code>${baseFeeGwei.toFixed(4)} gwei</code>\n\n`;
  }
  msg += `Select a quick preset button below, or reply with <b>max fee</b> and <b>priority fee</b> (gwei):\n`;
  msg += `Example: <code>${envMaxFee} ${envPriority}</code>`;
  await sendStepHeader(ctx, "⛽ Step 6: Gas", msg, gasKeyboard(baseFeeGwei, envMaxFee, envPriority));
}

async function sendTimingStep(ctx: MyContext) {
  const s = ctx.session;
  const startTimeSec = s.mintPlan!.drop.startTime;
  const startsInFuture = startTimeSec * 1000 > Date.now();
  const at = new Date(startTimeSec * 1000);

  // ponytail: single RPC read for display only; rebuildMintPlan at fire time is the real safety net
  let priceLine = "";
  try {
    const drop = await readPublicDrop(s.rpcUrls![0], s.nftContract!);
    s.mintPlan!.drop = drop;
    priceLine =
      `<b>Current Mint Price:</b> ${formatEther(drop.mintPrice)} ${resolveChain(s.chainKey!)?.nativeSymbol ?? "ETH"}` +
      ` × ${s.quantity} = <b>${formatEther(drop.mintPrice * BigInt(s.quantity!))} ${resolveChain(s.chainKey!)?.nativeSymbol ?? "ETH"}</b> per wallet\n\n`;
  } catch {
    // RPC hiccup — show the plan's snapshot instead, fire-time revalidation still guards
    const p = s.mintPlan!;
    priceLine = `<b>Mint Price (snapshot):</b> ${formatEther(p.drop.mintPrice)} × ${s.quantity} = <b>${formatEther(p.drop.mintPrice * BigInt(s.quantity!))}</b> per wallet\n\n`;
  }

  s.step = "timing";
  await sendStepHeader(ctx,
    "⏰ Step 7: Timing",
    `${priceLine}` +
    `<b>Stage Start:</b> ${toIST(at)} IST\n` +
    `<b>Status:</b> ${startsInFuture ? `🟡 Opens in ${formatRemaining(at.getTime() - Date.now())}` : "🟢 Live now"}\n\n` +
    `Choose execution timing:`,
    timingKeyboard(startsInFuture, at)
  );
}

async function showConfirmStep(ctx: MyContext) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  const provider = makeProvider(s.rpcUrls![0]);
  const wallets = s.walletKeys.map(k => new Wallet(k, provider));
  const balances = await Promise.all(wallets.map(w => provider.getBalance(w.address).catch(() => null)));
  
  const requiredPerWallet = BigInt(s.gasLimit!) * gweiToWei(s.maxFeeGwei!) + s.mintPlan!.value;
  const totalMintCost = s.mintPlan!.value * BigInt(wallets.length);
  const totalMaxGasCost = BigInt(s.gasLimit!) * gweiToWei(s.maxFeeGwei!) * BigInt(wallets.length);
  const totalMaxRequired = requiredPerWallet * BigInt(wallets.length);

  let msg = "✅ <b>Mint Confirmation Card</b>\n\n";
  msg += `<b>Chain:</b> ${escapeHtml(chainProfile.name)} (${chainProfile.chainId})\n`;
  msg += `<b>RPC Node:</b> ${escapeHtml(maskRpc(s.rpcUrls![0]) ?? s.rpcUrls![0])} (+${s.rpcUrls!.length - 1} failovers)\n`;
  msg += `<b>Target Name:</b> ${escapeHtml(s.nftLabel ?? "")}\n`;
  msg += `<b>Contract:</b> <code>${escapeHtml(s.nftContract ?? "")}</code>\n`;
  msg += `<b>Wallets:</b> ${wallets.length} active wallet(s)\n`;
  msg += `<b>Quantity:</b> ${s.quantity} per wallet → <b>${s.quantity! * wallets.length} total NFTs</b>\n`;
  msg += `<b>Gas Parameters:</b> ${s.maxFeeGwei} max / ${s.priorityGwei} tip gwei (limit: ${s.gasLimit?.toLocaleString()})\n`;
  msg += `<b>Timing:</b> ${escapeHtml(s.timingLabel ?? "")}\n\n`;

  msg += "💰 <b>Financial Outflow Summary:</b>\n";
  msg += `  • Mint Cost: <code>${formatEther(totalMintCost)} ${chainProfile.nativeSymbol}</code>\n`;
  msg += `  • Max Gas Reserve: <code>${formatEther(totalMaxGasCost)} ${chainProfile.nativeSymbol}</code>\n`;
  msg += `  • <b>Max Total Exposure:</b> <code>${formatEther(totalMaxRequired)} ${chainProfile.nativeSymbol}</code>\n\n`;

  if (Number(formatEther(totalMaxRequired)) > 0.2) {
    msg += "⚠️ <b>HIGH EXPOSURE WARNING (> 0.2 ETH)</b>\nPlease double-check your contract and gas parameters before firing!\n\n";
  }

  msg += "<b>Wallets Balance Verification:</b>\n";
  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unavailable" : `${Number(formatEther(bal)).toFixed(6)} ${chainProfile.nativeSymbol}`;
    const short = bal !== null && bal < requiredPerWallet;
    msg += `${short ? "❌" : "✅"} [W${i}] <code>${shortAddr(w.address)}</code> (${text})\n`;
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < requiredPerWallet);
  if (shortWallets.length > 0) {
    const actualCost = s.mintPlan!.value; // what the tx actually sends
    const gasOnly = BigInt(s.gasLimit!) * gweiToWei(s.maxFeeGwei!);
    msg += `\n⚠️ <b>${shortWallets.length} wallet(s) below full reserve.</b> Nodes reserve ${formatEther(requiredPerWallet)} ${chainProfile.nativeSymbol} per wallet (mint ${formatEther(actualCost)} + max gas ${formatEther(gasOnly)}).`;
    msg += `\n💡 Actual spend if mined: mint cost only — gas is refunded (EIP-1559), so wallets with ≥ ${formatEther(actualCost)} may still succeed.`;
    if (shortWallets.length === wallets.length && balances.every(b => b !== null && (b as bigint) < actualCost)) {
      msg += "\n❌ All wallets below the actual mint cost — cannot proceed.";
      await ctx.reply(msg, { parse_mode: "HTML" });
      await cleanupKeyMessages(ctx);
      ctx.session = initialSession();
      return;
    }
  }

  s.step = "confirm";
  await sendStepHeader(ctx, "✅ Step 8: Final Review", msg + "\n<b>Ready to execute mint?</b>", confirmKeyboard());
}

async function executeMint(ctx: MyContext) {
  const s = ctx.session;
  s.step = "minting";

  await ctx.reply("🚀 <b>Executing mint transactions on-chain…</b>", { parse_mode: "HTML" });

  try {
    const report = await localPublicSnipe({
      nftContract: s.nftContract!,
      quantity: s.quantity!,
      walletKeys: s.walletKeys,
      rpcUrls: s.rpcUrls!,
      maxFeePerGas: gweiToWei(s.maxFeeGwei!),
      maxPriorityFee: gweiToWei(s.priorityGwei!),
      gasLimit: s.gasLimit!,
      targetStart: s.targetStart ?? null,
      plan: s.mintPlan!,
    });

    // Per-wallet result card: tx link, which RPC accepted it, its latency, status
    const ok = report.filter(r => r.status === "SUCCESS").length;
    let summary = `🎉 <b>Mint Execution Complete!</b>\n` +
      `✅ ${ok}/${report.length} wallet(s) mined successfully\n\n`;
    for (const r of report) {
      const icon = r.status === "SUCCESS" ? "✅" : r.status === "REVERTED" ? "❌" : r.status === "PENDING" ? "⏳" : "🚫";
      summary += `${icon} <b>[W${r.idx}]</b> <code>${shortAddr(r.address)}</code> — <b>${r.status}</b>`;
      if (r.acceptedBy) summary += ` via ${escapeHtml(r.acceptedBy)} (${r.acceptLatencyMs !== null ? r.acceptLatencyMs.toFixed(0) + "ms" : "?"})`;
      summary += "\n";
      if (r.explorerUrl) summary += `     🔗 <a href="${r.explorerUrl}">Track tx</a>\n`;
    }
    summary += "\nUse /mint to start another session.";
    // Hold the successful wallets so the user can sweep them afterwards.
    s.lastMintReport = report;
    if (ok > 0) {
      s.step = "sweep";
      s.sweepStep = "ask";
      await ctx.reply(summary, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📤 Send all minted NFTs to an address", "sweep_start")
          .row()
          .text("❌ No — finish session", "sweep_skip"),
      });
    } else {
      await ctx.reply(summary, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
      await cleanupKeyMessages(ctx);
      ctx.session = initialSession();
    }
  } catch (err: any) {
    if (err.name === "MintedOutError" || err.message?.includes("minted out")) {
      await ctx.reply(`🚫 <b>Minted Out On-Chain!</b>\n\n${sanitizeOutput(err.message)}\n\nMinting stopped. Use /mint for another session.`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    } else if (err.name === "PriceChangedError" || err.message?.includes("Mint price changed")) {
      await ctx.reply(`⚠️ <b>Mint Price Changed On-Chain!</b>\n\n${sanitizeOutput(err.message)}\n\nMinting stopped for safety. Use /mint to start over.`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    } else {
      await ctx.reply(`❌ <b>Mint Failed:</b> ${sanitizeOutput(err.message)}\n\nUse /mint to retry.`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    }
    await cleanupKeyMessages(ctx);
    ctx.session = initialSession();
  }
}

// ============================================
// Confirmation Handlers
// ============================================

async function handleChainSwitchYes(ctx: MyContext) {
  const s = ctx.session;
  const parsed = s.pendingTarget;
  if (!parsed) {
    await ctx.editMessageText("State lost. Please send target link again.");
    s.step = "target";
    return;
  }
  const hinted = resolveChain(parsed.chainHint)!;
  s.chainKey = hinted.key;
  await ctx.editMessageText(`✅ Chain switched to ${escapeHtml(hinted.name)}`);
  if (parsed.kind === "address") {
    const normalized = normalizeAddress(parsed.value);
    s.nftContract = normalized!.address;
    s.nftLabel = shortAddr(normalized!.address);
    delete s.pendingTarget;
    await proceedToRpcStep(ctx);
  } else {
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();
    try {
      const info = await resolveSlug(parsed.value, apiKey || undefined, s.chainKey);
      const resolved = normalizeAddress(info.contractAddress);
      s.nftContract = resolved!.address;
      s.nftLabel = info.name || parsed.value;
      delete s.pendingTarget;
      await proceedToRpcStep(ctx);
    } catch (err: any) {
      await ctx.reply(`❌ ${sanitizeOutput(err.message)}`);
      delete s.pendingTarget;
    }
  }
}

async function handleAddressChecksumYes(ctx: MyContext) {
  const s = ctx.session;
  const addr = s.pendingAddress;
  if (!addr) return;
  s.nftContract = addr;
  s.nftLabel = shortAddr(addr);
  delete s.pendingAddress;
  await proceedToRpcStep(ctx);
}

async function handleSlugChainSwitchYes(ctx: MyContext) {
  const s = ctx.session;
  const chain = s.pendingChain;
  s.chainKey = chain;
  await ctx.editMessageText(`✅ Chain switched to ${escapeHtml(resolveChain(chain)?.name ?? chain ?? "")}`);
  if (s.pendingContract) {
    s.nftContract = s.pendingContract;
    s.nftLabel = s.pendingLabel || shortAddr(s.pendingContract);
  }
  delete s.pendingChain;
  delete s.pendingTarget;
  delete s.pendingContract;
  delete s.pendingLabel;
  await proceedToRpcStep(ctx);
}

async function handleRpcVerifyYes(ctx: MyContext) {
  const s = ctx.session;
  const chainProfile = resolveChain(s.chainKey!)!;
  await ctx.editMessageText(`✅ Proceeding with RPC endpoints for Chain ID ${chainProfile.chainId} (${escapeHtml(chainProfile.name)})`);
  await proceedToGasStep(ctx);
}

// "Yes" on the single-endpoint warning: go back to RPC setup so the user adds
// more endpoints (the recommended path). "No" (handleNo default) proceeds.
async function handleRpcSingleYes(ctx: MyContext) {
  const s = ctx.session;
  s.step = "rpc";
  await proceedToRpcStep(ctx);
}

async function handleTimingEarlyYes(ctx: MyContext) {
  const s = ctx.session;
  const custom = s.pendingCustomTime;
  if (custom) {
    s.targetStart = custom;
    s.timingLabel = `custom — ${toIST(custom)} IST`;
    delete s.pendingCustomTime;
    s.step = "confirm";
    await ctx.editMessageText(`✅ Scheduled custom early time: ${toIST(custom)} IST`);
    await showConfirmStep(ctx);
  } else {
    await ctx.editMessageText("Send time in <b>HH:MM</b> format (24-hour IST, today):", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Back", "nav_back") });
    s.step = "timing_custom";
  }
}

// ============================================
// Error handling
// ============================================

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============================================
// Start
// ============================================

console.log("🤖 Starting Telegram bot…");
bot.start().then(() => console.log("✅ Bot running"));