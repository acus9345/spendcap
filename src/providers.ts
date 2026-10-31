import type { Usage } from "./types.js";

type Params = Record<string, any>;

export interface Adapter {
  provider: "openai" | "anthropic" | "gemini";
  maxOutput(params: Params): number | undefined;
  /** Usage in a finished response. */
  usage(response: any): Partial<Usage> | undefined;
  /** Usage in one stream event. Later events overwrite earlier ones field by field. */
  event(event: any): Partial<Usage> | undefined;
  prepare?(params: Params): Params;
}

function defined(usage: Partial<Usage>): Partial<Usage> {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}

function openaiUsage(usage: any): Partial<Usage> | undefined {
  if (!usage) return undefined;
  const cached = (usage.prompt_tokens_details ?? usage.input_tokens_details)?.cached_tokens ?? 0;
  return {
    input: (usage.prompt_tokens ?? usage.input_tokens ?? 0) - cached,
    output: usage.completion_tokens ?? usage.output_tokens ?? 0,
    cacheRead: cached,
  };
}

function anthropicUsage(usage: any): Partial<Usage> | undefined {
  if (!usage) return undefined;
  return defined({
    input: usage.input_tokens ?? undefined,
    output: usage.output_tokens ?? undefined,
    cacheRead: usage.cache_read_input_tokens ?? undefined,
    cacheWrite: usage.cache_creation_input_tokens ?? undefined,
  });
}

function geminiUsage(usage: any): Partial<Usage> | undefined {
  if (!usage) return undefined;
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    input: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0) - cached,
    output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheRead: cached,
  };
}

const openaiChat: Adapter = {
  provider: "openai",
  maxOutput: (params) => params.max_completion_tokens ?? params.max_tokens,
  usage: (response) => openaiUsage(response?.usage),
  event: (event) => openaiUsage(event?.usage),
  // Without this, a chat stream never reports usage.
  prepare: (params) => (params.stream ? { ...params, stream_options: { ...params.stream_options, include_usage: true } } : params),
};

const openaiResponses: Adapter = {
  provider: "openai",
  maxOutput: (params) => params.max_output_tokens,
  usage: (response) => openaiUsage(response?.usage),
  event: (event) => openaiUsage(event?.response?.usage),
};

const anthropic: Adapter = {
  provider: "anthropic",
  maxOutput: (params) => params.max_tokens,
  usage: (response) => anthropicUsage(response?.usage),
  event: (event) => anthropicUsage(event?.message?.usage ?? event?.usage),
};

const gemini: Adapter = {
  provider: "gemini",
  maxOutput: (params) => params.config?.maxOutputTokens,
  usage: (response) => geminiUsage(response?.usageMetadata),
  event: (event) => geminiUsage(event?.usageMetadata),
};

/** Calls that cost money, by their path on the client. */
export const ROUTES: Record<string, Adapter> = {
  "chat.completions.create": openaiChat,
  "chat.completions.parse": openaiChat,
  "beta.chat.completions.parse": openaiChat,
  "responses.create": openaiResponses,
  "responses.parse": openaiResponses,
  "messages.create": anthropic,
  "messages.parse": anthropic,
  "beta.messages.create": anthropic,
  "beta.messages.parse": anthropic,
  "models.generateContent": gemini,
  "models.generateContentStream": gemini,
};

/** Stream helpers that start synchronously and return an event emitter. */
export const HELPERS: Record<string, Adapter> = {
  "messages.stream": anthropic,
  "beta.messages.stream": anthropic,
};

/** Calls that spend money where we can't see it. Failing beats a cap that silently doesn't work. */
export const BLOCKED: Record<string, string> = {
  "chat.completions.stream": "use chat.completions.create({ stream: true })",
  "beta.chat.completions.stream": "use chat.completions.create({ stream: true })",
  "responses.stream": "use responses.create({ stream: true })",
  "beta.messages.toolRunner": "run your own loop on messages.create, or use reserve()",
};

/** Objects on the way to a route. Everything else passes through untouched. */
export const PREFIXES = new Set(
  [...Object.keys(ROUTES), ...Object.keys(HELPERS), ...Object.keys(BLOCKED)].flatMap((path) => {
    const parts = path.split(".");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
  }),
);
