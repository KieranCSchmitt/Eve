import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CAPABILITIES, assertCanvasSelectionResult, type CanvasDocument, type CoreCommandInput } from '../../packages/contracts/src/index';
import { CoreStore } from '../../packages/core/src/index';
import type { AgentRequest, AgentResult, RegisteredAction } from '../../packages/agent/src/index';
import { IntentService, type IntentResponse } from '../../apps/desktop/host/intents';
import { isReadOnlyCanvasSelectionIntent } from '../../apps/desktop/host/intent-context';

const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const phrase = 'A shared detail.';
const body = `${phrase} First paragraph.\n\n${phrase} Last paragraph.`;
const start = body.lastIndexOf(phrase);
const scope = { blockId: 'writing', selection: { field: 'body' as const, start, end: start + phrase.length, text: phrase } };
const initial = (): CanvasDocument => ({ version: 1, title: 'Observations', subtitle: '', layout: 'focus', blocks: [
  { id: 'writing', kind: 'text', title: '', body, pinned: false, placement: 'main', sourceIds: [] },
  { id: 'original', kind: 'text', title: 'Original', body: 'Keep this exact.', pinned: true, placement: 'aside', sourceIds: [] },
] });
let core: CoreStore, service: IntentService;
let requests: AgentRequest[], events: IntentResponse[], writes: CoreCommandInput[], searches: unknown[];
let answer: (request: AgentRequest) => Promise<AgentResult>;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const current = () => task().canvas!.document!;
function result(request: AgentRequest, actions: RegisteredAction[] = []): Extract<AgentResult, {status:'complete'}> {
  return { status: 'complete', requestId: request.intent.id, context: request.context, message: 'A response to the typed request.', basis: 'general', citations: [], actions,
    needsClarification: false, origin: 'model-proposal', requiresUserAction: actions.length > 0, focusPolicy: 'preserve', provider: null, usage: {} };
}
function changed(request: AgentRequest): RegisteredAction {
  const target = request.targets[0]!;
  const document = structuredClone(target.canvas!);
  document.blocks[0] = { ...document.blocks[0]!, kind: 'text', body: body.slice(0, start) + 'Another shared detail.' + body.slice(scope.selection.end) } as typeof document.blocks[0];
  return { type: 'ComposeCanvas', targetId: target.id, expectedRevision: target.revision, document };
}
function ask(text: string) { return service.ask({taskId:'orbit',text,mode:'selection',refresh:{canvasRevision:task().canvas!.revision,scope}}).requestId; }
const latest = (id:string) => events.filter(event => event.requestId === id).at(-1)!;
async function settled(id:string) { await vi.waitFor(() => expect(latest(id)?.status).toMatch(/^(complete|error|stale|cancelled)$/)); return latest(id); }
beforeEach(() => {
  core = new CoreStore({dbPath:':memory:'}); requests=[];events=[];writes=[];searches=[];
  expect(core.dispatch({type:'UpdateCanvas',taskId:'orbit',requestId:'seed-selection',expectedEpoch:task().epoch,expectedRevision:task().canvas?.revision ?? 0,document:initial()},auth).ok).toBe(true);
  answer = async request => result(request);
  service = new IntentService({captureContext:async()=>({snapshot:core.snapshot(),sources:[],assets:[]}),
    intelligence:{syncCanonical:()=>{},cancel:()=>{},request:async request=>{requests.push(request);return answer(request);}},
    dispatch:async command=>{writes.push(command);return core.dispatch(command,auth);},
    executeRegistered:async()=>{throw new Error('Unrelated command');},openSource:async()=>{throw new Error('Unrelated source');},
    discoverSources:async value=>{searches.push(value);},onEvent:event=>events.push(event.response),now:()=>1000});
});
afterEach(()=>{service.dispose();core.close();});

