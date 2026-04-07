---
name: bird
description: X/Twitter CLI for reading, searching, posting, and engagement via cookies.
homepage: https://github.com/leavingme/bird
metadata: {"clawdbot":{"emoji":"🐦","requires":{"bins":["bird"]},"install":[{"id":"npm","kind":"node","package":"@leavingme/bird","bins":["bird"],"label":"Install bird (npm)"}]}}
---

# bird 🐦 (leavingme fork)

Fork of @steipete/bird - Fast X/Twitter CLI using GraphQL + cookie auth.

**Note**: The original [steipete/bird](https://github.com/steipete/bird) repository is no longer accessible. This is a fork of the npm package `@steipete/bird@0.8.0` with the compiled distribution.

## Install

```bash
npm install -g @leavingme/bird
# or use directly with npx
npx @leavingme/bird whoami
```

## Auth Tokens

Requires `auth_token` and `ct0` cookies from Twitter. Set via environment variables:
- `AUTH_TOKEN`
- `CT0`

Or via CLI flags: `--auth-token`, `--ct0`

## Key Commands

```bash
# News & Trending (with AI summaries)
bird news --ai-only -n 5 --with-ai-summary   # Get AI trends with Grok summaries
bird news --for-you -n 10                     # For You tab trends
bird news --news-only -n 5                    # News tab only

# Search
bird search "query" -n 10

# Read tweets
bird read <tweet-id-or-url>
bird thread <tweet-id>

# Post
bird tweet "Hello world"
bird reply <tweet-id> "Reply text"
```

## New Feature: --with-ai-summary

Uses `AiTrendByRestId` API to fetch AI-generated summaries (Grok-written) for trends. This provides:
- AI-curated summary of the trend
- Disclaimer that content may evolve

```bash
bird news --ai-only -n 3 --with-ai-summary
```

## Original README

See [README.md](./README.md) for full documentation.

## Source

- GitHub: https://github.com/leavingme/bird
- npm: https://www.npmjs.com/package/@leavingme/bird
