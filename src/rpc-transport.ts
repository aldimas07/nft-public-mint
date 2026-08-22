import { Agent, fetch as undiciFetch } from "undici";

export interface RpcRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  dispatcher?: unknown;
}

export type FetchLike = (
  url: string,
  init?: RpcRequestInit
) => Promise<{ ok?: boolean; status?: number; text(): Promise<string> }>;

export interface RpcTransportOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  connections?: number;
}

export class RpcTransport {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly connections: number;
  private readonly agents = new Map<string, Agent>();

  constructor(options: RpcTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
    this.connections = options.connections ?? 32;
  }

  async request(url: string, init: RpcRequestInit = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        dispatcher: this.dispatcherFor(url),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async requestText(url: string, init: RpcRequestInit = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        dispatcher: this.dispatcherFor(url),
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async rpc(url: string, method: string, params: unknown[] = [], timeoutMs = this.timeoutMs) {
    return this.requestText(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    }, timeoutMs);
  }

  async warm(url: string, timeoutMs = this.timeoutMs): Promise<boolean> {
    try {
      await this.rpc(url, "eth_chainId", [], timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.close()));
    this.agents.clear();
  }

  private dispatcherFor(url: string): Agent | undefined {
    if (this.fetchImpl !== (undiciFetch as unknown as FetchLike)) return undefined;
    const origin = new URL(url).origin;
    let agent = this.agents.get(origin);
    if (!agent) {
      agent = new Agent({
        connections: this.connections,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 120_000,
        pipelining: 1,
      });
      this.agents.set(origin, agent);
    }
    return agent;
  }
}

export const rpcTransport = new RpcTransport();
