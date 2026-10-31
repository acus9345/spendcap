import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  BudgetExceededError,
  costOf,
  createSpendCap,
  estimateTokens,
  memoryStore,
  PRICES,
  priceFor,
  UnknownModelError,
  type Price,
  type SpendEvent,
} from "../dist/index.js";

const PRICE: Price = { input: 10, output: 20, cacheRead: 1, cacheWrite: 15 };
const pricing = { test: PRICE };
const near = (a: number | undefined, b: number) => assert.ok(Math.abs((a ?? NaN) - b) < 1e-9, `${a} is not ${b}`);

/** Stands in for an SDK, with a private field so a wrong `this` would throw. */
class FakeOpenAI {
  #key = "secret";
  calls: any[] = [];
  chat = { completions: { create: (params: any) => this.#send(params), parse: (params: any) => this.#send(params), stream: () => "untracked" } };
  responses = { create: async (params: any) => ({ usage: { input_tokens: 2000, output_tokens: 1000, input_tokens_details: { cached_tokens: 1000 } }, echo: params }) };
  models = { list: () => this.key() };
  embeddings = { create: async () => "free pass" };
  key() {
    return this.#key;
  }
  async #send(params: any) {
    assert.equal(this.#key, "secret");
    this.calls.push(params);
    if (params.fail) throw new Error("boom");
    if (params.stream) {
      return (async function* () {
        yield { choices: [{ delta: { content: "hi" } }] };
        yield { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } };
      })();
    }
    return { usage: { prompt_tokens: 3000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 2000 } } };
  }
}

class FakeAnthropic {
  messages = {
    create: async (params: any) => {
      if (!params.stream) return { usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 } };
      return (async function* () {
        yield { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 1000 } } };
        yield { type: "content_block_delta" };
        yield { type: "message_delta", usage: { output_tokens: 2000 } };
      })();
    },
    stream: (params: any) => {
      const stream: any = new EventEmitter();
      stream.finalMessage = async () => {
        const message = { usage: { input_tokens: 1000, output_tokens: 1000 } };
        stream.emit("finalMessage", message);
        return message;
      };
      stream.params = params;
      return stream;
    },
  };
  beta = { messages: { toolRunner: () => "untracked" } };
}

const fakeGemini = {
  models: {
    generateContent: async (_params: any) => ({ usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 500, thoughtsTokenCount: 500, cachedContentTokenCount: 1000 } }),
    generateContentStream: async (_params: any) =>
      (async function* () {
        yield { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1 } };
        yield { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 } };
      })(),
  },
};

describe("reading usage", () => {
  it("OpenAI chat, with cached input split out", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await cap.wrap(new FakeOpenAI(), { user: "a" }).chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 2000 * 1 + 1000 * 20) / 1e6);
  });

  it("OpenAI Responses", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await cap.wrap(new FakeOpenAI(), { user: "a" }).responses.create({ model: "test", input: "hi", max_output_tokens: 10 });
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 1 + 1000 * 20) / 1e6);
  });

  it("Anthropic, with cache reads and writes", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await cap.wrap(new FakeAnthropic(), { user: "a" }).messages.create({ model: "test", messages: [], max_tokens: 10 });
    near((await cap.spent({ user: "a" })).user, (10_000 + 20_000 + 1000 + 15_000) / 1e6);
  });

  it("Gemini, with thoughts billed as output", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await cap.wrap(fakeGemini, { user: "a" }).models.generateContent({ model: "test", contents: "hi", config: { maxOutputTokens: 10 } });
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 1 + 1000 * 20) / 1e6);
  });
});

