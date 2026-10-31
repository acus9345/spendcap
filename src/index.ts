import { PRICES, PRICES_AS_OF } from "./prices.js";
import { BLOCKED, HELPERS, PREFIXES, ROUTES, type Adapter } from "./providers.js";
import type { Price, Usage } from "./types.js";

export { PRICES, PRICES_AS_OF };
export type { Price, Rates, Usage } from "./types.js";

export interface Limits {
  /** USD per run. */
  run?: number;
  /** USD per user, for as long as the store remembers. */
  user?: number;
  /** USD across everything, per UTC day. */
  day?: number;
  /** USD per user, per UTC day. */
  userDay?: number;
}

export type LimitName = keyof Limits;

export interface Scope {
  run?: string;
  user?: string;
}

/** Keeps running totals. Use a shared store to hold a cap across processes. */
export interface Store {
  /** Add `delta`, which may be negative, and return the new total. Must be atomic. */
  add(key: string, delta: number, ttlSeconds?: number): number | Promise<number>;
  get(key: string): number | undefined | Promise<number | undefined>;
}

export interface SpendEvent {
  provider: string;
  model: string;
  scope: Scope;
  /** USD charged. */
  cost: number;
  usage: Usage | undefined;
  /** True when no usage came back, so the estimate was charged instead. */
  estimated: boolean;
}

export interface SpendCapOptions {
  limits: Limits;
  store?: Store;
  /** More models, merged over the bundled table, or a function tried before it. */
  pricing?: Record<string, Price> | ((model: string) => Price | undefined);
  /** What to do with a model that has no price. `allow` lets it through at no cost. Default `throw`. */
  onUnknownModel?: "throw" | "allow";
  /** Output tokens to assume when a request sets no maximum. Default 1024. */
  defaultOutputTokens?: number;
  /** Called after every charge. */
  onSpend?: (event: SpendEvent) => void;
  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}

export interface ReserveRequest {
  model: string;
  /** Anything the request sends, used to estimate input tokens. */
  input?: unknown;
  /** Exact input tokens, if you know them. Wins over `input`. */
  inputTokens?: number;
  maxOutputTokens?: number;
}

export interface Hold {
  /** USD held. */
  amount: number;
  /** Replace the hold with the real cost. Without usage, the hold stands as the charge. */
  commit(usage?: Usage): Promise<number>;
  /** Give the hold back. Use when the call failed before anything was billed. */
  release(): Promise<void>;
}

export interface SpendCap {
  /** Returns a client that behaves the same, with its LLM calls under the cap. */
  wrap<T extends object>(client: T, scope?: Scope): T;
  /** Hold money for a call you make yourself. Throws `BudgetExceededError` if it doesn't fit. */
  reserve(request: ReserveRequest, scope?: Scope): Promise<Hold>;
  spent(scope?: Scope): Promise<Limits>;
  remaining(scope?: Scope): Promise<Limits>;
}

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  /** Which limit refused the call. */
  readonly limit: LimitName;
  /** The limit in USD. */
  readonly budget: number;
  /** USD already spent or held against it. */
  readonly spent: number;
  /** USD this call was estimated to need. */
  readonly estimate: number;

  constructor(limit: LimitName, budget: number, spent: number, estimate: number) {
    super(`Budget exceeded: ${limit} limit is $${budget}, $${spent.toFixed(4)} is used and this call needs about $${estimate.toFixed(4)}`);
    this.limit = limit;
    this.budget = budget;
    this.spent = spent;
    this.estimate = estimate;
  }
}

export class UnknownModelError extends Error {
  override readonly name = "UnknownModelError";
  readonly model: string;

  constructor(model: string) {
    super(`No price for model "${model}". Add it with the pricing option, or set onUnknownModel to "allow"`);
    this.model = model;
  }
}

interface Slot {
  name: LimitName;
  key: string;
  budget: number;
  ttl: number | undefined;
}

const DAY = 86_400;
const noop = () => {};

export function memoryStore(): Store {
  const totals = new Map<string, { total: number; expires: number }>();
  const live = (key: string) => {
    const entry = totals.get(key);
    if (entry && entry.expires <= Date.now()) totals.delete(key);
    return totals.get(key);
  };
  return {
    add(key, delta, ttlSeconds) {
      const total = (live(key)?.total ?? 0) + delta;
      totals.set(key, { total, expires: ttlSeconds === undefined ? Infinity : Date.now() + ttlSeconds * 1000 });
      return total;
    },
    get: (key) => live(key)?.total,
  };
}

