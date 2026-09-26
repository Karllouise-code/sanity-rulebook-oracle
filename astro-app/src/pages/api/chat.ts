import type { APIRoute } from 'astro';
import { answerQuestion, describeTools, getStatus } from '../../lib/rules-agent';

export const prerender = false;

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/chat — health + tool check. Confirms the MCP endpoint is reachable
 * in Knowledge Base mode and that initial_context / knowledge_base_read exist.
 */
export const GET: APIRoute = async () => {
  const status = getStatus();

  // Offline demo mode: skip the MCP handshake entirely.
  if (status.mock) {
    return json({
      ok: true,
      ...status,
      tools: ['initial_context', 'knowledge_base_read'],
      initialContext: true,
      knowledgeBaseRead: true,
    });
  }

  try {
    const tools = await describeTools();
    return json({ ok: true, ...status, ...tools });
  } catch (error) {
    return json({ ok: false, ...status, error: errorMessage(error) }, 500);
  }
};

/**
 * POST /api/chat — the agent loop. Body: `{ "question": "..." }`.
 */
export const POST: APIRoute = async ({ request }) => {
  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body?.question === 'string' ? body.question.trim() : '';
  } catch {
    return json({ ok: false, error: 'Request body must be JSON: { "question": "..." }' }, 400);
  }

  if (!question) return json({ ok: false, error: 'Missing "question".' }, 400);
  if (question.length > 500) return json({ ok: false, error: 'Question too long (max 500 characters).' }, 400);

  try {
    const result = await answerQuestion(question);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error('[chat]', errorMessage(error));
    return json(
      {
        ok: false,
        error: errorMessage(error),
        hint: 'Check SANITY_CONTEXT_MCP_URL and SANITY_ORGANIZATION_TOKEN in astro-app/.env.',
      },
      500
    );
  }
};