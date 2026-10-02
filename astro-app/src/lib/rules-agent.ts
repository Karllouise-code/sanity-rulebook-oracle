import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';

/**
 * Read a config value from whichever runtime is present.
 * - Astro/Vite populates `import.meta.env` from `astro-app/.env`.
 * - Node-only hosts (Vercel/Netlify/standalone) set real `process.env`.
 * Prefer `import.meta.env` for local `.env` support, fall back to
 * `process.env` for OS/cloud-injected variables.
 */
function readEnv(key: string): string | undefined {
  const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const fromMeta = metaEnv && typeof metaEnv[key] === 'string' ? (metaEnv[key] as string) : undefined;
  return fromMeta || process.env[key] || undefined;
}

/**
 * Agent loop for the Rulebook Oracle.
 *
 * Flow (matches the Sanity Challenge Path One requirements):
 *   1. Connect to the Sanity Context MCP endpoint (Knowledge Base mode)
 *      using HTTP transport + Bearer Authorization header.
 *   2. Confirm `initial_context` and `knowledge_base_read` are exposed.
 *   3. On each question, call `knowledge_base_read` with a query derived
 *      from the user's message.
 *   4. Compose an answer that uses ONLY the retrieved entries, cites each
 *      entry, and flags errata entries whose changeType is 'override'.
 *
 * Two answer modes:
 *   - 'llm'        when GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY is
 *                  set (generateText summarizes; Gemini takes precedence).
 *   - 'retrieval'  otherwise                     (deterministic compose).
 *   - 'mock'       when RULEBOOK_MOCK=1          (offline UI demo, no Sanity).
 */

export type CitationKind = 'ruleSection' | 'errataItem' | 'faqItem';

export interface KbSource {
  title: string;
  kind: CitationKind;
  override: boolean;
}

export interface RetrievedEntry {
  id: string;
  kind: CitationKind;
  title: string;
  chapter?: string;
  changeType?: 'clarify' | 'override';
  effectiveDate?: string;
  sourceUrl?: string;
  content: string;
  sources?: KbSource[];
}

export interface Citation extends RetrievedEntry {
  override: boolean;
}

export interface AgentResult {
  answer: string;
  citations: Citation[];
  hasOverride: boolean;
  mode: 'llm' | 'retrieval' | 'mock';
  tools?: string[];
  modelUsed?: string;
}

const KB_READ_TOOL = 'knowledge_base_read';
const INITIAL_CONTEXT_TOOL = 'initial_context';
const OVERRIDE_RE = /\boverride\b/i;

/** Minimal shape of an AI SDK tool as used by this module. */
interface CallableTool {
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// MCP client (lazy singleton)
// ---------------------------------------------------------------------------

let clientPromise: Promise<MCPClient> | null = null;

function getClient(): Promise<MCPClient> {
  if (clientPromise) return clientPromise;

  const url = readEnv('SANITY_CONTEXT_MCP_URL');
  const token = readEnv('SANITY_ORGANIZATION_TOKEN');

  if (!url || !token) {
    throw new Error(
      'Missing MCP credentials. Set SANITY_CONTEXT_MCP_URL and SANITY_ORGANIZATION_TOKEN (see astro-app/.env.example).'
    );
  }

  clientPromise = createMCPClient({
    transport: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
    maxRetries: 1,
  });

  return clientPromise;
}

// ---------------------------------------------------------------------------
// Tool plumbing helpers
// ---------------------------------------------------------------------------

async function toolSet(): Promise<Record<string, CallableTool>> {
  const client = await getClient();
  return (await client.tools()) as unknown as Record<string, CallableTool>;
}

export async function describeTools(): Promise<{
  tools: string[];
  initialContext: boolean;
  knowledgeBaseRead: boolean;
}> {
  const client = await getClient();
  const listed = await client.listTools();
  const names = (listed?.tools ?? []).map((t) => t.name);
  return {
    tools: names,
    initialContext: names.includes(INITIAL_CONTEXT_TOOL),
    knowledgeBaseRead: names.includes(KB_READ_TOOL),
  };
}

// ---------------------------------------------------------------------------
// Knowledge Base outline + path selection
// ---------------------------------------------------------------------------
//
// The Context MCP endpoint in Knowledge Base mode exposes two tools:
//   - `initial_context`      -> a markdown outline with the knowledge base id
//                               and every entry's `path`.
//   - `knowledge_base_read`  -> `{ knowledgeBase, paths: string[] }` returning
//                               the full markdown content of those entries.
// There is no free-text search: to answer, we map the user's question onto
// outline paths with a lightweight keyword scorer. When an LLM key
// the LLM then composes the final answer from exactly the entries read.

const KB_ID_RE = /^Knowledge base id:\s*`?([A-Za-z0-9_-]+)`?/m;
const MAX_PATHS_READ = 4;

const OUTLINE_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'of', 'to',
  'for', 'on', 'in', 'at', 'by', 'with', 'without', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'may', 'might', 'will', 'shall', 'i', 'you', 'me', 'my', 'your', 'yours',
  'we', 'us', 'our', 'they', 'them', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
  'what', 'when', 'where', 'who', 'whom', 'which', 'why', 'how', 'if', 'then',
  'than', 'so', 'too', 'very', 'just', 'not', 'no', 'yes', 'want', 'need', 'does',
  'up', 'down', 'out', 'off', 'over', 'under', 'more', 'much', 'many', 'any', 'all',
  'every', 'each', 'both', 'either', 'neither', 'same', 'always', 'never', 'get',
  'gets', 'make', 'makes',
]);

