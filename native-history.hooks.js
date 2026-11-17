// The native ChatGPT passthrough calls magpie.hooks, but skips magpie.middleware.
// Filter only outgoing native history; never modify the Codex rollout or reply.

const PORTABLE_ITEMS = new Set([
  'message', 'agent_message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'tool_search_call',
  'tool_search_output', 'additional_tools',
  'computer_call_output', 'shell_call', 'shell_call_output',
  'apply_patch_call', 'apply_patch_call_output', 'mcp_approval_response',
]);
const COMPACTION_ITEMS = new Set(['compaction', 'context_compaction', 'compaction_summary']);

function nativeRequest(body, ctx) {
  if (ctx.protocol !== 'responses' || !Array.isArray(body?.input)) return false;
  const path = (ctx.path || '').replace(/\/+$/, '');
  if (!['/backend-api/codex/responses', '/v1/responses', '/responses'].includes(path)) return false;
  // Shared Responses endpoints require Magpie's Codex client identity.
  if (path !== '/backend-api/codex/responses' && ctx.agent !== 'codex') return false;
  const model = body.model;
  return typeof model === 'string' &&
    (!model.includes('/') || model.startsWith('codex/'));
}

function requiresContextPassthrough(item) {
  if (!item || typeof item !== 'object') return false;
  // A checkpoint can be readable by the native upstream. Keep it untouched,
  // but still filter incompatible items accumulated after the checkpoint.
  if (COMPACTION_ITEMS.has(item.type)) return false;
  if (item.type === 'item_reference') return true;
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
      body.input.some(requiresContextPassthrough)) {
    // A hook cannot reject. Keep opaque context intact and report the limit.
    ctx.report?.('unavailable', 0);
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
  // Magpie accepts a fixed report allowlist and at most 32 KiB. This hook
  // adds no external context, so report zero bytes and avoid serializing
  // a potentially image-heavy request a second time just for diagnostics.
  ctx.report?.('ready', 0);
  return clean;
}