describe("streams", () => {
  async function drain(stream: AsyncIterable<unknown>) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it("asks OpenAI for usage and reads it from the last chunk", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    const fake = new FakeOpenAI();
    const stream = await cap.wrap(fake, { user: "a" }).chat.completions.create({ model: "test", messages: [], stream: true, max_tokens: 10 });
    assert.equal(fake.calls[0].stream_options.include_usage, true);
    assert.equal((await drain(stream as any)).length, 2);
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 500 * 20) / 1e6);
  });

  it("merges Anthropic stream events", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await drain((await cap.wrap(new FakeAnthropic(), { user: "a" }).messages.create({ model: "test", messages: [], stream: true, max_tokens: 10 })) as any);
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 1 + 2000 * 20) / 1e6);
  });

  it("reads the last Gemini chunk", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await drain(await cap.wrap(fakeGemini, { user: "a" }).models.generateContentStream({ model: "test", contents: "hi", config: { maxOutputTokens: 10 } }));
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 20) / 1e6);
  });

  it("settles when the reader leaves early", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    const stream = await cap.wrap(new FakeAnthropic(), { user: "a" }).messages.create({ model: "test", messages: [], stream: true, max_tokens: 10_000 });
    for await (const _ of stream as any) break;
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 1 + 1 * 20) / 1e6);
  });

  it("keeps the hold on a stream nobody reads", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    await cap.wrap(new FakeAnthropic(), { user: "a" }).messages.create({ model: "test", messages: [], stream: true, max_tokens: 1000 });
    assert.ok((await cap.spent({ user: "a" })).user! >= (1000 * 20) / 1e6);
  });

  it("works through the messages.stream helper", async () => {
    const cap = createSpendCap({ limits: { user: 10 }, pricing });
    const client = cap.wrap(new FakeAnthropic(), { user: "a" });
    const seen: unknown[] = [];
    const stream: any = client.messages.stream({ model: "test", messages: [], max_tokens: 10 });
    stream.on("finalMessage", (message: unknown) => seen.push(message));
    await stream.finalMessage();
    assert.equal(seen.length, 1);
    near((await cap.spent({ user: "a" })).user, (1000 * 10 + 1000 * 20) / 1e6);
  });

  it("rejects the helper when the budget is gone", async () => {
    const cap = createSpendCap({ limits: { user: 0.000001 }, pricing });
    const stream: any = cap.wrap(new FakeAnthropic(), { user: "a" }).messages.stream({ model: "test", messages: [], max_tokens: 1000 });
    const errors: unknown[] = [];
    stream.on("error", (error: unknown) => errors.push(error));
    await assert.rejects(stream.finalMessage(), BudgetExceededError);
    assert.ok(errors[0] instanceof BudgetExceededError);
  });
});

