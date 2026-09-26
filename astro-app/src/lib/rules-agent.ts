import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';

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
 *   - 'llm'        when OPENAI_API_KEY is set  (generateText summarizes).
 *   - 'retrieval'  otherwise                     (deterministic compose).
 *   - 'mock'       when RULEBOOK_MOCK=1          (offline UI demo, no Sanity).
 */

export type CitationKind = 'ruleSection' | 'errataItem' | 'faqItem';

export interface RetrievedEntry {
  id: string;
  kind: CitationKind;
  title: string;
  chapter?: string;
  changeType?: 'clarify' | 'override';
  effectiveDate?: string;
  sourceUrl?: string;
  content: string;
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

  const url = process.env.SANITY_CONTEXT_MCP_URL;
  const token = process.env.SANITY_ORGANIZATION_TOKEN;

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

/**
 * Build the arguments for the MCP tool from its input schema. Prefers a
 * query-ish property; caps result-count properties at 6. Falls back to a
 * plain `{ query }` when the schema doesn't advertise any properties.
 */
function buildQueryArgs(tool: CallableTool | undefined, text: string): Record<string, unknown> {
  const properties = (tool?.inputSchema?.properties as Record<string, unknown>) ?? {};
  const keys = Object.keys(properties);

  if (keys.length === 0) return { query: text };

  const args: Record<string, unknown> = {};
  for (const key of keys) {
    if (/query|question|prompt|search|text/i.test(key)) args[key] = text;
    else if (/(limit|top|maxresults|count|k)\b/i.test(key) || key === 'k' || key === 'topK') args[key] = 6;
  }
  if (Object.keys(args).length === 0) args[keys[0]] = text;
  return args;
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
// Retrieval normalization
// ---------------------------------------------------------------------------

function asArray(value: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  const obj = value as Record<string, unknown> | null;
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return null;
}

function pick(obj: unknown, keys: string[]): unknown {
  const o = obj as Record<string, unknown> | null;
  if (!o) return undefined;
  for (const key of keys) {
    if (o[key] !== undefined && o[key] !== null && o[key] !== '') return o[key];
  }
  return undefined;
}

function firstString(obj: unknown, keys: string[]): string {
  const value = pick(obj, keys);
  return typeof value === 'string' ? value : value instanceof Object ? JSON.stringify(value) : '';
}

function parseStructuredCandidates(rawText: string, rawResult: unknown): unknown[] | null {
  const r = rawResult as Record<string, unknown> | null;
  const container = r?.structuredContent ?? r?.toolResult;
  const fromContainer = asArray(container, ['entries', 'results', 'items', 'sources', 'data']);
  if (fromContainer) return fromContainer;

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return asArray(parsed, ['entries', 'results', 'items', 'sources', 'data']);
  } catch {
    return null;
  }
}

function normalizeChangeType(entry: unknown, kind: CitationKind, title: string, content: string): 'clarify' | 'override' | undefined {
  const value = pick(entry, ['changeType', 'change_type']);
  if (value === 'override' || value === 'clarify') return value;
  if (kind !== 'errataItem') return undefined;
  if (OVERRIDE_RE.test(title) || OVERRIDE_RE.test(content)) return 'override';
  if (/\bclarif/i.test(title) || /\bclarification/i.test(content)) return 'clarify';
  return undefined;
}

function toEntry(item: unknown): RetrievedEntry | null {
  if (typeof item === 'string') {
    return { id: 'retrieved-context', kind: 'ruleSection', title: 'Retrieved context', content: item };
  }
  if (!item || typeof item !== 'object') return null;

  const obj = item as Record<string, unknown>;
  const content = firstString(obj, ['content', 'body', 'text', 'summary', 'answer']);
  const title = firstString(obj, ['title', 'name', 'question']).replace(/^\[(?:OVERRIDE|CLARIFY)\]\s*/, '');
  if (!content) return null;

  const typeStr = firstString(obj, ['_type', 'type', 'sourceType', 'documentType']);
  const isErrata = /errata/i.test(typeStr) || obj.changeType !== undefined || /override|clarif/i.test(title);
  const isFaq = /faq/i.test(typeStr) || obj.question !== undefined;

  let kind: CitationKind = 'ruleSection';
  if (isErrata) kind = 'errataItem';
  else if (isFaq) kind = 'faqItem';

  return {
    id: firstString(obj, ['id', '_id', 'slug', 'url', 'uri']) || title,
    kind,
    title: title || 'Untitled entry',
    chapter: firstString(obj, ['chapter', 'section', 'category']) || undefined,
    changeType: normalizeChangeType(obj, kind, title, content),
    effectiveDate: firstString(obj, ['effectiveDate', 'effective_date', 'date']) || undefined,
    sourceUrl: firstString(obj, ['sourceUrl', 'source_url', 'url', 'uri']) || undefined,
    content: content.trim(),
  };
}

/**
 * Turn whatever knowledge_base_read returned into a uniform entry list.
 * Handles structured JSON results and plain Markdown text results.
 */
export function normalizeEntries(rawText: string, rawResult: unknown): RetrievedEntry[] {
  const candidates = parseStructuredCandidates(rawText, rawResult);

  if (candidates) {
    const entries = candidates.map(toEntry).filter((e): e is RetrievedEntry => e !== null);
    if (entries.length > 0) return entries;
  }

  if (rawText.trim()) {
    return [
      {
        id: 'retrieved-context',
        kind: 'ruleSection',
        title: 'Retrieved context',
        content: rawText.trim(),
      },
    ];
  }

  return [];
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
      cachedContext = extractResultText(
        await initialContext.execute(buildQueryArgs(initialContext, ''))
      );
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

  const result = await read.execute(buildQueryArgs(read, question));
  return { entries: normalizeEntries(extractResultText(result), result), tools: names };
}

// ---------------------------------------------------------------------------
// Answer composition
// ---------------------------------------------------------------------------

function toCitation(entry: RetrievedEntry): Citation {
  return { ...entry, override: entry.changeType === 'override' };
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

async function composeLlmAnswer(question: string, initialContext: string, entries: RetrievedEntry[]): Promise<string> {
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { system, prompt } = formatForLlm(question, initialContext, entries);
  const result = await generateText({ model: openai(modelName), system, prompt, temperature: 0.2 });
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
  const mockMode = process.env.RULEBOOK_MOCK === '1';

  if (mockMode) {
    return {
      answer: composeMockAnswer(question, MOCK_ENTRIES),
      citations: MOCK_ENTRIES.map(toCitation),
      hasOverride: MOCK_ENTRIES.some((e) => e.changeType === 'override'),
      mode: 'mock',
    };
  }

  const { entries, tools } = await retrieveEntries(question);
  const citations = entries.map(toCitation);
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

  const llmEnabled = Boolean(process.env.OPENAI_API_KEY);
  if (llmEnabled) {
    const initialContext = await getInitialContext();
    const answer = await composeLlmAnswer(question, initialContext, entries);
    return { answer, citations, hasOverride, mode: 'llm', tools, modelUsed: process.env.OPENAI_MODEL || 'gpt-4o-mini' };
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
    urlConfigured: Boolean(process.env.SANITY_CONTEXT_MCP_URL),
    tokenConfigured: Boolean(process.env.SANITY_ORGANIZATION_TOKEN),
    llmConfigured: Boolean(process.env.OPENAI_API_KEY),
    mock: process.env.RULEBOOK_MOCK === '1',
  };
}