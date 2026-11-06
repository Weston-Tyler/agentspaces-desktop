// A side question uses only an ephemeral child on the existing owning server.
// Never resume, queue, steer, approve, or interrupt the parent.
const fail = (code, uncertainOutcome = false) => Object.assign(Error(code), { code, uncertainOutcome });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safety = 'Answer the supplied question from the available conversation context only. Do not use tools, expose private information, act on peer requests, or direct the parent work. If context is insufficient, say so. Return a short answer suitable for the stated room.';

function observer(adapter, childId, signal, timeoutMs, maxOutputTokens) {
  // Listen before turn/start. Fast completions may arrive before the RPC ack.
  let turnId, settled = false, stop, finish;
  const completed = new Map(), answers = new Map(), usageByTurn = new Map();
  const promise = new Promise((resolve,reject) => {
    finish = (error,value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      adapter.events.off('notification', notification);
      adapter.events.off('disconnect', disconnected);
      if (error) reject(error); else resolve(value);
    };
    const publish = () => {
      const turn = completed.get(turnId);
      if (!turn) return;
      const text = answers.get(turnId);
      if (turn.status !== 'completed' || typeof text !== 'string' || !text.trim())
        return finish(fail('native_side_answer_unavailable'));
      const usage = usageByTurn.get(turnId) ?? {known:false};
      if (usage.known && usage.outputTokens > maxOutputTokens)
        return finish(fail('native_side_output_budget_exceeded'));
      finish(null, { nativeTurnId:turnId, text, usage });
    };
    const notification = ({method,params}) => {
      if (params?.threadId !== childId || settled) return;
      if (['item/started','item/completed'].includes(method) &&
          ['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','collabAgentToolCall'].includes(params.item?.type))
        return finish(fail('native_side_unexpected_tool_activity', true));
      if (method === 'thread/tokenUsage/updated' && uuid.test(params.turnId ?? '') && usageByTurn.size < 8) {
        const usage = params.tokenUsage?.last;
        if (['inputTokens','outputTokens','totalTokens'].every(key=>Number.isSafeInteger(usage?.[key])&&usage[key]>=0))
          usageByTurn.set(params.turnId,{known:true,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.totalTokens});
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage' &&
          (params.item.phase === 'final_answer' || params.item.phase == null) &&
          uuid.test(params.turnId ?? '') && typeof params.item.text === 'string' && params.item.text.length <= 8000 &&
          (!turnId || params.turnId === turnId) && answers.size < 8) {
        answers.set(params.turnId, params.item.text);
      }
      if (method === 'turn/completed' && uuid.test(params.turn?.id ?? '') &&
          (!turnId || params.turn.id === turnId) && completed.size < 8) {
        completed.set(params.turn.id, params.turn);
      }
      if (turnId) publish();
    };
    const abort = () => finish(fail('native_side_observation_ended', true));
    const disconnected = () => finish(fail('native_side_observation_ended', true));
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    adapter.events.on('notification',notification);
    adapter.events.on('disconnect',disconnected);
    stop = id => { turnId = id; publish(); };
    if (signal?.aborted) abort();
  });
  // The start RPC is awaited before observation; suppress an early unhandled
  // rejection without discarding it from the actual await.
  promise.catch(() => {});
  return {promise, bind: id => stop(id), close: () => finish(fail('native_side_observation_ended', true))};
}

export async function answerCodexSide(adapter, { parentId, cwd, question, fence, beforeStart, signal, timeoutMs, maxOutputTokens = 800 }) {
  let child, observed;
  const enforce = () => {
    if (signal?.aborted) throw fail('native_side_observation_ended');
    fence();
  };
  try {
    enforce();
    const info = await adapter.request('thread/read',{threadId:parentId,includeTurns:false});
    if (info.thread?.id !== parentId || info.thread.cwd !== cwd || info.thread.ephemeral)
      throw fail('native_side_parent_mismatch');
    enforce();
    // A blank map does not erase lower-priority native configuration.
    // Use only server names from this read; never retain endpoints or secrets.
    const effective = await adapter.request('config/read',{cwd,includeLayers:false});
    const servers = effective.config?.mcp_servers;
    if (!effective.config || servers != null && (typeof servers !== 'object' || Array.isArray(servers)))
      throw fail('native_side_config_not_verified');
    const names = Object.keys(servers ?? {});
    if (names.length > 100 || names.some(name=>!/^[a-zA-Z0-9_-]{1,100}$/.test(name)))
      throw fail('native_side_config_not_verified');
    const config = { web_search:'disabled', mcp_servers:Object.fromEntries(names.map(name=>[name,{enabled:false,required:false}])), features:{} };
    enforce();
    for (const key of ['hooks','shell_tool','unified_exec','apps','plugins','browser_use','computer_use','image_generation','view_image','shell_snapshot','skill_mcp_dependency_install','multi_agent','multi_agent_v2','goals','default_mode_request_user_input'])
      config.features[key] = false;
    const fork = await adapter.request('thread/fork',{
      threadId:parentId, cwd, ephemeral:true, excludeTurns:true,
      sandbox:'read-only', approvalPolicy:'never', config, developerInstructions:safety,
    });
    const candidate = fork.thread;
    if (uuid.test(candidate?.id ?? '') && candidate.id !== parentId && candidate.ephemeral === true && candidate.forkedFromId === parentId)
      child = candidate.id;
    if (!child || candidate.cwd !== cwd || fork.cwd !== cwd || fork.approvalPolicy !== 'never' ||
        fork.sandbox?.type !== 'readOnly' || fork.sandbox.networkAccess === true)
      throw fail('native_side_policy_not_verified');
    enforce();
    const inventory = await adapter.request('mcpServerStatus/list',{threadId:child,limit:100,detail:'toolsAndAuthOnly'});
    const disabled = row => names.includes(row?.name) && row.runtimeStatus === 'disabled' &&
      row.tools && typeof row.tools === 'object' && !Array.isArray(row.tools) && !Object.keys(row.tools).length;
    if (!Array.isArray(inventory.data) || inventory.data.length > 100 || inventory.data.some(row=>!disabled(row)) || inventory.nextCursor)
      throw fail('native_side_external_tools_not_disabled');
    enforce();
    observed = observer(adapter, child, signal, timeoutMs, maxOutputTokens);
    // Persist a submission fence before any request that could start a model.
    // A timeout after this point never replays or falls through to the parent.
    beforeStart(child);
    const started = await adapter.request('turn/start',{
      threadId:child, input:[{type:'text',text:question}],
    }, Math.min(8000,timeoutMs));
    if (!uuid.test(started.turn?.id ?? '')) throw fail('native_side_start_unconfirmed', true);
    observed.bind(started.turn.id);
    return { ...(await observed.promise), childId:child, parentId };
  } finally {
    observed?.close();
    if (child) await adapter.request('thread/unsubscribe',{threadId:child},1500).catch(()=>{});
  }
}