const OUTLINE_SYNONYMS: Record<string, string> = {
  swords: 'weapon', sword: 'weapon', blades: 'weapon', blade: 'weapon',
  daggers: 'weapon', dagger: 'weapon', axes: 'weapon', axe: 'weapon',
  strikes: 'attack', strike: 'attack', swing: 'attack',
  twice: 'two',
  disadvantage: 'advantage', stack: 'advantage', stacking: 'advantage',
  hp: 'health', stamina: 'health', wounds: 'health', wound: 'health',
  injuries: 'health', injury: 'health', healing: 'health',
  dying: 'death', deaths: 'death', death: 'death', dead: 'death',
  unconscious: 'death', stabilize: 'death', stabilizes: 'death', stabilized: 'death',
  magic: 'spell', spells: 'spell', cast: 'spell', casting: 'spell',
  dice: 'roll', d6: 'roll', d6s: 'roll', rolls: 'roll', roll: 'roll',
  critical: 'roll', crit: 'roll', successes: 'roll', success: 'roll',
  turns: 'turn', actions: 'action', move: 'action',
  rests: 'rest', resting: 'rest',
};

interface OutlineEntry {
  path: string;
  description: string;
  topics: string[];
}

function outlineTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((w) => OUTLINE_SYNONYMS[w] ?? w)
      .filter((w) => w.length > 1 && !OUTLINE_STOPWORDS.has(w))
  );
}

function parseOutline(text: string): { kbId: string; entries: OutlineEntry[] } {
  const kb = text.match(KB_ID_RE);
  const entries: OutlineEntry[] = [];
  let current: OutlineEntry | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith(' ')) {
      if (line && current) {
        const topics = line.match(/^\s*topics:\s*(.+)$/i);
        if (topics) current.topics = topics[1].split(',').map((t) => t.trim());
        else if (!/^\s*(excludes|related):/i.test(line)) {
          current.description += ` ${line.trim()}`;
        }
      }
      continue;
    }
    const pathMatch = line.match(/^([a-z0-9_.-]+)(?:\/[a-z0-9_.-]+)*(?:\s+\[core\])?$/i);
    if (pathMatch) {
      current = { path: pathMatch[0].replace(/\s+\[core\]$/i, ''), description: '', topics: [] };
      entries.push(current);
    }
  }
  return { kbId: kb?.[1] ?? '', entries };
}

function selectPaths(question: string, entries: OutlineEntry[]): OutlineEntry[] {
  const q = outlineTokens(question);
  if (q.size === 0) return entries.slice(0, 1);
  const scored = entries.map((entry) => {
    const hay = outlineTokens(
      `${entry.path.replace(/[/_-]/g, ' ')} ${entry.description} ${entry.topics.join(' ')}`
    );
    let score = 0;
    for (const tok of q) {
      if (entry.path.toLowerCase().includes(tok)) score += 3;
      if (hay.has(tok)) score += 1;
    }
    return { entry, score };
  });
  const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return best.slice(0, MAX_PATHS_READ).map((s) => s.entry);
}

