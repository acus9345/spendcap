import { PRICES, PRICES_AS_OF } from "./prices.js";
import { BLOCKED, HELPERS, PREFIXES, ROUTES } from "./providers.js";
export { PRICES, PRICES_AS_OF };
export class BudgetExceededError extends Error {
    name = "BudgetExceededError";
    /** Which limit refused the call. */
    limit;
    /** The limit in USD. */
    budget;
    /** USD already spent or held against it. */
    spent;
    /** USD this call was estimated to need. */
    estimate;
    constructor(limit, budget, spent, estimate) {
        super(`Budget exceeded: ${limit} limit is $${budget}, $${spent.toFixed(4)} is used and this call needs about $${estimate.toFixed(4)}`);
        this.limit = limit;
        this.budget = budget;
        this.spent = spent;
        this.estimate = estimate;
    }
}
export class UnknownModelError extends Error {
    name = "UnknownModelError";
    model;
    constructor(model) {
        super(`No price for model "${model}". Add it with the pricing option, or set onUnknownModel to "allow"`);
        this.model = model;
    }
}
const DAY = 86_400;
const noop = () => { };
export function memoryStore() {
    const totals = new Map();
    const live = (key) => {
        const entry = totals.get(key);
        if (entry && entry.expires <= Date.now())
            totals.delete(key);
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
export function priceFor(model, pricing) {
    const id = model.replace(/^models\//, "");
    const base = id.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
    if (typeof pricing === "function") {
        const found = pricing(id) ?? (base !== id ? pricing(base) : undefined);
        if (found)
            return found;
    }
    const custom = typeof pricing === "object" ? pricing : undefined;
    return custom?.[id] ?? PRICES[id] ?? custom?.[base] ?? PRICES[base];
}
/** USD for this much usage. */
export function costOf(price, usage) {
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const rates = price.over && usage.input + cacheRead + cacheWrite > price.over.tokens ? price.over : price;
    return (usage.input * rates.input + usage.output * rates.output + cacheRead * (rates.cacheRead ?? rates.input) + cacheWrite * (rates.cacheWrite ?? rates.input)) / 1e6;
}
/** Rough token count. It leans high, since it's used to stop a call before it's sent. */
export function estimateTokens(value) {
    return estimateValue(value, new WeakSet());
}
function estimateValue(value, active) {
    if (typeof value === "string") {
        // Base64 and data URLs are images or files, billed nothing like their length.
        if (value.length > 2000 && (value.startsWith("data:") || /^[\w+/=-]+$/.test(value.slice(0, 2000))))
            return 1500;
        let ascii = 0;
        let other = 0;
        for (let i = 0; i < value.length; i++)
            value.charCodeAt(i) < 128 ? ascii++ : other++;
        return Math.ceil(ascii / 3.5 + other);
    }
    if (typeof value === "object" && value !== null) {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
            return value.byteLength > 0 ? 1500 : 0;
        if (active.has(value))
            return 0;
        active.add(value);
        try {
            if (Array.isArray(value))
                return value.reduce((sum, item) => sum + estimateValue(item, active), 0);
            return Object.entries(value).reduce((sum, [key, item]) => sum + estimateValue(key, active) + estimateValue(item, active), 0);
        }
        finally {
            active.delete(value);
        }
    }
    return value === undefined || value === null ? 0 : 1;
}
export function createSpendCap(options) {
    const { limits, pricing, onUnknownModel = "throw", defaultOutputTokens = 1024, onSpend, now = Date.now } = options;
    for (const [name, value] of Object.entries(limits)) {
        if (value !== undefined && (typeof value !== "number" || Number.isNaN(value) || value < 0)) {
            throw new RangeError(`Limit "${name}" must be a non-negative number`);
        }
    }
    if (typeof defaultOutputTokens !== "number" || !Number.isFinite(defaultOutputTokens) || defaultOutputTokens < 0) {
        throw new RangeError("defaultOutputTokens must be a non-negative finite number");
    }
    const store = options.store ?? memoryStore();
    let runs = 0;
    function slots(scope) {
        const day = new Date(now()).toISOString().slice(0, 10);
        const needs = (id, field, name) => {
            if (id === undefined)
                throw new TypeError(`The ${name} limit needs a scope with a ${field}`);
            return id;
        };
        const list = [];
        if (limits.run !== undefined)
            list.push({ name: "run", key: `run:${needs(scope.run, "run", "run")}`, budget: limits.run, ttl: 7 * DAY });
        if (limits.user !== undefined)
            list.push({ name: "user", key: `user:${needs(scope.user, "user", "user")}`, budget: limits.user, ttl: undefined });
        if (limits.day !== undefined)
            list.push({ name: "day", key: `day:${day}`, budget: limits.day, ttl: 2 * DAY });
        if (limits.userDay !== undefined)
            list.push({ name: "userDay", key: `user:${needs(scope.user, "user", "userDay")}:${day}`, budget: limits.userDay, ttl: 2 * DAY });
        return list;
    }
    async function adjust(held, delta) {
        await Promise.all(held.map((slot) => store.add(slot.key, delta, slot.ttl)));
    }
    async function hold(amount, scope) {
        const list = slots(scope);
        const held = [];
        for (const slot of list) {
            let total;
            try {
                total = await store.add(slot.key, amount, slot.ttl);
            }
            catch (error) {
                if (held.length > 0)
                    await adjust(held, -amount).catch(noop);
                throw error;
            }
            held.push(slot);
            if (total > slot.budget) {
                await adjust(held, -amount);
                throw new BudgetExceededError(slot.name, slot.budget, total - amount, amount);
            }
        }
        return held;
    }
    function priceOf(model) {
        const price = priceFor(model, pricing);
        if (!price && onUnknownModel === "throw")
            throw new UnknownModelError(model);
        return price;
    }
    async function open(request, scope, provider) {
        const price = priceOf(request.model);
        const usage = {
            input: request.inputTokens ?? estimateTokens(request.input),
            output: request.maxOutputTokens ?? defaultOutputTokens,
        };
        const amount = price ? costOf(price, usage) : 0;
        const held = await hold(amount, scope);
        let settled = false;
        const report = (cost, used) => onSpend?.({ provider, model: request.model, scope, cost, usage: used, estimated: used === undefined });
        return {
            amount,
            async commit(used) {
                if (settled)
                    return 0;
                settled = true;
                const cost = used && price ? costOf(price, used) : used ? 0 : amount;
                if (cost !== amount)
                    await adjust(held, cost - amount);
                report(cost, used);
                return cost;
            },
            async release() {
                if (settled)
                    return;
                settled = true;
                await adjust(held, -amount);
            },
        };
    }
    function request(adapter, params) {
        const model = params?.model;
        if (typeof model !== "string")
            throw new TypeError("spendcap needs a model name on every request");
        const maxOutputTokens = adapter.maxOutput(params);
        return { model, input: params, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
    }
    /** Follows a stream as the caller reads it, then settles on what it reported. */
    function follow(stream, adapter, held) {
        let seen;
        const finish = () => held.commit(seen ? complete(seen) : undefined);
        return new Proxy(stream, {
            get(target, key) {
                if (key !== Symbol.asyncIterator)
                    return bound(target, key);
                return () => {
                    const inner = target[Symbol.asyncIterator]();
                    return {
                        async next() {
                            try {
                                const step = await inner.next();
                                if (step.done)
                                    await finish();
                                else {
                                    const part = adapter.event(step.value);
                                    if (part && Object.keys(part).length > 0)
                                        seen = { ...seen, ...part };
                                }
                                return step;
                            }
                            catch (error) {
                                await finish();
                                throw error;
                            }
                        },
                        async return(value) {
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
    async function guarded(adapter, call, args, scope) {
        const [params, ...rest] = args;
        const held = await open(request(adapter, params), scope, adapter.provider);
        let response;
        try {
            response = await call(adapter.prepare?.(params) ?? params, ...rest);
        }
        catch (error) {
            await held.release();
            throw error;
        }
        if (typeof response?.[Symbol.asyncIterator] === "function")
            return follow(response, adapter, held);
        const usage = adapter.usage(response);
        await held.commit(usage ? complete(usage) : undefined);
        return response;
    }
    /** Stream helpers return at once, but the hold takes a moment, so calls wait for it behind a stand-in. */
    function helper(adapter, call, args, scope) {
        let settling;
        const started = open(request(adapter, args[0]), scope, adapter.provider).then(async (held) => {
            let stream;
            try {
                stream = call(...args);
            }
            catch (error) {
                await held.release();
                throw error;
            }
            const settle = (message) => {
                if (settling)
                    return;
                const usage = adapter.usage(message);
                settling = held.commit(usage ? complete(usage) : undefined);
                settling.catch(noop);
            };
            stream.on("finalMessage", settle);
            stream.on("error", () => settle());
            stream.on("abort", () => settle());
            return stream;
        });
        started.catch(noop);
        const standIn = new Proxy({}, {
            get(_, key) {
                if (key === "then")
                    return undefined;
                if (key === Symbol.asyncIterator) {
                    return async function* () {
                        try {
                            yield* await started;
                        }
                        finally {
                            await settling;
                        }
                    };
                }
                if (key === "on" || key === "once") {
                    return (event, listener) => {
                        started.then((stream) => stream[key](event, listener), (error) => {
                            if (event === "error")
                                listener(error);
                        });
                        return standIn;
                    };
                }
                return (...rest) => started.then(async (stream) => {
                    try {
                        return await stream[key](...rest);
                    }
                    finally {
                        await settling;
                    }
                });
            },
        });
        return standIn;
    }
    function wrapAt(target, path, scope) {
        return new Proxy(target, {
            get(object, key) {
                if (typeof key !== "string")
                    return Reflect.get(object, key);
                const next = path ? `${path}.${key}` : key;
                const value = Reflect.get(object, key);
                if (typeof value === "function") {
                    const call = value.bind(object);
                    const route = ROUTES[next];
                    if (route)
                        return (...args) => guarded(route, call, args, scope);
                    const stream = HELPERS[next];
                    if (stream)
                        return (...args) => helper(stream, call, args, scope);
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
    async function totals(scope) {
        const out = {};
        for (const slot of slots(scope))
            out[slot.name] = (await store.get(slot.key)) ?? 0;
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
            const out = {};
            for (const slot of slots(scope))
                out[slot.name] = Math.max(0, slot.budget - (used[slot.name] ?? 0));
            return out;
        },
    };
}
function complete(usage) {
    return { input: 0, output: 0, ...usage };
}
function bound(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
}
