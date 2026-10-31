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
/** Calls that cost money, by their path on the client. */
export declare const ROUTES: Record<string, Adapter>;
/** Stream helpers that start synchronously and return an event emitter. */
export declare const HELPERS: Record<string, Adapter>;
/** Calls that spend money where we can't see it. Failing beats a cap that silently doesn't work. */
export declare const BLOCKED: Record<string, string>;
/** Objects on the way to a route. Everything else passes through untouched. */
export declare const PREFIXES: Set<string>;
export {};
