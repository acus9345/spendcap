# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-31

### Added

- `createSpendCap(options)` with `wrap()`, `reserve()`, `spent()` and `remaining()`.
- Limits per run, per user, per day and per user per day.
- Wrappers for the OpenAI, Anthropic and Google Gen AI SDKs, including streams and prompt caching.
- An estimate held before each call, settled from the real usage in the response.
- A price table for OpenAI, Anthropic and Google text models, built from models.dev, with `npm run prices` to refresh it.
- `BudgetExceededError`, `UnknownModelError`, `costOf()`, `priceFor()`, `estimateTokens()` and `memoryStore()`.