/** Extract the human-readable text from an MCP CallToolResult of any shape. */
function extractResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;

  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return (r.content as unknown[])
      .map((part) =>
        typeof part === 'string'
          ? part
          : ((part as Record<string, unknown>)?.text as string) ?? ''
      )
      .filter(Boolean)
      .join('\n');
  }
  if (r.toolResult !== undefined) return JSON.stringify(r.toolResult);
  if (typeof r.text === 'string') return r.text;
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Knowledge base entry parsing (markdown returned by knowledge_base_read)
// ---------------------------------------------------------------------------

const OVERRIDE_TAG_RE = /\[OVERRIDE\]/i;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseKbEntryMarkdown(blob: string): RetrievedEntry[] {
  const entries: RetrievedEntry[] = [];
  for (const section of blob.split(/\n(?=# )/)) {
    const entry = parseKbEntrySection(section);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseKbEntrySection(section: string): RetrievedEntry | null {
  const titleLine = section.match(/^#\s+(.+?)\s*$/m);
  if (!titleLine) return null;
  const title = titleLine[1].trim();

  let body = section.trim().replace(/^#\s+(.+?)\s*$/m, '').trim();
  const sources: KbSource[] = [];

  const sourcesMatch = body.match(/##\s+Sources\s*\r?\n([\s\S]*)$/);
  if (sourcesMatch) {
    body = body.replace(sourcesMatch[0], '').trim();
    for (const line of sourcesMatch[1].split(/\r?\n/)) {
      const parts = line.match(/^\d+\.\s+(.+?)\s+—\s+(.+)$/);
      if (!parts) continue;
      const sourceTitle = parts[1].trim();
      const isOverride = OVERRIDE_TAG_RE.test(sourceTitle);
      const clean = sourceTitle.replace(/^\[(?:OVERRIDE|CLARIFY)\]\s*/, '');
      const lower = clean.toLowerCase();
      const kind: CitationKind = /errata|original|superseded|override|clarif/i.test(clean)
        ? 'errataItem'
        : /^(faq|faqitem)|question/i.test(lower)
        ? 'faqItem'
        : 'ruleSection';
      sources.push({ title: clean, kind, override: isOverride });
    }
  }

  const hasOverride =
    sources.some((s) => s.override) || OVERRIDE_RE.test(body) || OVERRIDE_RE.test(title);

  return {
    id: slugify(title),
    kind: hasOverride ? 'errataItem' : 'ruleSection',
    title,
    changeType: hasOverride ? 'override' : undefined,
    content: body,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Knowledge Base fallback context (initial_context)
// ---------------------------------------------------------------------------

let contextFetched = false;
let cachedContext = '';

async function getInitialContext(): Promise<string> {
  if (contextFetched) return cachedContext;
  try {
    const tools = await toolSet();
    const initialContext = tools[INITIAL_CONTEXT_TOOL];
    if (initialContext?.execute) {
      cachedContext = extractResultText(await initialContext.execute({}));
    }
  } catch {
    cachedContext = ''; // non-fatal: proceed without the system context
  }
  contextFetched = true;
  return cachedContext;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

async function retrieveEntries(question: string): Promise<{ entries: RetrievedEntry[]; tools: string[] }> {
  const tools = await toolSet();
  const names = Object.keys(tools);
  const read = tools[KB_READ_TOOL];

  if (!read?.execute) {
    throw new Error(
      `The MCP endpoint does not expose "${KB_READ_TOOL}". ` +
        `Available tools: ${names.join(', ') || '(none)'}. ` +
        'Make sure the endpoint is in Knowledge Base mode and references the Rulebook Oracle KB.'
    );
  }

  // 1) Read the KB outline: it carries the knowledge base id + every entry path.
  const outlineText = await getInitialContext();
  const { kbId, entries: outlineEntries } = parseOutline(outlineText);
  if (!kbId || outlineEntries.length === 0) {
    throw new Error(
      'Could not read the Knowledge Base outline from the MCP endpoint. ' +
        'Rebuild your Knowledge Base and reconnect the endpoint.'
    );
  }

  // 2) Map the user's question onto entry paths.
  const selection = selectPaths(question, outlineEntries);
  if (selection.length === 0) {
    return { entries: [], tools: names };
  }
  const paths = selection.map((e) => e.path);

  // 3) Read the selected entries (path-based, in a single call).
  const result = await read.execute({ knowledgeBase: kbId, paths });
  const text = extractResultText(result);
  const entries = parseKbEntryMarkdown(text);
  return { entries, tools: names };
}

// ---------------------------------------------------------------------------
// Answer composition
// ---------------------------------------------------------------------------

function toCitation(entry: RetrievedEntry): Citation {
  return { ...entry, override: entry.changeType === 'override' };
}

/**
 * The KB read returns entries whose body already lists their sources (the
 * seeded rulebook/errata/FAQ docs). Expose those docs as the answer's
 * citations so the UI lists them individually and can flag OVERRIDE items.
 */
function entryToCitations(entry: RetrievedEntry): Citation[] {
  if (!entry.sources || entry.sources.length === 0) return [toCitation(entry)];
  return entry.sources.map((s) => ({
    id: s.title,
    kind: s.kind,
    title: s.title,
    changeType: s.override ? 'override' : undefined,
    content: entry.content,
    override: s.override,
  }));
}

function formatEntry(entry: RetrievedEntry, index: number): string {
  const tag = entry.kind === 'errataItem'
    ? entry.changeType === 'override' ? 'OVERRIDE - Errata' : 'Errata'
    : entry.kind === 'faqItem' ? 'FAQ' : 'Rule';
  const date = entry.effectiveDate ? ` (effective ${entry.effectiveDate})` : '';
  const href = entry.sourceUrl ? ` ${entry.sourceUrl}` : '';
  return `${index + 1}. [${tag}]${date} ${entry.title}${href}\n   ${entry.content}`;
}

function composeRetrievalAnswer(question: string, entries: RetrievedEntry[]): string {
  if (entries.length === 0) {
    return (
      "I couldn't find a rule section, errata entry, or FAQ that covers that " +
      'question in the Rulebook Oracle Knowledge Base. Try rephrasing, or ask ' +
      'about combat, magic, characters, or adventuring.'
    );
  }

  const body = entries.map(formatEntry).join('\n\n');
  const hasOverride = entries.some((e) => e.changeType === 'override');
  const note = hasOverride
    ? '\n\nNote: entries marked OVERRIDE replace the core rulebook text where they conflict.'
    : '';
  return `Here is what the rulebook, errata, and FAQs say about "${question}":\n\n${body}${note}`;
}

const SYSTEM_PROMPT = `You are the Rulebook Oracle, a rules assistant for the Steeldusk tabletop game.

You answer ONLY from the retrieved entries provided below. Never use outside knowledge.

Rules for every answer:
1. Answer strictly from the retrieved entries.
2. Cite each source you use by its exact title, and include its source URL when one is given.
3. If an entry is marked as an OVERRIDE and contradicts a core rulebook entry, say so explicitly: state both claims, then state that the override wins because it is newer errata.
4. If entries conflict but none is an override, report the conflict and say which entry is newest.
5. If nothing relevant was retrieved, say you don't have a ruling on that yet.
6. Keep the answer focused and conversational, aimed at a player at the table.`;

function formatForLlm(question: string, initialContext: string, entries: RetrievedEntry[]): { system: string; prompt: string } {
  const context = initialContext
    ? `\n\nKnowledge Base context from the MCP endpoint:\n${initialContext.trim()}\n`
    : '';
  const sources = entries.length
    ? entries.map(formatEntry).join('\n\n')
    : '(no entries were retrieved)';
  return {
    system: SYSTEM_PROMPT + context,
    prompt:
      `User question: ${question}\n\n` +
      `Retrieved entries (the ONLY sources you may use):\n${sources}`,
  };
}

function getLlmConfig(): { provider: 'google' | 'openai'; modelName: string } | null {
  if (readEnv('GOOGLE_GENERATIVE_AI_API_KEY')) {
    return { provider: 'google', modelName: readEnv('GEMINI_MODEL') || 'gemini-3.8-flash' };
  }
  if (readEnv('OPENAI_API_KEY')) {
    return { provider: 'openai', modelName: readEnv('OPENAI_MODEL') || 'gpt-4o-mini' };
  }
  return null;
}

async function composeLlmAnswer(question: string, initialContext: string, entries: RetrievedEntry[]): Promise<string> {
  const config = getLlmConfig();
  if (!config) throw new Error('No LLM provider configured');
  const { system, prompt } = formatForLlm(question, initialContext, entries);
  if (config.provider === 'google') {
    const google = createGoogleGenerativeAI({ apiKey: readEnv('GOOGLE_GENERATIVE_AI_API_KEY') ?? '' });
    const result = await generateText({ model: google(config.modelName), system, prompt, temperature: 0.2 });
    return result.text;
  }
  const openai = createOpenAI({ apiKey: readEnv('OPENAI_API_KEY') ?? '' });
  const result = await generateText({ model: openai(config.modelName), system, prompt, temperature: 0.2 });
  return result.text;
}

// ---------------------------------------------------------------------------
// Mock mode (local UI demo without a live Sanity endpoint)
// ---------------------------------------------------------------------------

const MOCK_ENTRIES: RetrievedEntry[] = [
  {
    id: 'ruleSection.two-weapon-fighting',
    kind: 'ruleSection',
    title: 'Two-Weapon Fighting',
    chapter: 'Combat',
    content:
      'A hero who fights with two light weapons may attack twice on their turn, once with each weapon. Both attacks are normal checks made with the same action.',
    sourceUrl: 'https://rules.steeldusk.example/rulebook#two-weapon-fighting',
  },
  {
    id: 'errataItem.e-twoweapon-override',
    kind: 'errataItem',
    title: 'Two-Weapon Fighting rebalanced',
    changeType: 'override',
    effectiveDate: '2025-03-01',
    content:
      'OVERRIDE: Wielding two light weapons no longer grants a second attack. Instead it grants advantage on a single attack, and requires the Ambidextrous talent to attempt at all.',
    sourceUrl: 'https://rules.steeldusk.example/errata/#two-weapon-fighting',
  },
];

function composeMockAnswer(question: string, entries: RetrievedEntry[]): string {
  return composeRetrievalAnswer(question, entries).replace(
    /^Here is what the rulebook/,
    '[mock mode] Here is what the rulebook'
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function answerQuestion(question: string): Promise<AgentResult> {
  const mockMode = readEnv('RULEBOOK_MOCK') === '1';

  if (mockMode) {
    return {
      answer: composeMockAnswer(question, MOCK_ENTRIES),
      citations: MOCK_ENTRIES.map(toCitation),
      hasOverride: MOCK_ENTRIES.some((e) => e.changeType === 'override'),
      mode: 'mock',
    };
  }

  const { entries, tools } = await retrieveEntries(question);
  const seenTitles = new Set<string>();
  const citations = entries
    .flatMap(entryToCitations)
    .filter((c) => {
      const key = `${c.kind}:${c.title}`;
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, 10);
  const hasOverride = entries.some((e) => e.changeType === 'override');

  if (entries.length === 0) {
    return {
      answer: composeRetrievalAnswer(question, entries),
      citations: [],
      hasOverride: false,
      mode: 'retrieval',
      tools,
    };
  }

  const llmConfig = getLlmConfig();
  if (llmConfig) {
    try {
      const initialContext = await getInitialContext();
      const answer = await composeLlmAnswer(question, initialContext, entries);
      return { answer, citations, hasOverride, mode: 'llm', tools, modelUsed: llmConfig.modelName };
    } catch (error) {
      // The summarizer (e.g. a rate-limited Gemini quota) is optional: if it
      // fails, answer deterministically from the retrieved entries instead of
      // erroring out at the table.
      return {
        answer:
          composeRetrievalAnswer(question, entries) +
          '\n\n(LLM summarizer unavailable — showing the retrieved entries verbatim.)',
        citations,
        hasOverride,
        mode: 'retrieval',
        tools,
        modelUsed: llmConfig.modelName,
      };
    }
  }

  return {
    answer: composeRetrievalAnswer(question, entries),
    citations,
    hasOverride,
    mode: 'retrieval',
    tools,
  };
}

/** Config status for the health endpoint (no network I/O). */
export function getStatus(): {
  urlConfigured: boolean;
  tokenConfigured: boolean;
  llmConfigured: boolean;
  mock: boolean;
} {
  return {
    urlConfigured: Boolean(readEnv('SANITY_CONTEXT_MCP_URL')),
    tokenConfigured: Boolean(readEnv('SANITY_ORGANIZATION_TOKEN')),
    llmConfigured: getLlmConfig() !== null,
    mock: readEnv('RULEBOOK_MOCK') === '1',
  };
}