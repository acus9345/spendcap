# spendcap

Hard spend caps for OpenAI, Anthropic and Gemini clients. Wrap the SDK client and it refuses calls once a budget is used up.

[![npm](https://img.shields.io/npm/v/spendcap)](https://www.npmjs.com/package/spendcap)
[![CI](https://github.com/acus9345/spendcap/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/spendcap/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/spendcap)](LICENSE)

A runaway agent or one heavy user can burn through a month's budget in an afternoon. Provider dashboards tell you afterwards. `spendcap` stops the call before it's sent.

- **One line:** `cap.wrap(client)` returns a client that behaves the same, with its LLM calls under the cap.
- **Three providers:** the OpenAI, Anthropic and Google Gen AI SDKs, including streams and prompt caching.
- **Real numbers:** every call is charged from the token usage in its response, not a guess.
- **Checks first:** an estimate is held before each call, so one huge request, or fifty at once, can't blow past the cap.
- **Per run, per user, per day**, in any combination.
- **Fails closed:** a model with no price is refused, and a call it can't track throws. It never quietly counts as free.
- No dependencies. The SDKs are yours, and nothing is sent anywhere.

## Install

```bash
npm install spendcap
```

## Quick start

```ts
import OpenAI from "openai";
import { BudgetExceededError, createSpendCap } from "spendcap";

const cap = createSpendCap({
  limits: { run: 0.5, userDay: 5, day: 200 }, // USD
});

const client = cap.wrap(new OpenAI(), { user: "user_123" });

try {
  const reply = await client.chat.completions.create({
    model: "gpt-5.5",
    max_completion_tokens: 2000,
    messages: [{ role: "user", content: "Hello" }],
  });
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.log(error.limit, error.budget, error.spent, error.estimate);
  } else {
    throw error;
  }
}
```

Anthropic and Gemini work the same way:

```ts
const claude = cap.wrap(new Anthropic(), { user: "user_123" });
await claude.messages.create({ model: "claude-opus-5-5", max_tokens: 2000, messages });

const gemini = cap.wrap(new GoogleGenAI({ apiKey }), { user: "user_123" });
await gemini.models.generateContent({ model: "gemini-2.5-flash", contents: "Hello" });
```

## How a call is charged

1. **Estimate.** Input tokens are estimated from the request, and output is assumed to use all of `max_tokens`. Set a maximum on your requests: without one, the estimate assumes `defaultOutputTokens`.
2. **Hold.** The estimate is added to each limit. If any limit would be passed, the hold is undone and `BudgetExceededError` is thrown before anything is sent. Calls in flight count, so parallel calls can't all slip through.
3. **Settle.** When the response arrives, the hold is replaced by the real cost from its usage. For streams, that happens when you finish reading.

A call that fails is refunded. A call that returns no usage keeps the hold as its charge, and a stream you never read keeps its hold too.

The real cost can come in above the estimate, so a total can end slightly over its limit. The next call is then refused.

## Limits and scopes

| Limit | Applies to | Needs |
| --- | --- | --- |
| `run` | One run. Each `wrap()` gets its own run unless you pass `run`. | Nothing |
| `user` | One user, for as long as the store remembers. | `user` |
| `userDay` | One user, per UTC day. | `user` |
| `day` | Everything, per UTC day. | Nothing |

```ts
const client = cap.wrap(new OpenAI(), { user: "user_123", run: job.id });

await cap.spent({ user: "user_123", run: job.id }); // { run: 0.12, userDay: 1.5, day: 42 }
await cap.remaining({ user: "user_123", run: job.id });
```

## Several processes

The default store lives in memory, so each process has its own totals. To hold one cap across processes, pass a store. It needs an atomic `add` that returns the new total:

```ts
const store = {
  async add(key, delta, ttl) {
    const total = await redis.incrByFloat(key, delta);
    if (ttl) await redis.expire(key, ttl);
    return total;
  },
  async get(key) {
    const value = await redis.get(key);
    return value === null ? undefined : Number(value);
  },
};

createSpendCap({ limits, store });
```

## Calls you make yourself

For a provider or path `wrap()` doesn't cover, hold the money by hand:

```ts
const hold = await cap.reserve({ model: "gpt-5.5", input: messages, maxOutputTokens: 500 }, { user: "user_123" });
try {
  const response = await myCall();
  await hold.commit({ input: 900, output: 200, cacheRead: 100 });
} catch (error) {
  await hold.release();
  throw error;
}
```

`input` in `Usage` means uncached input tokens.

## Prices

The bundled table comes from [models.dev](https://models.dev), covering OpenAI, Anthropic and Google text models. `PRICES_AS_OF` says when it was built. A date or `-latest` on a model name is ignored when looking up its price, so `gpt-5.5-2026-04-23` finds `gpt-5.5`. Nothing else is guessed: a new model has no price until you add one or update the package.

```ts
createSpendCap({
  limits,
  pricing: { "my-azure-deployment": { input: 2.5, output: 10, cacheRead: 1.25 } }, // USD per million tokens
});
```

`pricing` can also be a function from model name to price. It's the way to use Bedrock, Vertex or Azure rates, which differ from the first-party ones.

To refresh the table in a checkout, run `npm run prices`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `limits` | required | USD limits: `run`, `user`, `userDay`, `day`. |
| `store` | in memory | Where totals live. |
| `pricing` | bundled table | More models, or a function that prices them. |
| `onUnknownModel` | `"throw"` | `"allow"` lets models with no price through at no cost. |
| `defaultOutputTokens` | `1024` | Output to assume when a request sets no maximum. |
| `onSpend(event)` | | Called after each charge with `provider`, `model`, `scope`, `cost`, `usage` and `estimated`. |

Also exported: `costOf()`, `priceFor()`, `estimateTokens()`, `memoryStore()`, `PRICES` and `UnknownModelError`.

## What it can't see

- **Covered paths:** `chat.completions.create` and `.parse`, `responses.create` and `.parse`, `messages.create`, `.parse` and `.stream` (and their `beta` forms), `models.generateContent` and `.generateContentStream`.
- **Refused paths:** `chat.completions.stream`, `responses.stream` and `beta.messages.toolRunner` throw, because they spend where the wrapper can't see. Use `create({ stream: true })` or `reserve()`.
- **Untracked paths:** embeddings, batches, audio, images, files and other endpoints pass straight through and aren't charged. Neither is a client you didn't wrap.
- **Prices cover plain text tokens.** Batch discounts, fast or priority tiers, audio, images, and server tools such as web search aren't modeled.
- **Server-side context isn't in the estimate.** With `previous_response_id` or a Gemini cached context, the estimate only sees what's in the request. The real usage is still charged afterwards.
- **`create()` returns a plain promise**, because the hold has to happen first. SDK extras on the returned promise, like `.withResponse()`, are gone.

It's a cost control, not a billing system. Set a limit at your provider too.

## License

MIT
