import { PRICES, PRICES_AS_OF } from "./prices.js";
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
export declare class BudgetExceededError extends Error {
    readonly name = "BudgetExceededError";
    /** Which limit refused the call. */
    readonly limit: LimitName;
    /** The limit in USD. */
    readonly budget: number;
    /** USD already spent or held against it. */
    readonly spent: number;
    /** USD this call was estimated to need. */
    readonly estimate: number;
    constructor(limit: LimitName, budget: number, spent: number, estimate: number);
}
export declare class UnknownModelError extends Error {
    readonly name = "UnknownModelError";
    readonly model: string;
    constructor(model: string);
}
export declare function memoryStore(): Store;
/** Look up a model, ignoring dates and `-latest` on its name. */
export declare function priceFor(model: string, pricing?: SpendCapOptions["pricing"]): Price | undefined;
/** USD for this much usage. */
export declare function costOf(price: Price, usage: Usage): number;
/** Rough token count. It leans high, since it's used to stop a call before it's sent. */
export declare function estimateTokens(value: unknown): number;
export declare function createSpendCap(options: SpendCapOptions): SpendCap;
