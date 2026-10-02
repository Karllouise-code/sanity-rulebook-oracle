# DEV Post — Path One: An Agent That Queries Real Content

*Draft for dev.to — Sanity Challenge, Path One. Final published post uses the official template sections: What I Built / Demo / Code / How I Used Sanity / Sanity Project Details (project id required).*

---

## What I Built

**Rulebook Oracle** — a chat agent that answers tabletop-game rules questions straight from a **Sanity Context Knowledge Base**, exposed over the **Context MCP endpoint** and wired into a minimal **Astro** app with the Vercel AI SDK.

It doesn't just answer — it *proves*. Every reply carries the exact rule sections, errata, and FAQ entries it was built from, with inline sources. When newer errata **overrides** the core rulebook, the UI stamps the answer with an **Override** badge and shows both claims side by side, so players always see what is actually in effect.

The rulebook is a full homebrew d6 fantasy system ("Steeldusk") that I wrote and seeded into Sanity: **37 rule sections, 10 errata (4 overrides + 6 clarifications), 10 FAQs**.

## Demo

**Live:** https://rulebook-oracle.netlify.app

Ask the Oracle anything, e.g. *"Can I attack twice if I wield two short swords?"*

The core rulebook says yes… but the 2025-03-01 errata **overrides** it: two-weapon fighting now grants advantage on a single attack instead. The Oracle surfaces the override, cites both entries, and stamps the answer:

> **Override** — *"Wielding two light weapons no longer grants a second attack. Instead it grants advantage on a single attack, and requires the Ambidextrous talent to attempt at all."*
> Sources: Two-Weapon Fighting (rule) · Two-Weapon Fighting rebalanced (errata, effective 2025-03-01)

Other good starter questions: "What happens when my Health hits 0?" (Wounds & Dying + the death-saves override) and "Is a natural 6 always a hit?" (natural 6 = two successes, not an auto-hit).

## How it works

1. **Content lives in Sanity** as typed schemas — `ruleSection`, `errataItem`, `faqItem`. The errata schema captures `changeType` (`clarify` / `override`) and `effectiveDate`, which is what makes "who wins?" decidable.
2. **Sanity Context ingests the dataset** into a Knowledge Base (13 consolidated entries) and exposes it through a managed **MCP endpoint** — the agent talks to Sanity over MCP, not a raw GROQ query.
3. **The agent loop** (`astro-app/src/lib/rules-agent.ts`) uses `createMCPClient` from `@ai-sdk/mcp`, discovers `initial_context`, `knowledge_base_search`, and `knowledge_base_read`, picks the relevant entry paths via the KB's own ranked search, and completes every user question *only* from the retrieved entries. An optional LLM summarizes with forced inline citations; otherwise (or when the model is rate-limited) answers are composed deterministically.
4. **Astro (SSR) chat app** renders answers, source cites, and Override/Clarify badges. Server-side rendering keeps the MCP token out of the browser. Deployed to Netlify via the `@astrojs/netlify` adapter.

## Setup

- Vercel AI SDK + `@ai-sdk/mcp` for the agent, `ai` for text generation, **Astro** + the `@astrojs/netlify` adapter for the server, **Sanity v6** schemas + seed runner.
- Everything is `createOrReplace` based — seeding is idempotent and transactional (57 docs, one call).
- The repo layout is a clean monorepo: `sanity/` and `astro-app/`, with `README.md` covering Sanity ⤳ Context ⤳ MCP ⤳ app from scratch.

## This shows Sanity Context + MCP working for real

- Content was **deposited in Sanity Context** and indexed by a real Knowledge Base.
- The agent connects to the **Context MCP server** (Knowledge Base mode) over HTTP with a `Bearer` org token.
- The MCP instructions define the agent behavioral contract ("always cite sources; if errata overrides a rule, state that clearly and show both claims") — and the app enforces it visually with the Override badge.

---

## Challenge details

Path: **Path One — Ship an Agent That Queries Real Content**

Sanity project id: `g2fvri91` | Dataset: `production` (default)
Knowledge base: **Rulebook Oracle KB** (`kblX52Exu3S8`) · MCP endpoint: **rulebook-oracle**
Repo: https://github.com/Karllouise-code/sanity-rulebook-oracle
Demo: https://rulebook-oracle.netlify.app (no video required — the template accepts a link to the deployed project)
Sanity dashboard: https://www.sanity.io/manage/project/g2fvri91

## Old README (replaced) — quick reference

For the full walkthrough (KB creation, MCP endpoint payload, env vars, deploy adapters, troubleshooting) see the root `README.md`.