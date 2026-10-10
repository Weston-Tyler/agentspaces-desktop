const element = (tag, text) => { const node = document.createElement(tag); if (tag === 'button') { node.className = 'secondary'; node.type = 'button'; } if (text !== undefined) node.textContent = text; return node; };
const field = (form, key, label, multiline = false, required = true) => {
  const wrapper = element('label', label), input = element(multiline ? 'textarea' : 'input');
  if (multiline) { input.rows = 3; input.className = 'work-board-text'; }
  input.name = key; input.required = required; input.maxLength = multiline ? 12000 : 2000;
  wrapper.append(input); form.append(wrapper); return input;
};
export function mountWorkBoard(root, { api, notice }) {
  root.replaceChildren();
  const heading = element('p', 'Claims reserve coordination work for a limited time. They do not authorize native execution or approve publication.');
  const refresh = element('button', 'Refresh board'), state = element('p'), cards = element('div'), lanes = element('section');
  lanes.className = 'card'; let refreshTimer;
  const create = element('details'), summary = element('summary', 'Create work item'), form = element('form');
  create.className = 'card work-board-create'; create.append(summary, form);
  for (const [key, label, multi] of [['title','Title'],['brief','Brief and acceptance checks',true],['repository','Repository'],['base','Exact base revision'],['allowedFiles','Allowed files or paths (one per line)',true]]) field(form,key,label,multi);
  const submit = element('button', 'Create work item'); submit.type = 'submit'; submit.className = 'primary'; form.append(submit);
  root.append(heading, refresh, state, lanes, create, cards);
  async function change(payload, button) {
    button.disabled = true;
    // Retain the same delivery identity after uncertain transport outcomes.
    if (!button.workOperation) button.workOperation = { ...payload, deliveryId: crypto.randomUUID() };
    try { await api('work-board/change', button.workOperation); button.workOperation = null; await load(); return true; }
    catch (e) { notice(e.message + ' Retry sends the same operation; refresh to inspect its state.', true); return false; }
    finally { button.disabled = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await change({ action: 'create', ...Object.fromEntries(new FormData(form)) }, submit)) { form.reset(); create.open = false; }
  });
  refresh.addEventListener('click', load);
  function reportButton(entryId,label) {
    const button=element('button',label);
    button.addEventListener('click',async()=>{button.disabled=true;try{const report=(await api('artifacts/list',{entryId})).items[0];const output=element('pre',`Untrusted source-authored report · SHA-256 ${report.value.artifact.digest}\nEntry ${report.entryId}\n\n${report.value.artifact.text}`);button.after(output);}catch(error){notice(error.message,true);}finally{button.disabled=false;}});
    return button;
  }
  function renderLanes(laneView) {
      lanes.replaceChildren(element('h2','Agent lanes'),element('p','Activity needs fresh native evidence. Revisions come from source-authored work results; they are not independently verified.'));
      const table = element('table'), header = element('tr');
      for (const title of ['Agent','Status / evidence','Branch / head','Last activity','Latest report']) header.append(element('th',title));
      table.append(header);
      for (const lane of laneView.items) {
        const row=element('tr');
        row.append(element('td',lane.title??lane.sessionId),element('td',`${lane.status} · ${lane.provenance.kind}`),element('td',lane.branch?`${lane.branch} @ ${lane.head}`:'Unknown'),element('td',lane.lastActivity?`${new Date(lane.lastActivity.at).toLocaleString()} · ${lane.lastActivity.kind}`:'Unknown'));
        const report=element('td');if(lane.lastReport)report.append(reportButton(lane.lastReport.entryId,`${lane.lastReport.name} v${lane.lastReport.version}`));else report.textContent='None';row.append(report);table.append(row);
      }
      lanes.append(table);if(laneView.truncated||Object.values(laneView.coverage).some(value=>value===true))lanes.append(element('p','Some source records are outside this bounded view.'));
  }
  async function refreshLanes() {
    if (!root.contains(state)) return;
    try { renderLanes(await api('lanes/list',{limit:200})); }
    catch { lanes.replaceChildren(element('p','Lane status unavailable; refresh after the connection recovers.')); }
    finally { if(root.contains(state))refreshTimer=setTimeout(refreshLanes,15000); }
  }
  async function load() {
    if(!root.contains(state))return;
    try {
      clearTimeout(refreshTimer);
      const [board, laneView, reports, continuations] = await Promise.all([api('work-board/list', { limit: 200 }), api('lanes/list', {limit:200}), api('artifacts/list', {limit:200}), api('work-board/continuations', {}).catch(()=>null)]);
      if (!root.contains(state)) return;
      state.textContent = `${board.items.length} work items · Shared companion · Refreshed ${new Date(board.observedAt).toLocaleString()}${board.coverage.truncated ? ' · More items exist than this view can display' : ''}`;
      renderLanes(laneView);
      cards.replaceChildren(); submit.disabled = false;
      if (!board.items.length) cards.append(element('p','No work items yet. Create the first brief above.'));
      for (const item of board.items) {
        const card = element('section'); card.className = 'card work-board-item';
        card.append(element('h2',item.value.title ?? item.entryId),Object.assign(element('span',item.status),{className:'pill'}),element('p',item.value.brief ?? ''),
          element('p',`Repository: ${item.value.repository ?? 'Unspecified'} · Base: ${item.value.base ?? 'Unspecified'}`),
          element('pre',item.value.allowedFiles ?? ''),element('p',`Entry: ${item.entryId}`));
        if (item.holder) card.append(element('p',`Claim holder: ${item.holderLabel ?? item.holder} · Expires ${new Date(item.claimExpiresAt).toLocaleString()}`));
        if (item.resultsTruncated) card.append(element('p',`Showing the latest 20 of ${item.resultCount} progress/result records.`));
        for (const result of item.results) card.append(element('p',`${result.value.status ?? 'Reported result'}: ${result.value.summary ?? result.value.result ?? ''}\n${result.value.branch ?? ''} @ ${result.value.head ?? ''}\n${result.value.evidence ?? ''}`));
        const continuation=continuations?.items.find(row=>row.workEntryId===item.entryId);
        if (continuation) {
          card.append(element('p',`Continuation: ${continuation.state.replaceAll('_',' ')} · ${continuation.step?.summary??''}`),
            element('p',`Native activity: ${continuation.nativeObservation?.state??'unknown'} · ${continuation.nativeObservation?.reason??'No observation available'}`),
            element('p',`Wake delivery: ${continuation.nativeDelivery?.status??'Not recorded'}. Delivery does not establish that the task ran.`));
        }
        const latestContinuation = item.results.at(-1)?.value.continuation;
        if (latestContinuation) card.append(element('p',`Next step: ${latestContinuation.state} · ${latestContinuation.summary} · ${latestContinuation.kind}`));
        const reportArea=element('div');
        for (const report of reports.items.filter(row=>row.value.workEntryId===item.entryId)) reportArea.append(reportButton(report.entryId,`${report.value.name} v${report.value.version} · ${report.value.source.participantId}`));
        card.append(reportArea);
        if (item.status === 'claimed') {
          const drop=element('details'),dropForm=element('form');drop.append(element('summary','Attach report (claim holder only)'),dropForm);
          field(dropForm,'name','Report label, e.g. report.md').maxLength=120;
          field(dropForm,'text','Report text (16 KiB UTF-8 maximum)',true).maxLength=16384;
          field(dropForm,'previousEntryId','Previous artifact entry ID for a new version',false,false);
          const upload=element('button','Save report');upload.type='submit';dropForm.append(upload);card.append(drop);
          dropForm.addEventListener('submit',async event=>{event.preventDefault();upload.disabled=true;
            const values=Object.fromEntries(new FormData(dropForm));if(!values.previousEntryId)delete values.previousEntryId;
            upload.artifactOperation??={...values,workEntryId:item.entryId,mediaType:'text/markdown',deliveryId:crypto.randomUUID()};
            try{await api('artifacts/create',upload.artifactOperation);upload.artifactOperation=null;await load();}catch(error){notice(error.message+' Retry keeps the same upload identity.',true);}finally{upload.disabled=false;}
          });
        }
        if (item.status === 'available') {
          const claim = element('button','Claim for 15 minutes');
          claim.addEventListener('click', () => change({ action:'claim',entryId:item.entryId,leaseMinutes:15 },claim)); card.append(claim);
        }
        if (item.status === 'claimed') {
          const renew = element('button','Renew my claim for 15 minutes');
          renew.addEventListener('click', () => change({action:'renew',entryId:item.entryId,leaseMinutes:15},renew)); card.append(renew);
          const details = element('details'); details.append(element('summary','Record progress or completion (claim holder only)'));
          const update = element('form'), status = element('select'); status.name = 'status';
          for (const value of ['in_progress','blocked']) { const option = element('option',value.replace('_',' ')); option.value = value; status.append(option); }
          update.append(status); field(update,'summary','Progress / result',true); field(update,'branch','Branch'); field(update,'head','Exact head'); field(update,'evidence','Tests, evidence and limitations',true);
          const progress = element('button','Save progress'), complete = element('button','Complete with evidence'); progress.type = 'submit'; complete.type = 'button';
          update.append(progress,complete); details.append(update); card.append(details);
          update.addEventListener('submit', event => { event.preventDefault(); change({action:'update',entryId:item.entryId,...Object.fromEntries(new FormData(update))},progress); });
          complete.addEventListener('click', () => { if (update.reportValidity()) change({action:'complete',entryId:item.entryId,...Object.fromEntries(new FormData(update))},complete); });
        }
        cards.append(card);
      }
    } catch (e) { state.textContent = e.message; submit.disabled = true; }
    finally { if(root.contains(state))refreshTimer=setTimeout(refreshLanes,15000); }
  }
  load();
}
