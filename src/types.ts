/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  /** Cached input. Falls back to `input`. */
  cacheRead?: number;
  /** Writing to the cache. Falls back to `input`. */
  cacheWrite?: number;
}

export interface Price extends Rates {
  /** Higher rates that apply to the whole request above this many input tokens. */
  over?: Rates & { tokens: number };
}

export interface Usage {
  /** Input tokens that were not cached. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