describe('free-form request on exact selected writing',()=>{
  it('sends the user words and repeated-text offsets unchanged through the small read-only path',async()=>{
    const text='Explain this idea and distinguish evidence from uncertainty.';
    expect((await settled(ask(text))).status).toBe('complete');
    expect(requests[0]).toMatchObject({intent:{text},role:'explain',canvasLearning:{scope}});
    expect(requests[0]!.canvasSelection).toBeUndefined();expect(writes).toEqual([]);expect(current()).toEqual(initial());
  });
  it('keeps an arbitrary selected rewrite ready until explicit Keep, then supports one write and Undo',async()=>{
    answer=async request=>result(request,[changed(request)]);
    const id=ask('Rewrite this phrase more clearly.');const response=await settled(id);const proposal=response.proposals[0]!;
    expect(requests[0]).toMatchObject({role:'prepare',canvasSelection:{scope}});expect(response.status).toBe('complete');
    expect(proposal.status).toBe('ready');expect(proposal.textSelection).toEqual(scope.selection);expect(writes).toEqual([]);expect(current()).toEqual(initial());
    await Promise.all([service.applyProposal({requestId:id,proposalId:proposal.id}),service.applyProposal({requestId:id,proposalId:proposal.id})]);
    expect(writes).toHaveLength(1);expect(requests).toHaveLength(1);
    expect(current().blocks[0]).toMatchObject({body:body.slice(0,start)+'Another shared detail.'+body.slice(scope.selection.end)});
    expect(core.dispatch({type:'Undo',taskId:'orbit',requestId:'undo-selection',expectedEpoch:task().epoch},auth).ok).toBe(true);expect(current()).toEqual(initial());
  });
  it('opens real video search using the model topic without claiming a retrieved video or writing',async()=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'how shared observations shape ideas'}]);
    const response=await settled(ask('Find a video about this.'));
    expect(requests[0]).toMatchObject({intent:{text:'Find a video about this.'},canvasSelection:{scope}});
    expect(searches).toEqual([{taskId:'orbit',kind:'video',query:'how shared observations shape ideas'}]);
    expect(response.message).toContain('Opened video search');expect(response.proposals).toEqual([]);expect(writes).toEqual([]);expect(current()).toEqual(initial());
  });
  it('rejects a combined search and mutation instead of hiding a write behind retrieval',async()=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'ideas'},changed(request)]);
    expect((await settled(ask('Find a video and rewrite this.'))).status).toBe('error');expect(searches).toEqual([]);expect(writes).toEqual([]);
  });
  it('repeats the zero-action guard for a read-only result before any search or write',async()=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'ideas'}]);
    expect((await settled(ask('Explain this.'))).status).toBe('error');expect(searches).toEqual([]);expect(writes).toEqual([]);
  });
  it('rejects an unrequested model search from a general selected request',async()=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'ideas'}]);
    expect((await settled(ask('Help me with this passage.'))).status).toBe('error');expect(searches).toEqual([]);expect(writes).toEqual([]);
  });
  it.each(['Explain why this article says “find videos”.','Do not search for videos; explain this passage.','Find the phrase “some videos” in this article.'])('does not mistake descriptive or negated search words for authority: %s',async text=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'ideas'}]);
    expect((await settled(ask(text))).status).toBe('error');expect(searches).toEqual([]);expect(writes).toEqual([]);
  });
  it('accepts an affirmative video search with an ordinary content constraint',async()=>{
    answer=async request=>result(request,[{type:'SearchSources',kind:'video',query:'shared observations plain explanation'}]);
    expect((await settled(ask('Find a short video about this without technical jargon.'))).status).toBe('complete');expect(searches).toHaveLength(1);expect(writes).toEqual([]);
  });
  it('rejects off-range edits from the worker before preparing a proposal',async()=>{
    answer=async request=>{const action=changed(request);if(action.type==='ComposeCanvas' && action.document.blocks[0]?.kind==='text')action.document.blocks[0].body='Changed every paragraph.';return result(request,[action]);};
    const response=await settled(ask('Rewrite this.'));expect(response.status).toBe('error');expect(response.proposals).toEqual([]);expect(writes).toEqual([]);
  });
  it('retires an in-flight search after authored work changes',async()=>{
    let finish!:(value:AgentResult)=>void;answer=()=>new Promise(resolve=>{finish=resolve;});
    const id=ask('Find a video about this.');await vi.waitFor(()=>expect(requests).toHaveLength(1));
    service.invalidateForUserEdit();finish(result(requests[0]!,[{type:'SearchSources',kind:'video',query:'ideas'}]));
    expect((await settled(id)).status).toBe('stale');expect(searches).toEqual([]);expect(writes).toEqual([]);
  });
  it('reads pinned writing but rejects a replacement of it',async()=>{
    const document=initial();document.blocks[0]!.pinned=true;
    expect(core.dispatch({type:'UpdateCanvas',taskId:'orbit',requestId:'pin-selection',expectedEpoch:task().epoch,expectedRevision:task().canvas!.revision,document},auth).ok).toBe(true);
    expect((await settled(ask('Explain this.'))).status).toBe('complete');
    answer=async request=>result(request,[changed(request)]);
    expect((await settled(ask('Rewrite this.'))).status).toBe('error');expect(writes).toEqual([]);
  });
});

describe('selection authority and conservative fast routing',()=>{
  it.each(['Explain this.','What does this mean?','Why is this plausible?','Please define this term.'])('uses read-only capability for %s',text=>expect(isReadOnlyCanvasSelectionIntent(text)).toBe(true));
  it.each(['Explain this and insert a graphic.','What video explains this?','Explain the mistake and correct it.','Show me a diagram.','Create an illustration of this.','Find a video about this.','Rewrite this.','Could you explain this and add it to my essay?'])('retains general capability for %s',text=>expect(isReadOnlyCanvasSelectionIntent(text)).toBe(false));
  it('permits supporting registered items while retaining original order and all existing fields',()=>{
    const before=initial(),after=initial();after.layout='split';after.blocks.splice(1,0,{id:'support',kind:'text',title:'Supporting idea',body:'A useful illustration.',pinned:false,placement:'aside',sourceIds:[]});
    expect(()=>assertCanvasSelectionResult(before,after,scope)).not.toThrow();
    after.blocks[2]!.title='Changed original';expect(()=>assertCanvasSelectionResult(before,after,scope)).toThrow();
  });
  it.each(['title','order','removal','choices','layout','outside'] as const)('rejects hidden %s changes',kind=>{
    const after=initial();
    if(kind==='title')after.title='New title';if(kind==='order')after.blocks.reverse();if(kind==='removal')after.blocks.pop();if(kind==='choices')after.suggestions=[];if(kind==='layout')after.layout='gallery';if(kind==='outside' && after.blocks[0]?.kind==='text')after.blocks[0].body='Changed first paragraph.\n'+body;
    expect(()=>assertCanvasSelectionResult(initial(),after,scope)).toThrow();
  });
});
