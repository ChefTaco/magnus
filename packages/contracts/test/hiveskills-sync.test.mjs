import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiveSkillsSyncInputSchema } from '../src/hiveskills-sync.ts';
const input={target:'fixture-target',registryId:'fixture-registry',publicationSha256:'a'.repeat(64),manifest:{schemaVersion:1,channel:'stable',skills:[{slug:'fixture-skill',name:'Fixture Skill',version:'1.0.0',compatibility:{minHermesVersion:null,maxHermesVersion:null},archiveUrl:'https://skills.example.com/v1/skills/fixture-skill/releases/1.0.0/archive',sha256:'b'.repeat(64)}]}};
test('native skill publication contracts carry exact public pins and reject command, credential and path injection',()=>{
 assert.deepEqual(HiveSkillsSyncInputSchema.parse(input),input);
 for(const change of [{command:'arbitrary'},{token:'obviously-fake-token'},{target:'../escape'},{publicationSha256:'invalid'},{manifest:{...input.manifest,credential:'obviously-fake-token'}},{manifest:{...input.manifest,skills:[{...input.manifest.skills[0],token:'obviously-fake-token'}]}}])assert.equal(HiveSkillsSyncInputSchema.safeParse({...input,...change}).success,false);
});
