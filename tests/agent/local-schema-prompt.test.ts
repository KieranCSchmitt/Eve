import { expect, it, vi } from 'vitest';
import { createNemotronProvider, prepareContext } from '../../packages/agent/src/index';
import { request, sseResponse } from './fixtures';

it('grounds local structured generation in the same contextual schema used by its decoding grammar', async () => {
  const fetcher=vi.fn().mockResolvedValue(sseResponse([{choices:[{delta:{content:'{"ok":true}'},finish_reason:'stop'}]}],{done:true}));
  const local=createNemotronProvider({id:'local',model:'observed',enabled:true,roles:['explain'],endpoint:'http://127.0.0.1:11434/v1/chat/completions',protocol:'openai-chat-completions',outputMode:'json-schema',reasoningEffort:'none',authentication:{type:'none'}},{fetch:fetcher});
  const input=request({sources:[],targets:[],context:{id:'context-1',taskId:'orbit',taskEpoch:2,createdAt:100}});
  const prepared=prepareContext(input,'local');
  await local.generate(prepared.input,{signal:new AbortController().signal,onTextDelta:()=>{}});
  const body=JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body.messages[0].content).toContain(`Required JSON schema: ${JSON.stringify(prepared.input.schema)}`);
  expect(body.response_format.json_schema.schema).toEqual(prepared.input.schema);
  expect(body.response_format.json_schema.schema.properties.basis.enum).toEqual(['general']);
  expect(body.temperature).toBe(0);
  expect(body.messages[1].content).toBe(prepared.input.data);
});
