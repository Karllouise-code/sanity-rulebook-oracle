# DEV Post — Path One: An Agent That Queries Real Content

*Draft for dev.to — Sanity Challenge, Path One. Paste the "Transcript" inside the story area or link a hosted demo video instead.*

---

## What I built

**Rulebook Oracle** — a chat agent that answers tabletop-game rules questions straight from a **Sanity Context Knowledge Base**, exposed over the **Context MCP endpoint** and wired into a minimal **Astro** app with the Vercel AI SDK.

It doesn't just answer — it *proves*. Every reply carries the exact rule sections, errata, and FAQ entries it was built from, with inline sources. When newer errata **overrides** the core rulebook, the UI stamps the answer with an **Override** badge and shows both claims side by side, so players always see what is actually in effect.

The rulebook is a full homebrew d6 fantasy system ("Steeldusk") that I wrote and seeded into Sanity: **37 rule sections, 10 errata (4 overrides + 6 clarifications), 10 FAQs**.

## The demo

Ask the Oracle anything, e.g. *"Can I attack twice if I wield two short swords?"*

The core rulebook says yes… but the 2025-03-01 errata **overrides** it: two-weapon fighting now grants advantage on a single attack instead. The Oracle surfaces the override, cites both entries, and stamps the answer:

> **Override** — *"Wielding two light weapons no longer grants a second attack. Instead it grants advantage on a single attack, and requires the Ambidextrous talent to attempt at all."*
> Sources: Two-Weapon Fighting (rule) · Two-Weapon Fighting rebalanced (errata, effective 2025-03-01)

## How it works

1. **Content lives in Sanity** as typed schemas — `ruleSection`, `errataItem`, `faqItem`. The errata schema captures `changeType` (`clarify` / `override`) and `effectiveDate`, which is what makes "who wins?" decidable.
2. **Sanity Context ingests the dataset** into a Knowledge Base and exposes it through a managed **MCP endpoint** — the agent talks to Sanity over MCP, not a raw GROQ query.
3. **The agent loop** (`astro-app/src/lib/rules-agent.ts`) uses `createMCPClient` from `@ai-sdk/mcp`, discovers `initial_context` + `knowledge_base_read`, and completes every user question *only* from the retrieved entries. An optional LLM summarizes with forced inline citations; otherwise answers are composed deterministically.
4. **Astro (SSR) chat app** renders answers, source cites, and Override/Clarify badges. Server-side rendering keeps the MCP token out of the browser.

## Setup

- Vercel AI SDK + `@ai-sdk/mcp` for the agent, `ai` for text generation, **Astro** + the `@astrojs/node` adapter for the server, **Sanity v5** schemas + seed runner.
- Everything is `createOrReplace` based — seeding is idempotent and transactional (57 docs, one call).
- The repo layout is a clean monorepo: `sanity/` and `astro-app/`, with `README.md` covering Sanity ⤳ Context ⤳ MCP ⤳ app from scratch.

## This shows Sanity Context + MCP working for real

- Content was **deposited in Sanity Context** and indexed by a real Knowledge Base.
- The agent connects to the **Context MCP server** (Knowledge Base mode) over HTTP with a `Bearer` org token.
- The MCP instructions define the agent behavioral contract ("always cite sources; if errata overrides a rule, state that clearly and show both claims") — and the app enforces it visually with the Override badge.

---

## Challenge details

Path: **Path One — Ship an Agent That Queries Real Content**

Sanity project id: `REPLACE_WITH_PROJECT_ID` | Dataset: `production` (default)
Knowledge base: **Rulebook Oracle KB** (`kb_REPLACE`) · MCP endpoint: **rulebook-oracle**

Demo video: `REPLACE_WITH_LINK` (screen recording + [transcript REPLACE])
Sanity dashboard: `REPLACE_WITH_MANAGE_LINK`

*Transcript: swap this paragraph for a full .vtt/verbatim transcript of the demo. I narrate over a recorded run: open the app → ask the two-weapon diagram question → point at the Override badge and the two citations → show the KB build in Sanity Context → show the endpoint id + URL.*

## Old README (replaced) — quick reference

For the full walkthrough (KB creation, MCP endpoint payload, env vars, deploy adapters, troubleshooting) see the root `README.md`.