describe("the cap", () => {
  const client = (cap: ReturnType<typeof createSpendCap>, scope = {}) => cap.wrap(new FakeOpenAI(), { user: "a", ...scope });

  it("refuses one huge request before it is sent", async () => {
    const cap = createSpendCap({ limits: { user: 0.01 }, pricing });
    const fake = new FakeOpenAI();
    await assert.rejects(cap.wrap(fake, { user: "a" }).chat.completions.create({ model: "test", messages: [], max_tokens: 1_000_000 }), (error: BudgetExceededError) => {
      assert.ok(error instanceof BudgetExceededError);
      assert.equal(error.limit, "user");
      assert.equal(error.budget, 0.01);
      assert.ok(error.estimate >= 20);
      return true;
    });
    assert.equal(fake.calls.length, 0);
    near((await cap.spent({ user: "a" })).user, 0);
  });

  it("counts the prompt in the estimate", async () => {
    const cap = createSpendCap({ limits: { user: 0.001 }, pricing });
    const messages = [{ role: "user", content: "word ".repeat(10_000) }];
    await assert.rejects(client(cap).chat.completions.create({ model: "test", messages, max_tokens: 1 }), BudgetExceededError);
  });

  it("refuses once the budget is used up", async () => {
    const cap = createSpendCap({ limits: { user: 0.05 }, pricing });
    const wrapped = client(cap);
    const send = () => wrapped.chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    await send();
    await send();
    await assert.rejects(send, BudgetExceededError);
  });

  it("holds money for calls in flight, so parallel calls can't all slip through", async () => {
    const cap = createSpendCap({ limits: { user: 0.05 }, pricing });
    const wrapped = client(cap);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => wrapped.chat.completions.create({ model: "test", messages: [], max_tokens: 2000 })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  });

  it("refunds a call that fails", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    await assert.rejects(client(cap).chat.completions.create({ model: "test", messages: [], fail: true }), /boom/);
    near((await cap.spent({ user: "a" })).user, 0);
  });

  it("charges the estimate when usage is missing", async () => {
    const events: SpendEvent[] = [];
    const cap = createSpendCap({ limits: { user: 1 }, pricing, onSpend: (event) => events.push(event) });
    const bare = { messages: { create: async (_params: any) => ({}) } };
    await cap.wrap(bare, { user: "a" }).messages.create({ model: "test", max_tokens: 1000 });
    assert.equal(events[0]!.estimated, true);
    assert.ok((await cap.spent({ user: "a" })).user! >= 0.02);
  });

  it("keeps runs apart, and gives each wrap its own run by default", async () => {
    const cap = createSpendCap({ limits: { run: 0.03 }, pricing });
    const send = (c: FakeOpenAI) => c.chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    const first = cap.wrap(new FakeOpenAI());
    await send(first);
    await assert.rejects(send(first), BudgetExceededError);
    await send(cap.wrap(new FakeOpenAI()));
    await send(cap.wrap(new FakeOpenAI(), { run: "x" }));
    assert.ok((await cap.spent({ run: "x" })).run! > 0);
  });

  it("rolls back every limit when one refuses", async () => {
    const cap = createSpendCap({ limits: { run: 100, user: 100, day: 0.001 }, pricing });
    await assert.rejects(client(cap, { run: "r" }).chat.completions.create({ model: "test", messages: [], max_tokens: 1000 }), BudgetExceededError);
    const spent = await cap.spent({ run: "r", user: "a" });
    near(spent.run, 0);
    near(spent.user, 0);
  });

  it("starts a new day at midnight UTC", async () => {
    let clock = Date.UTC(2026, 9, 31, 23, 59);
    const cap = createSpendCap({ limits: { day: 0.03, userDay: 0.03 }, pricing, now: () => clock });
    const wrapped = client(cap);
    const send = () => wrapped.chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    await send();
    await assert.rejects(send, BudgetExceededError);
    clock = Date.UTC(2026, 10, 1, 0, 1);
    await send();
  });

  it("reports what is left", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    await client(cap).chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    near((await cap.remaining({ user: "a" })).user, 1 - 0.032);
  });

  it("says which scope a limit needs", () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    assert.throws(() => cap.wrap(new FakeOpenAI()), /needs a scope with a user/);
  });

  it("uses a shared store when given one", async () => {
    const store = memoryStore();
    const one = createSpendCap({ limits: { user: 0.05 }, pricing, store });
    const two = createSpendCap({ limits: { user: 0.05 }, pricing, store });
    await client(one).chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    await client(two).chat.completions.create({ model: "test", messages: [], max_tokens: 10 });
    await assert.rejects(client(one).chat.completions.create({ model: "test", messages: [], max_tokens: 10 }), BudgetExceededError);
  });

  it("forgets totals when their time is up", async () => {
    const store = memoryStore();
    await store.add("gone", 1, -1);
    assert.equal(await store.get("gone"), undefined);
  });
});

describe("the wrapped client", () => {
  it("leaves everything else alone", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    const wrapped = cap.wrap(new FakeOpenAI(), { user: "a" });
    assert.equal(wrapped.key(), "secret");
    assert.equal(wrapped.models.list(), "secret");
    assert.equal(await wrapped.embeddings.create(), "free pass");
    assert.ok(wrapped instanceof FakeOpenAI);
  });

  it("refuses paths it can't track rather than letting them through", () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    assert.throws(() => cap.wrap(new FakeOpenAI(), { user: "a" }).chat.completions.stream(), /can't track chat\.completions\.stream/);
    assert.throws(() => cap.wrap(new FakeAnthropic(), { user: "a" }).beta.messages.toolRunner(), /can't track/);
  });

  it("covers parse too", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    await cap.wrap(new FakeOpenAI(), { user: "a" }).chat.completions.parse({ model: "test", messages: [], max_tokens: 10 });
    assert.ok((await cap.spent({ user: "a" })).user! > 0);
  });
});

