# Rulebook Oracle

Sanity Challenge — **Path One: Ship an Agent That Queries Real Content**.
A rules-answer agent for a homebrew tabletop game, powered by a **Sanity Knowledge Base + Context MCP endpoint** and wrapped in a minimal **Astro** chat app with the **Vercel AI SDK**.

Every answer cites the exact rule sections / errata / FAQs it came from, and when newer errata **overrides** the core rulebook, the UI shows an **Override** badge.

> Game content is a 100% homebrew d6 fantasy ruleset ("Steeldusk") so we own it outright — no SRD attribution needed.

## Repo layout

```
SanityChallenge/
├── astro-app/            # Astro site (SSR) + agent loop (@ai-sdk/mcp)
│   ├── src/lib/rules-agent.ts    # MCP client + Knowledge Base agent loop
│   ├── src/pages/index.astro     # chat UI
│   └── src/pages/api/chat.ts     # GET health / POST agent endpoint
├── sanity/               # Sanity schemas + seed content
│   ├── schemaTypes/      # ruleSection, errataItem, faqItem
│   ├── seed/content.js   # 37 rule sections, 10 errata, 10 FAQs
│   └── seed/seed.js      # idempotent seeder (createOrReplace, dry-run able)
├── docs/DEV-post-path-one.md     # dev.to submission draft
└── README.md
```

## Prerequisites

- Node **20.19+ or 22.12+** (verified against Node 20.19.3)
- A Sanity project with **Context enabled** for your organization (Context is a pre-GA feature flag — reach out to Sanity to have it enabled on your org)
- A Sanity organization API token with **Context Viewer** permission

---

## 1. Sanity: deploy schemas + seed content

```bash
cd sanity
npm install

# 1) Link your project (writes projectId/dataset into sanity.cli.ts),
#    or provide env vars instead: SANITY_PROJECT_ID, SANITY_DATASET
npx sanity init --create-project "Rulebook Oracle" --dataset production

# 2) Deploy the GraphQL schema (challenge step; also validates types)
npx sanity schema deploy

# 3) Set a write-capable API token for seeding
#    Sanity Dashboard → API → Tokens → Add API token
#    export SANITY_PROJECT_ID=<id> SANITY_DATASET=production SANITY_TOKEN=sk...

# 4) Dry-run first, then seed for real
node seed/seed.js --dry-run
node seed/seed.js
```

The seed writes **37 rule sections, 10 errata (4 = `override`, 6 = `clarify`), 10 FAQs** using deterministic `_id`s + `createOrReplace`, so re-running updates in place (no duplicates) and is atomic (one transaction). It aborts unless at least one `override` errata exists, and prints demo questions when done.

Verified counts:

| type | schema | count |
| --- | --- | --- |
| `ruleSection` | `sanity/schemaTypes/ruleSection.ts` | 37 |
| `errataItem` | `sanity/schemaTypes/errataItem.ts` | 10 |
| `faqItem` | `sanity/schemaTypes/faqItem.ts` | 10 |

## 2. Sanity Context: Knowledge Base + MCP endpoint (Dashboard)

**Enable Context** in your org if you haven't (see Prerequisites), then:

1. **Sanity Dashboard → Context → New knowledge base**
   - Title: **Rulebook Oracle KB**
   - Purpose: **Player-facing rules assistant that answers questions from the core rulebook, errata, and FAQs, citing sources and flagging overrides.**
   - Add source → **Dataset** → pick your project + the `production` dataset
   - **Build entries**, review them, and copy the **Knowledge Base ID** (starts `kb_…`).
