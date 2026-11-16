// The native ChatGPT passthrough calls magpie.hooks, but skips magpie.middleware.
// Filter only outgoing native history; never modify the Codex rollout or reply.

const PORTABLE_ITEMS = new Set([
  'message', 'agent_message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'tool_search_call',
  'tool_search_output', 'additional_tools',
]);
const OPAQUE_ITEMS = new Set([
  'compaction', 'context_compaction', 'item_reference',
]);

function nativeRequest(body, ctx) {
  if (ctx.protocol !== 'responses' || !Array.isArray(body?.input)) return false;
  const path = (ctx.path || '').replace(/\/+$/, '');
  if (!['/backend-api/codex/responses', '/v1/responses'].includes(path)) return false;
  // /v1/responses is shared by other clients; require Magpie's Codex identity.
  if (path === '/v1/responses' && ctx.agent !== 'codex') return false;
  const model = body.model;
  return typeof model === 'string' &&
    (!model.includes('/') || model.startsWith('codex/'));
}

function opaqueContent(item) {
  if (!item || typeof item !== 'object') return false;
  if (OPAQUE_ITEMS.has(item.type)) return true;
  if (item.type !== 'reasoning' && item.encrypted_content) return true;
  return Array.isArray(item.content) &&
    item.content.some(part => part?.type === 'encrypted_content');
}

function recordedSearch(item) {
  const record = {...item};
  delete record.type;
  delete record.id;
  delete record.internal_chat_message_metadata_passthrough;
  delete record.encrypted_content;
  return {
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: '[Recorded web search from earlier in this conversation. ' +
        'The following is recorded activity, not a new tool call; ' +
        'only the originally recorded search data is available.]\n' +
        JSON.stringify(record),
    }],
  };
}

export async function onRequest(body, ctx) {
  if (!nativeRequest(body, ctx)) return;
  if (body.previous_response_id || body.conversation ||
      body.input.some(opaqueContent)) {
    // A hook cannot reject. Keep opaque context intact and report the limit.
    ctx.report?.('native-history-opaque-context', 0);
    return;
  }

  let changed = false;
  const input = [];
  for (const item of body.input) {
    if (item?.type === 'reasoning') {
      changed = true;
      continue;
    }
    if (item?.type === 'web_search_call') {
      input.push(recordedSearch(item));
      changed = true;
      continue;
    }
    if (item && typeof item === 'object' && item.id &&
        (PORTABLE_ITEMS.has(item.type) ||
         (!item.type && typeof item.role === 'string' && item.content !== undefined))) {
      const portable = {...item};
      delete portable.id;
      input.push(portable);
      changed = true;
    } else {
      input.push(item);
    }
  }
  if (!changed) return;
  const clean = {...body, input};
  ctx.report?.('native-history-filtered', new TextEncoder().encode(JSON.stringify(clean)).byteLength);
  return clean;
}