describe("pricing", () => {
  it("fails closed on a model with no price", async () => {
    const cap = createSpendCap({ limits: { user: 1 } });
    await assert.rejects(cap.wrap(new FakeOpenAI(), { user: "a" }).chat.completions.create({ model: "made-up", messages: [] }), UnknownModelError);
  });

  it("can let unknown models through", async () => {
    const events: SpendEvent[] = [];
    const cap = createSpendCap({ limits: { user: 1 }, onUnknownModel: "allow", onSpend: (event) => events.push(event) });
    await cap.wrap(new FakeOpenAI(), { user: "a" }).chat.completions.create({ model: "made-up", messages: [] });
    assert.equal(events[0]!.cost, 0);
  });

  it("finds dated names and Gemini's prefix, but never guesses a nearby model", () => {
    assert.equal(priceFor("gpt-4o-2024-08-06"), PRICES["gpt-4o-2024-08-06"]);
    assert.equal(priceFor("gpt-5-2026-01-01"), PRICES["gpt-5"]);
    assert.equal(priceFor("claude-opus-5-20260401"), PRICES["claude-opus-5"]);
    assert.equal(priceFor("models/gemini-2.5-flash"), PRICES["gemini-2.5-flash"]);
    assert.equal(priceFor("gemini-2.5-flash-latest"), PRICES["gemini-2.5-flash"]);
    assert.equal(priceFor("claude-opus-5-7"), undefined);
    assert.equal(priceFor("gpt-5-codex-max"), undefined);
  });

  it("lets custom prices win", () => {
    assert.equal(priceFor("gpt-5", { "gpt-5": PRICE }), PRICE);
    assert.equal(priceFor("my-deployment", () => PRICE), PRICE);
    assert.equal(priceFor("gpt-5", () => undefined), PRICES["gpt-5"]);
  });

  it("switches to the higher rate for big requests", () => {
    const price: Price = { input: 1, output: 2, over: { tokens: 100, input: 10, output: 20 } };
    assert.equal(costOf(price, { input: 100, output: 1 }), 102 / 1e6);
    assert.equal(costOf(price, { input: 101, output: 1 }), 1030 / 1e6);
    assert.equal(costOf(price, { input: 50, output: 1, cacheRead: 51 }), (500 + 20 + 510) / 1e6);
  });

  it("falls back to the input rate for cache tokens", () => {
    assert.equal(costOf({ input: 2, output: 0 }, { input: 0, output: 0, cacheRead: 1, cacheWrite: 1 }), 4 / 1e6);
  });

  it("ships prices for all three providers", () => {
    for (const model of ["gpt-5.5", "claude-opus-5-5", "gemini-2.5-pro"]) assert.ok(PRICES[model], model);
    assert.equal(PRICES["claude-opus-5-5"]!.output, 20);
    assert.equal(PRICES["gpt-5.5"]!.over?.tokens, 272_000);
    for (const [model, price] of Object.entries(PRICES)) assert.ok(price.input > 0 && price.output > 0, model);
  });
});

describe("estimateTokens", () => {
  it("leans high for English and counts non-ASCII heavily", () => {
    assert.ok(estimateTokens("hello world, this is a test") >= 6);
    assert.equal(estimateTokens("你好世界"), 4);
  });

  it("walks nested requests", () => {
    assert.ok(estimateTokens({ messages: [{ role: "user", content: "x".repeat(350) }] }) >= 100);
  });

  it("doesn't count a base64 image by its length", () => {
    assert.equal(estimateTokens(`data:image/png;base64,${"A".repeat(1_000_000)}`), 1500);
    assert.equal(estimateTokens("A".repeat(1_000_000)), 1500);
  });
});

describe("reserve", () => {
  it("guards a call you make yourself", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    const hold = await cap.reserve({ model: "test", inputTokens: 1000, maxOutputTokens: 1000 }, { user: "a" });
    near(hold.amount, 0.03);
    near((await cap.spent({ user: "a" })).user, 0.03);
    near(await hold.commit({ input: 100, output: 100 }), 0.003);
    near((await cap.spent({ user: "a" })).user, 0.003);
    assert.equal(await hold.commit({ input: 1, output: 1 }), 0);
  });

  it("gives money back on release", async () => {
    const cap = createSpendCap({ limits: { user: 1 }, pricing });
    const hold = await cap.reserve({ model: "test", input: "hello" }, { user: "a" });
    await hold.release();
    await hold.release();
    near((await cap.spent({ user: "a" })).user, 0);
  });
});