2. **In the Context app, create an MCP endpoint**
   - Name: `rulebook-oracle`
   - Sources:
     ```json
     [{ "type": "knowledge-base", "id": "kb_<YOUR_KB_ID>" }]
     ```
   - Instructions:
     **Only answer rules questions for this game. Always cite sources. If errata overrides a rule, state that clearly and show both claims.**
   - Record the endpoint URL:
     ```
     https://api.sanity.io/v1/context/organizations/<ORG_ID>/mcp/rulebook-oracle
     ```
     (`<ORG_ID>` is the id in your org's dashboard URL, `sanity.io/manage/personal/project/<id>…/organization/<ORG_ID>`.)

The deposit content in the Knowledge Base is rebuilt from the dataset, so re-running the seed → **Context → (your KB) → rebuild** keeps the agent in sync.

## 3. Astro app: run locally

```bash
cd astro-app
npm install
cp .env.example .env
```

then fill in `.env`:

```dotenv
SANITY_CONTEXT_MCP_URL=https://api.sanity.io/v1/context/organizations/<ORG_ID>/mcp/rulebook-oracle
SANITY_ORGANIZATION_TOKEN=sk_<token with Context Viewer>

# Optional — lets the LLM summarize retrieved entries instead of the
# deterministic composer. Either way answers are built ONLY from the
# retrieved entries and citations are always returned.
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Optional — offline UI demo powered by built-in entries (no Sanity needed).
RULEBOOK_MOCK=1
```

Run (SSR on the Node adapter — tokens never touch the browser):

```bash
npm run dev            # http://localhost:4321
```

- `GET /api/chat` — health + tool check; confirms `initial_context` and `knowledge_base_read` are exposed by your endpoint.
- `POST /api/chat` — `{ "question": "..." }` → `{ answer, citations[], hasOverride, mode }`.

**Try these** (the first two exercise overrides):

1. Can I attack twice if I wield two short swords? *(override demo)*
2. What happens when my Health hits 0? *(override demo)*
3. Does advantage from high ground stack with advantage from a spell?
4. Is a natural 6 always a hit?
5. How many actions do I get on my turn?
6. Can a Cleric save a dying ally?
7. How do I gain a new talent?
8. Does hiding behind a wall fully block arrows?

## How the agent loop works

`astro-app/src/lib/rules-agent.ts`:

1. Creates the MCP client via `createMCPClient({ transport: { type: 'http', url, headers } })` with a `Bearer` org token — this is **Knowledge Base mode**, not raw GROQ.
2. Pulls `client.tools()` and asserts `initial_context` + `knowledge_base_read` exist.
3. Feeds each user question into `knowledge_base_read` (arguments built from the tool's own input schema).
4. Normalizes whatever the tool returns (structured entries or Markdown JSON) into uniform `{title, kind, changeType, sourceUrl, content}` entries.
5. Composes an answer that uses **only** those entries:
   - **LLM mode** (`OPENAI_API_KEY` set): `generateText` with a system prompt that forces inline citations and explicit override-vs-rulebook statements; the endpoint's `initial_context` is injected too.
   - **Retrieval mode**: deterministic composer that lists each retrieved entry with its source.
   - **Mock mode** (`RULEBOOK_MOCK=1`): canned entries for an offline UI demo.
6. Returns structured `citations` (`changeType`, `sourceUrl`, `override` flag) so the UI renders **Override / Clarify** badges.

## Quality checks

```bash
# Astro app
cd astro-app && npm run check && npm run build

# Sanity (schemas type-check) + seed sanity check
cd sanity && npm run check && node seed/seed.js --dry-run
```

## Deploying

The Astro app uses the `@astrojs/node` standalone adapter by default. For serverless hosts, swap the adapter in `astro-app/astro.config.mjs`:

- **Vercel:** `npm i @astrojs/vercel` → `adapter: vercel()` → `vercel deploy`
- **Netlify:** `npm i @astrojs/netlify` → `adapter: netlify()` → `netlify build`

Set the same env vars in the host's dashboard. Make sure the Sanity endpoint is reachable from the host (no IP allowlisting issues) and that the org token is scoped to **Context Viewer**.

## Notes & troubleshooting

- The `sourceUrl` values in the seed point at a fictional rules site (`rules.steeldusk.example`) — swap them for a real URL if you publish your own rulebook. They exist so citation links render in the demo.
- **"knowledge_base_read is not exposed"** → the endpoint is in Agent mode, or its sources don't include the KB. Recreate it in **Knowledge Base mode** and rebuild the KB.
- **401/403 from the endpoint** → token lacks **Context Viewer** permission, or `<ORG_ID>` in the URL is wrong.
- **Dangerfield: citations are empty** although the agent answered → the tool returned plain Markdown; check `seed` content is being indexed by your KB, then rebuild the KB.