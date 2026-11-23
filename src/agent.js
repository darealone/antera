// The shared agent loop for ANTERA's read-only agents (Level 2 investigator, Level 3 drafter).
//
// Written out rather than using the SDK's beta tool runner, so that tests can drive it with a scripted
// client, and so that the turn limit, tool logging and the final check stay under ANTERA's control.
// An agent can only finish through its submit tool; what it submits is checked by code before use.

const PRICE = { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }; // USD per 1M tokens

export function estimateCost(model, usage) {
  const p = PRICE[model];
  if (!p) return null;
  const usd = (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

/**
 * @param {object} o
 * @param {object} o.client        Anthropic SDK client, or a test double with beta.messages.create
 * @param {string} o.system        system prompt (identical on every turn, so it is cached)
 * @param {object[]} o.tools       tool definitions, including the submit tool
 * @param {object} o.handlers      name -> function(input) returning a JSON-serialisable result (read-only)
 * @param {string} o.submit        name of the tool that ends the run
 * @param {Function} o.onSubmit    input -> object merged into the result (the code-side check)
 * @param {string} o.task          the first user message
 * @param {Function} [o.countIds]  () -> number of evidence ids handed out so far (for the tool log)
 */
export async function runAgent({ client, system, tools, handlers, submit, onSubmit, task, countIds = () => 0, model = 'claude-opus-5-5', effort = 'high', maxTurns = 12 }) {
  const toolCalls = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  const finish = (status, extra = {}) => ({ status, toolCalls, usage: { ...usage, usd: estimateCost(model, usage) }, model, ...extra });
  const messages = [{ role: 'user', content: task }];
  let reminded = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.beta.messages.create({
      model, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', // a safety decline is retried on a suitable model
      output_config: { effort },
      cache_control: { type: 'ephemeral' }, // system prompt and tools are identical on every turn
      system, tools, messages
    });
    usage.requests++;
    usage.input += res.usage?.input_tokens ?? 0; usage.output += res.usage?.output_tokens ?? 0;
    usage.cacheRead += res.usage?.cache_read_input_tokens ?? 0; usage.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;
    const served = res.model ?? model;

    if (res.stop_reason === 'refusal') return finish('refused', { error: 'REFUSED', detail: res.stop_details?.category ?? null, servedBy: served });
    if (res.stop_reason === 'max_tokens') return finish('failed', { error: 'MAX_TOKENS' });
    messages.push({ role: 'assistant', content: res.content }); // thinking blocks are passed back unchanged
    if (res.stop_reason === 'pause_turn') continue;

    const calls = res.content.filter(b => b.type === 'tool_use');
    const done = calls.find(b => b.name === submit);
    if (done) {
      toolCalls.push({ tool: submit, input: null, ids: 0 });
      return finish('done', { servedBy: served, ...onSubmit(done.input) });
    }
    if (!calls.length) {
      if (reminded) return finish('failed', { error: 'NO_FINDINGS' });
      reminded = true;
      messages.push({ role: 'user', content: `Please finish by calling ${submit} with what the evidence supports.` });
      continue;
    }
    const results = [];
    for (const call of calls) {
      const fn = handlers[call.name];
      const before = countIds();
      let content, isError = false;
      try {
        if (!fn) throw new Error('Unknown tool');
        content = JSON.stringify(fn(call.input ?? {}));
      } catch (e) { content = JSON.stringify({ error: e.message }); isError = true; }
      toolCalls.push({ tool: call.name, input: call.input ?? {}, ids: countIds() - before, error: isError || undefined });
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return finish('failed', { error: 'MAX_TURNS' });
}
