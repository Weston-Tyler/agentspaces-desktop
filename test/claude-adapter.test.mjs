import test from 'node:test';
import assert from 'node:assert/strict';
import {readSdk} from '../app/claude-reader.mjs';
test('metadata and content require their actual pinned SDK methods and never fall through to model queries',async()=>{
 let models=0;const sdk={query(){models++;throw Error('No models');}},project={metadataGrant:true,allMetadataGrant:true,host:'local'};
 for(const action of ['list','info','read'])await assert.rejects(readSdk({action,project},sdk),/required read interface/);
 await assert.rejects(readSdk({action:'query',project},sdk),/Read-only helper refuses/);assert.equal(models,0);
});
test('metadata scope is checked before inspecting SDK capabilities',async()=>{
 await assert.rejects(readSdk({action:'list',project:{metadataGrant:false}},{}),/metadata grant/);
 const result=await readSdk({action:'list',project:{metadataGrant:true,allMetadataGrant:true}}, {listSessions:async()=>[]});assert.deepEqual(result.sessions,[]);
});
