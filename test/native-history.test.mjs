import test from 'node:test';
import assert from 'node:assert/strict';

let hook;
try {
  hook = await import('../native-history.hooks.js');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

async function run(body, overrides = {}) {
  assert.ok(hook, 'Native history request hook has not been implemented');
  const reports = [];
  const result = await hook.onRequest(body, {
    protocol: 'responses',
    model: body.model,
    path: '/backend-api/codex/responses',
    origin: 'local',
    agent: 'codex',
    options: {},
    report(code, bytes) { reports.push({code, bytes}); },
    ...overrides,
  });
  return {result, reports};
}

function fixture() {
  return {
    model: 'gpt-example',
    stream: true,
    store: false,
    tools: [{type: 'function', name: 'read_file', parameters: {type: 'object'}}],
    tool_choice: 'auto',
    include: ['reasoning.encrypted_content'],
    input: [
      {type: 'message', id: 'msg_client', role: 'user', content: [{type: 'input_text', text: 'Inspect the file.'}]},
      {type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign-sealed-payload'},
      {type: 'web_search_call', id: 'ws_foreign', status: 'completed',
        action: {type: 'search', query: 'source query'},
        results: [{url: 'https://example.org/source', title: 'Recorded source'}],
        internal_chat_message_metadata_passthrough: {reasoning_id: 'rs_foreign'}},
      {type: 'function_call', id: 'fc_server', call_id: 'call_pair', name: 'read_file', arguments: '{"path":"a.txt"}'},
      {type: 'function_call_output', id: 'fco_client', call_id: 'call_pair', output: 'actual file contents'},
      {type: 'message', id: 'msg_server', role: 'assistant', phase: 'final_answer',
        content: [{type: 'output_text', text: 'The file was inspected.'}]},
    ],
  };
}

test('native ChatGPT history drops foreign reasoning without changing messages or tool pairs', async () => {
  const body = fixture();
  const before = structuredClone(body);
  const {result, reports} = await run(body);
  assert.ok(result);
  assert.equal(result.input.some(item => item.type === 'reasoning'), false);
  assert.deepEqual(result.input.filter(item => item.call_id).map(({call_id}) => call_id), ['call_pair', 'call_pair']);
  assert.equal(result.input.find(item => item.type === 'function_call').arguments, '{"path":"a.txt"}');
  assert.equal(result.input.find(item => item.type === 'function_call_output').output, 'actual file contents');
  assert.deepEqual(result.input.filter(item => item.role === 'user' || item.phase === 'final_answer')
    .map(({content}) => content), before.input.filter(item => item.role === 'user' || item.phase === 'final_answer')
    .map(({content}) => content));
  assert.deepEqual(result.tools, before.tools);
  assert.deepEqual(result.include, before.include);
  assert.equal(result.model, before.model);
  assert.equal(result.stream, before.stream);
  assert.equal(result.tool_choice, before.tool_choice);
  assert.deepEqual(body, before);
  assert.equal(reports.some(({code}) => code === 'native-history-filtered'), true);
});

test('historical native search becomes readable recorded data without its sealed dependency', async () => {
  const {result} = await run(fixture());
  assert.equal(result.input.some(item => item.type === 'web_search_call'), false);
  const search = result.input.find(item => item.role === 'assistant' &&
    item.content?.[0]?.text?.includes('Recorded web search'));
  assert.ok(search);
  const text = search.content[0].text;
  assert.ok(text.includes('source query'));
  assert.ok(text.includes('https://example.org/source'));
  assert.ok(text.includes('Recorded source'));
  assert.equal(text.includes('rs_foreign'), false);
  assert.equal(text.includes('ws_foreign'), false);
});

test('third-party requests on the same endpoint keep their history unchanged', async () => {
  const body = fixture();
  body.model = 'vendor/gpt-example';
  const before = structuredClone(body);
  assert.equal((await run(body)).result, undefined);
  assert.deepEqual(body, before);
});

test('codex prefixed native requests through the normal gateway are covered', async () => {
  const body = fixture();
  body.model = 'codex/gpt-example';
  assert.ok((await run(body, {path: '/v1/responses'})).result);
});

test('server-only references and sealed message content stay intact and are explicitly reported', async () => {
  for (const item of [
    {type: 'item_reference', id: 'server-only-reference'},
    {type: 'message', role: 'user', content: [{type: 'encrypted_content', encrypted_content: 'sealed-task'}]},
  ]) {
    const body = fixture();
    body.input.push(item);
    const before = structuredClone(body);
    const {result, reports} = await run(body);
    assert.equal(result, undefined);
    assert.deepEqual(body, before);
    assert.equal(reports.some(({code}) => code === 'native-history-opaque-context'), true);
  }
});

test('server continuation references are preserved instead of silently losing their context', async () => {
  const body = fixture();
  body.previous_response_id = 'resp_server';
  const before = structuredClone(body);
  const {result, reports} = await run(body);
  assert.equal(result, undefined);
  assert.deepEqual(body, before);
  assert.ok(reports.some(({code}) => code === 'native-history-opaque-context'));
});

test('clean native requests and compaction endpoints pass through', async () => {
  const body = {model: 'gpt-example', stream: true, input: [{role: 'user', content: 'Hello'}]};
  assert.equal((await run(body)).result, undefined);
  assert.equal((await run(fixture(), {path: '/backend-api/codex/responses/compact'})).result, undefined);
  assert.equal((await run(fixture(), {protocol: 'chat'})).result, undefined);
});

test('ordinary Responses traffic from another client is not treated as native Codex history', async () => {
  const body = fixture();
  const before = structuredClone(body);
  assert.equal((await run(body, {path: '/v1/responses', agent: 'opencode'})).result, undefined);
  assert.deepEqual(body, before);
});

test('ordinary Responses traffic without a Codex client identity passes through', async () => {
  const body = fixture();
  assert.equal((await run(body, {path: '/v1/responses', agent: undefined})).result, undefined);
});

test('the dedicated native endpoint remains covered when client identity is unavailable', async () => {
  const {result} = await run(fixture(), {agent: undefined});
  assert.ok(result);
  assert.equal(result.input.some(item => item.type === 'reasoning'), false);
});

test('images, custom tool results, and nested application identifiers remain intact', async () => {
  const body = fixture();
  const image = {type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGljLWltYWdl'};
  body.input[0].content.push(image);
  body.input.push(
    {type: 'custom_tool_call', id: 'ctc_server', call_id: 'custom_pair', name: 'inspect', input: 'inspect image'},
    {type: 'custom_tool_call_output', id: 'ctco_server', call_id: 'custom_pair',
      output: {id: 'application-record-42', value: 'recorded result'}},
    {type: 'tool_search_call', id: 'tsc_server', call_id: 'search_pair', arguments: '{"query":"inspect"}'},
    {type: 'tool_search_output', id: 'tso_server', call_id: 'search_pair',
      tools: [{type: 'function', name: 'inspect', parameters: {type: 'object', properties: {id: {type: 'string'}}}}]},
  );
  const before = structuredClone(body);
  const {result} = await run(body);
  assert.deepEqual(result.input[0].content, before.input[0].content);
  assert.deepEqual(result.input.find(item => item.type === 'custom_tool_call_output').output,
    {id: 'application-record-42', value: 'recorded result'});
  assert.deepEqual(result.input.find(item => item.type === 'tool_search_output').tools,
    before.input.find(item => item.type === 'tool_search_output').tools);
  assert.deepEqual(result.input.filter(item => item.call_id).map(item => item.call_id),
    before.input.filter(item => item.call_id).map(item => item.call_id));
  assert.deepEqual(body, before);
});

test('onRequest implements the asynchronous request-hook contract', async () => {
  const pending = hook.onRequest(fixture(), {
    protocol: 'responses',
    path: '/backend-api/codex/responses',
  });
  assert.ok(pending instanceof Promise, 'magpie.hooks onRequest must return a Promise');
  assert.ok(await pending);
});

test('native compaction does not bypass cleanup of later third-party reasoning', async () => {
  for (const type of ['compaction', 'context_compaction']) {
    const checkpoint = {
      type,
      id: 'cmp_native_checkpoint',
      encrypted_content: 'synthetic-native-checkpoint',
      internal_chat_message_metadata_passthrough: {checkpoint_marker: 'preserve-exactly'},
    };
    const body = fixture();
    body.input.unshift(checkpoint);
    const before = structuredClone(body);
    const {result, reports} = await run(body);
    assert.ok(result, 'A native checkpoint must not disable filtering of later reasoning');
    assert.strictEqual(result.input[0], checkpoint);
    assert.deepEqual(result.input[0], before.input[0]);
    assert.equal(result.input.some(item => item.type === 'reasoning'), false);
    assert.equal(result.input.some(item => item.type === 'web_search_call'), false);
    assert.deepEqual(result.input.filter(item => item.call_id).map(item => item.call_id),
      before.input.filter(item => item.call_id).map(item => item.call_id));
    assert.deepEqual(body, before);
    assert.ok(reports.some(({code}) => code === 'native-history-filtered-with-compaction'));
  }
});

test('a native checkpoint without incompatible history passes through unchanged', async () => {
  const body = {
    model: 'gpt-example',
    stream: true,
    input: [
      {type: 'compaction', id: 'cmp_native', encrypted_content: 'synthetic-native-checkpoint'},
      {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Continue.'}]},
    ],
  };
  const before = structuredClone(body);
  assert.equal((await run(body)).result, undefined);
  assert.deepEqual(body, before);
});
