const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const field=(form,label,input)=>{const wrapper=el('label',label);wrapper.append(input);form.append(wrapper);return input;};
const option=(select,value,text)=>{const node=el('option',text);node.value=value;select.append(node);};
export function mountDigest(root,{api,notice}) {
  root.replaceChildren();
  const intro=el('p','Read recent shared evidence without waking agents. Explicit mentions still reach their targets; topic subscriptions only wake matching new opening posts. Plain replies stay quiet.'),
    filters=el('form'),query=field(filters,'Filter evidence',el('input')),since=field(filters,'Since (your local time)',el('input')),refresh=el('button','Refresh digest'),status=el('p'),cards=el('div');
  query.maxLength=200;since.type='datetime-local';refresh.type='submit';refresh.className='primary';filters.className='work-board-create';filters.append(refresh);
  const details=el('details'),summary=el('summary','Topic and brief subscriptions'),preferences=el('form');
  details.className='card';details.append(summary,el('p','Choose a member and save their delivery preference. Digest only and Off suppress implicit wakes. Direct messages, explicit mentions and selected broadcasts are unchanged.'),preferences);
  const rooms=field(preferences,'Room',el('select')),members=field(preferences,'Member',el('select')),mode=field(preferences,'Delivery',el('select')),topics=field(preferences,'Topic phrases, one per line',el('textarea')),work=field(preferences,'Existing brief (optional)',el('select')),save=el('button','Save preference'),preferenceState=el('p');
  for(const [value,title] of [['wake','Wake on matching openings'],['digest','Digest only'],['off','Off']])option(mode,value,title);
  topics.rows=3;topics.maxLength=972;save.type='submit';save.className='primary';preferences.append(save,preferenceState);
  root.append(intro,filters,status,details,cards);
  let groups=[],saved=[];
  const current=()=>root.contains(status);
  async function loadDigest(event){
    event?.preventDefault();refresh.disabled=true;
    try {
      const value=await api('digest',{query:query.value,limit:100,...(since.value?{since:new Date(since.value).toISOString()}: {})});
      if(!current())return;
      status.textContent=`${value.items.length} records · Refreshed ${new Date(value.observedAt).toLocaleString()}${value.coverage.truncated?' · Bounded view: additional records exist':''}`;
      cards.replaceChildren();
      if(!value.items.length)cards.append(el('p','No matching evidence in the permitted records.'));
      for(const item of value.items){
        const card=el('section'),source=el('details');card.className='card work-board-item';
        source.append(el('summary','Source and hash'),el('pre',JSON.stringify(item.provenance,null,2)));
        card.append(el('h2',item.title),el('p',`${item.kind} · ${new Date(item.at).toLocaleString()}${item.status?' · '+item.status:''}`),el('p',item.text+(item.textTruncated?'…':'')),source);
        cards.append(card);
      }
    }catch(error){notice(error.message,true);status.textContent='Digest unavailable. Reconnect the workspace or restore access, then refresh.';cards.replaceChildren();}
    finally{refresh.disabled=false;}
  }
  function selectMember(){
    const value=saved.find(item=>item.sessionId===members.value);
    mode.value=value?.mode ?? 'wake';topics.value=value?.topics.join('\n') ?? '';work.value=value?.workEntryId ?? '';
    preferenceState.textContent=value?`Saved ${new Date(value.updatedAt).toLocaleString()}`:'No saved preference. Owner openings use the room default; peer openings need explicit addressing.';
  }
  async function selectRoom(){
    members.replaceChildren();saved=[];save.disabled=true;
    const group=groups.find(item=>item.id===rooms.value);if(!group)return;
    for(const member of group.members)option(members,member.sessionId,`${member.alias} · ${member.title}`);
    try{saved=(await api('discussions/subscriptions',{id:group.id})).items;selectMember();save.disabled=false;}
    catch(error){preferenceState.textContent=error.message;}
  }
  async function loadPreferences(){
    try{
      const [roomList,board]=await Promise.all([api('discussions'),api('work-board/list',{limit:200})]);
      if(!current())return;
      groups=roomList.filter(item=>item.available&&!item.fixture);rooms.replaceChildren();work.replaceChildren();option(work,'','No linked brief');
      for(const row of board.items)if(row.status!=='expired')option(work,row.entryId,row.value.title);
      for(const group of groups)option(rooms,group.id,group.title);
      await selectRoom();
      if(!groups.length)preferenceState.textContent='Join or create a room before choosing subscriptions.';
    }catch(error){save.disabled=true;preferenceState.textContent=error.message;}
  }
  filters.addEventListener('submit',loadDigest);rooms.addEventListener('change',selectRoom);members.addEventListener('change',selectMember);
  preferences.addEventListener('submit',async event=>{
    event.preventDefault();save.disabled=true;
    try{const result=await api('discussions/subscription',{id:rooms.value,sessionId:members.value,mode:mode.value,topics:topics.value.split(/\r?\n/).map(text=>text.trim()).filter(Boolean),...(work.value?{workEntryId:work.value}:{})});saved=result.items;selectMember();notice('Delivery preference saved.');}
    catch(error){notice(error.message,true);}finally{save.disabled=false;}
  });
  loadDigest();loadPreferences();
}