/** Look up a model, ignoring dates and `-latest` on its name. */
export function priceFor(model: string, pricing?: SpendCapOptions["pricing"]): Price | undefined {
  const id = model.replace(/^models\//, "");
  const base = id.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
  if (typeof pricing === "function") {
    const found = pricing(id) ?? pricing(base);
    if (found) return found;
  }
  const custom = typeof pricing === "object" ? pricing : undefined;
  return custom?.[id] ?? PRICES[id] ?? custom?.[base] ?? PRICES[base];
}

/** USD for this much usage. */
export function costOf(price: Price, usage: Usage): number {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const rates = price.over && usage.input + cacheRead + cacheWrite > price.over.tokens ? price.over : price;
  return (usage.input * rates.input + usage.output * rates.output + cacheRead * (rates.cacheRead ?? rates.input) + cacheWrite * (rates.cacheWrite ?? rates.input)) / 1e6;
}

/** Rough token count. It leans high, since it's used to stop a call before it's sent. */
export function estimateTokens(value: unknown): number {
  if (typeof value === "string") {
    // Base64 and data URLs are images or files, billed nothing like their length.
    if (value.length > 2000 && (value.startsWith("data:") || /^[\w+/=-]+$/.test(value.slice(0, 2000)))) return 1500;
    let ascii = 0;
    let other = 0;
    for (let i = 0; i < value.length; i++) value.charCodeAt(i) < 128 ? ascii++ : other++;
    return Math.ceil(ascii / 3.5 + other);
  }
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + estimateTokens(item), 0);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce((sum, [key, item]) => sum + estimateTokens(key) + estimateTokens(item), 0);
  }
  return value === undefined || value === null ? 0 : 1;
}

