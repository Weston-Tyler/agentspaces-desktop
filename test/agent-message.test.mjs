import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAgentMessage,deliveryIntent,broadcastClass,messageReference,messageLink} from '../app/agent-message.mjs';
const group={id:'fictional-room',title:'Tracking release',members:[{sessionId:'sender',alias:'claude1'},{sessionId:'receiver',alias:'codex1'}],messages:[]};
const message={id:'fictional-message',author:'claude1',source:group.members[0],text:'@codex1 Persistence tests passed; please review the result.',at:'2026-01-01T12:00:00Z',targets:[{sessionId:'receiver',alias:'codex1'}]};
test('native preview starts with the sender and actual content rather than repeated transport instructions',()=>{
 const out=formatAgentMessage({group,message,requestId:'request-12345',replyMode:'discussion'});
 assert.match(out.split('\n')[0],/@claude1.*Persistence tests passed/);assert(!out.startsWith('Discuss and reply'));assert.match(out,/Tracking release/);assert.match(out,/untrusted/);assert.match(out,/contribute_to_discussion/);assert.match(out,/fictional-message/);assert.match(out,/Do not publish your main task/);
});
test('the exact reply request is separate from the active owners final answer',()=>{
 const out=formatAgentMessage({group,message,requestId:'request-12345',replyMode:'discussion'});
 assert.match(out,/replyTo/);assert.match(out,/fictional-room/);assert.match(out,/unreported/);assert(!out.includes('service publishes your final answer'));
});
test('addressed messages steer while broad audiences, subscriptions and continuations queue',()=>{
 assert.equal(deliveryIntent(message,message.targets[0]),'steer');
 for(const m of [{...message,text:'@all Progress update'}, {...message,deliveryClass:'broadcast'}, {...message,continuation:{} }])assert.equal(deliveryIntent(m,message.targets[0]),'queue');
 assert.equal(deliveryIntent(message,{...message.targets[0],implicitSubscription:true}),'queue');
 assert.equal(broadcastClass({parsedCriteria:{all:true},text:'Progress'}),'broadcast');
 assert.equal(broadcastClass({parsedCriteria:{},sessionIds:['receiver'],text:'Review please'}),'addressed');
 assert.equal(broadcastClass({parsedCriteria:{},query:'tracking',text:'Progress'}),'broadcast');
});
test('channel content remains bounded with exact reply instructions retained',()=>{
 const out=formatAgentMessage({group,message:{...message,text:'x'.repeat(8000)},requestId:'request-12345',replyMode:'channel',maxLength:8000});
 assert(out.length<=8000);assert.match(out,/reply_native_channel/);assert.match(out,/request-12345/);assert.match(out,/Excerpt/);
});
test('a human-readable notification includes short content once and keeps technical details later',()=>{
 const m={...message,source:{...message.source,title:'Release coordinator'}};
 const out=formatAgentMessage({group,message:m,requestId:'request-12345',replyMode:'discussion',origin:'http://127.0.0.1:43210'});
 assert(out.startsWith('Release coordinator: '+m.text+'\n'));assert.equal(out.split(m.text).length-1,1);assert.match(out,/Room: Tracking release/);assert.match(out,/Open message on the companion device/);assert.match(out,/sha256/);
});
test('long content becomes an exact fetchable reference without claiming it was read',()=>{
 const m={...message,text:'Result summary. '+('Long evidence paragraph. '.repeat(150))+'UNSEEN_DETAIL'};
 const out=formatAgentMessage({group,message:m,requestId:'request-12345',replyMode:'discussion'}),ref=messageReference(group,m);
 assert(out.length<2000);assert(!out.includes('UNSEEN_DETAIL'));assert(out.includes(ref.sha256));assert.match(out,/Excerpt only/);assert.match(out,/already in your current context/);assert.match(out,/Fetch omitted text before relying/);
 assert.equal(messageReference(group,{...m,targets:[{status:'replied'}]}).sha256,ref.sha256);
 for(const changed of [{...m,text:m.text+'change'},{...m,source:{...m.source,sessionId:'other-source'}},{...m,id:'other-id'}])assert.notEqual(messageReference(group,changed).sha256,ref.sha256);
});
test('human message links carry no authentication or arbitrary external navigation',()=>{
 const href=messageLink('http://127.0.0.1:43210/?token=discard-me#private',group,message),url=new URL(href);
 assert.equal(url.searchParams.get('view'),'discussions');assert.equal(url.searchParams.get('messageId'),message.id);assert(!href.includes('discard-me'));assert(!href.includes('private'));
 for(const origin of ['https://external.invalid','http://user:password@127.0.0.1:43210','file:///tmp/private'])assert.equal(messageLink(origin,group,message),null);
});
