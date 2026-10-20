import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionHref,discussionLocation} from '../ui/discussion-link.js';
const id='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002';
test('human links select the exact discussion and message instead of the Ask home',()=>{
 assert.deepEqual(discussionLocation(new URL(discussionHref(id,messageId),'http://127.0.0.1:43210').href),{id,messageId});
 for(const href of ['http://127.0.0.1:43210/','http://127.0.0.1:43210/?view=discussions&discussionId=invalid','http://127.0.0.1:43210/?view=native&discussionId='+id])assert.equal(discussionLocation(href),null);
 assert.deepEqual(discussionLocation('http://127.0.0.1:43210/?view=discussions&discussionId='+id+'&messageId=invalid'),{id,messageId:null});
});