export function createSpendCap(options: SpendCapOptions): SpendCap {
  const { limits, pricing, onUnknownModel = "throw", defaultOutputTokens = 1024, onSpend, now = Date.now } = options;
  const store = options.store ?? memoryStore();
  let runs = 0;

  function slots(scope: Scope): Slot[] {
    const day = new Date(now()).toISOString().slice(0, 10);
    const needs = (id: string | undefined, field: string, name: LimitName): string => {
      if (id === undefined) throw new TypeError(`The ${name} limit needs a scope with a ${field}`);
      return id;
    };
    const list: Slot[] = [];
    if (limits.run !== undefined) list.push({ name: "run", key: `run:${needs(scope.run, "run", "run")}`, budget: limits.run, ttl: 7 * DAY });
    if (limits.user !== undefined) list.push({ name: "user", key: `user:${needs(scope.user, "user", "user")}`, budget: limits.user, ttl: undefined });
    if (limits.day !== undefined) list.push({ name: "day", key: `day:${day}`, budget: limits.day, ttl: 2 * DAY });
    if (limits.userDay !== undefined) list.push({ name: "userDay", key: `user:${needs(scope.user, "user", "userDay")}:${day}`, budget: limits.userDay, ttl: 2 * DAY });
    return list;
  }

  async function adjust(held: Slot[], delta: number): Promise<void> {
    await Promise.all(held.map((slot) => store.add(slot.key, delta, slot.ttl)));
  }

  async function hold(amount: number, scope: Scope): Promise<Slot[]> {
    const list = slots(scope);
    const held: Slot[] = [];
    for (const slot of list) {
      const total = await store.add(slot.key, amount, slot.ttl);
      held.push(slot);
      if (total > slot.budget) {
        await adjust(held, -amount);
        throw new BudgetExceededError(slot.name, slot.budget, total - amount, amount);
      }
    }
    return held;
  }

  function priceOf(model: string): Price | undefined {
    const price = priceFor(model, pricing);
    if (!price && onUnknownModel === "throw") throw new UnknownModelError(model);
    return price;
  }

  async function open(request: ReserveRequest, scope: Scope, provider: string): Promise<Hold> {
    const price = priceOf(request.model);
    const usage: Usage = {
      input: request.inputTokens ?? estimateTokens(request.input),
      output: request.maxOutputTokens ?? defaultOutputTokens,
    };
    const amount = price ? costOf(price, usage) : 0;
    const held = await hold(amount, scope);
    let settled = false;
    const report = (cost: number, used: Usage | undefined) => onSpend?.({ provider, model: request.model, scope, cost, usage: used, estimated: used === undefined });
    return {
      amount,
      async commit(used) {
        if (settled) return 0;
        settled = true;
        const cost = used && price ? costOf(price, used) : used ? 0 : amount;
        if (cost !== amount) await adjust(held, cost - amount);
        report(cost, used);
        return cost;
      },
      async release() {
        if (settled) return;
        settled = true;
        await adjust(held, -amount);
      },
    };
  }

  function request(adapter: Adapter, params: Record<string, any>): ReserveRequest {
    const { model } = params;
    if (typeof model !== "string") throw new TypeError("spendcap needs a model name on every request");
    const maxOutputTokens = adapter.maxOutput(params);
    return { model, input: params, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
  }

  /** Follows a stream as the caller reads it, then settles on what it reported. */
  function follow(stream: any, adapter: Adapter, held: Hold): any {
    let seen: Partial<Usage> | undefined;
    const finish = () => held.commit(seen ? complete(seen) : undefined);
    return new Proxy(stream, {
      get(target, key) {
        if (key !== Symbol.asyncIterator) return bound(target, key);
        return () => {
          const inner = target[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const step = await inner.next();
                if (step.done) await finish();
                else seen = { ...seen, ...adapter.event(step.value) };
                return step;
              } catch (error) {
                await finish();
                throw error;
              }
            },
            async return(value: unknown) {
              await finish();
              return inner.return ? inner.return(value) : { done: true, value };
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        };
      },
    });
  }

  async function guarded(adapter: Adapter, call: (...args: any[]) => any, args: any[], scope: Scope): Promise<any> {
    const [params, ...rest] = args;
    const held = await open(request(adapter, params), scope, adapter.provider);
    let response;
    try {
      response = await call(adapter.prepare?.(params) ?? params, ...rest);
    } catch (error) {
      await held.release();
      throw error;
    }
    if (typeof response?.[Symbol.asyncIterator] === "function") return follow(response, adapter, held);
    const usage = adapter.usage(response);
    await held.commit(usage ? complete(usage) : undefined);
    return response;
  }

  /** Stream helpers return at once, but the hold takes a moment, so calls wait for it behind a stand-in. */
  function helper(adapter: Adapter, call: (...args: any[]) => any, args: any[], scope: Scope): any {
    const started = open(request(adapter, args[0]), scope, adapter.provider).then((held) => {
      const stream = call(...args);
      const settle = (message?: any) => {
        const usage = adapter.usage(message);
        void held.commit(usage ? complete(usage) : undefined);
      };
      stream.on("finalMessage", settle);
      stream.on("error", () => settle());
      stream.on("abort", () => settle());
      return stream;
    });
    started.catch(noop);
    const standIn: any = new Proxy(
      {},
      {
        get(_, key) {
          if (key === "then") return undefined;
          if (key === Symbol.asyncIterator) {
            return async function* () {
              yield* await started;
            };
          }
          if (key === "on" || key === "once") {
            return (event: string, listener: (...args: any[]) => void) => {
              started.then(
                (stream) => stream[key](event, listener),
                (error) => {
                  if (event === "error") listener(error);
                },
              );
              return standIn;
            };
          }
          return (...rest: unknown[]) => started.then((stream) => stream[key as string](...rest));
        },
      },
    );
    return standIn;
  }

  function wrapAt<T extends object>(target: T, path: string, scope: Scope): T {
    return new Proxy(target, {
      get(object, key) {
        if (typeof key !== "string") return Reflect.get(object, key);
        const next = path ? `${path}.${key}` : key;
        const value = Reflect.get(object, key);
        if (typeof value === "function") {
          const call = value.bind(object);
          const route = ROUTES[next];
          if (route) return (...args: any[]) => guarded(route, call, args, scope);
          const stream = HELPERS[next];
          if (stream) return (...args: any[]) => helper(stream, call, args, scope);
          const blocked = BLOCKED[next];
          if (blocked) {
            return () => {
              throw new Error(`spendcap can't track ${next}: ${blocked}`);
            };
          }
          return call;
        }
        return PREFIXES.has(next) && typeof value === "object" && value !== null ? wrapAt(value, next, scope) : value;
      },
    });
  }

  async function totals(scope: Scope): Promise<Limits> {
    const out: Limits = {};
    for (const slot of slots(scope)) out[slot.name] = (await store.get(slot.key)) ?? 0;
    return out;
  }

  return {
    wrap(client, scope = {}) {
      const full = limits.run !== undefined && scope.run === undefined ? { ...scope, run: `run-${++runs}-${now()}` } : scope;
      slots(full);
      return wrapAt(client, "", full);
    },
    reserve: (req, scope = {}) => open(req, scope, "manual"),
    spent: totals,
    async remaining(scope = {}) {
      const used = await totals(scope);
      const out: Limits = {};
      for (const slot of slots(scope)) out[slot.name] = Math.max(0, slot.budget - (used[slot.name] ?? 0));
      return out;
    },
  };
}

function complete(usage: Partial<Usage>): Usage {
  return { input: 0, output: 0, ...usage };
}

function bound(target: any, key: string | symbol): unknown {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}
