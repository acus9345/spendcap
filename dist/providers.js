function defined(usage) {
    return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}
function openaiUsage(usage) {
    if (!usage)
        return undefined;
    const prompt = usage.prompt_tokens ?? usage.input_tokens;
    const output = usage.completion_tokens ?? usage.output_tokens;
    if (prompt === undefined && output === undefined)
        return undefined;
    const cached = (usage.prompt_tokens_details ?? usage.input_tokens_details)?.cached_tokens ?? 0;
    return {
        input: Math.max(0, (prompt ?? 0) - cached),
        output: output ?? 0,
        cacheRead: cached,
    };
}
function anthropicUsage(usage) {
    if (!usage)
        return undefined;
    const out = defined({
        input: usage.input_tokens ?? undefined,
        output: usage.output_tokens ?? undefined,
        cacheRead: usage.cache_read_input_tokens ?? undefined,
        cacheWrite: usage.cache_creation_input_tokens ?? undefined,
    });
    return Object.keys(out).length > 0 ? out : undefined;
}
function geminiUsage(usage) {
    if (!usage)
        return undefined;
    if (usage.promptTokenCount === undefined &&
        usage.toolUsePromptTokenCount === undefined &&
        usage.candidatesTokenCount === undefined &&
        usage.thoughtsTokenCount === undefined &&
        usage.cachedContentTokenCount === undefined) {
        return undefined;
    }
    const cached = usage.cachedContentTokenCount ?? 0;
    return {
        input: Math.max(0, (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0) - cached),
        output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        cacheRead: cached,
    };
}
const openaiChat = {
    provider: "openai",
    maxOutput: (params) => params.max_completion_tokens ?? params.max_tokens,
    usage: (response) => openaiUsage(response?.usage),
    event: (event) => openaiUsage(event?.usage),
    // Without this, a chat stream never reports usage.
    prepare: (params) => (params.stream ? { ...params, stream_options: { ...params.stream_options, include_usage: true } } : params),
};
const openaiResponses = {
    provider: "openai",
    maxOutput: (params) => params.max_output_tokens,
    usage: (response) => openaiUsage(response?.usage),
    event: (event) => openaiUsage(event?.response?.usage),
};
const anthropic = {
    provider: "anthropic",
    maxOutput: (params) => params.max_tokens,
    usage: (response) => anthropicUsage(response?.usage),
    event: (event) => anthropicUsage(event?.message?.usage ?? event?.usage),
};
const gemini = {
    provider: "gemini",
    maxOutput: (params) => params.config?.maxOutputTokens,
    usage: (response) => geminiUsage(response?.usageMetadata),
    event: (event) => geminiUsage(event?.usageMetadata),
};
/** Calls that cost money, by their path on the client. */
export const ROUTES = {
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
export const HELPERS = {
    "messages.stream": anthropic,
    "beta.messages.stream": anthropic,
};
/** Calls that spend money where we can't see it. Failing beats a cap that silently doesn't work. */
export const BLOCKED = {
    "chat.completions.stream": "use chat.completions.create({ stream: true })",
    "beta.chat.completions.stream": "use chat.completions.create({ stream: true })",
    "responses.stream": "use responses.create({ stream: true })",
    "beta.messages.toolRunner": "run your own loop on messages.create, or use reserve()",
};
/** Objects on the way to a route. Everything else passes through untouched. */
export const PREFIXES = new Set([...Object.keys(ROUTES), ...Object.keys(HELPERS), ...Object.keys(BLOCKED)].flatMap((path) => {
    const parts = path.split(".");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
}));
