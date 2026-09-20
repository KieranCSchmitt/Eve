import { describe, expect, it } from 'vitest';
import { canonicalBinding, canonicalState } from '../../apps/desktop/host/model-worker';
import type { AgentRequest } from '../../packages/agent/src/contracts';
import type { CoreSnapshot } from '../../packages/contracts/src/index';
import type { CanvasDocument } from '../../packages/contracts/src/canvas';
const document: CanvasDocument = {version:1,title:'My day',subtitle:'A draft',layout:'focus',blocks:[{id:'work',kind:'text',title:'Focus',placement:'main',pinned:false,sourceIds:[],body:'Write the essay.'}]};
function snapshot(): CoreSnapshot { return {version:1,activeTaskId:'task',recentActions:[],tasks:[{id:'task',title:'My day',description:'',kind:'note',projectPath:null,revision:1,epoch:1,createdAt:0,updatedAt:0,note:{id:'note',body:'',revision:1,updatedAt:0},parameters:null,checkpoint:null,policy:{processing:'hybrid',assistancePaused:false,revision:1}}]}; }
function request(): AgentRequest { return {intent:{id:'request',text:'Plan my day',inputModality:'typed',taskId:'task',taskEpoch:1,contextSnapshotId:'context',generation:1},context:{id:'context',taskId:'task',taskEpoch:1,createdAt:0},purpose:'My day',policy:'hybrid',priority:'foreground',role:'explain',sources:[],targets:[{id:'task:canvas',revision:0,kind:'canvas',assets:[]}]}; }
describe('canonical canvas identity in the model worker',()=>{
  it('binds refresh authority separately and refuses a mismatched or ungrounded refresh marker',()=>{
    const snap=snapshot();snap.tasks[0]!.canvas={document:structuredClone(document),revision:2,updatedAt:10};
    const input=request();input.role='prepare';input.targets[0]!.revision=2;input.targets[0]!.canvas=structuredClone(document);
    const state=canonicalState({snapshot:snap,files:[]},1);
    const ordinary=canonicalBinding(input,state);
    input.canvasSuggestionRefresh={targetId:'task:canvas',canvasRevision:2};
    const refresh=canonicalBinding(input,state);
    expect(refresh).not.toBeNull();expect(refresh).not.toBe(ordinary);
    input.canvasSuggestionRefresh.canvasRevision=1;expect(canonicalBinding(input,state)).toBeNull();
    input.canvasSuggestionRefresh={targetId:'foreign:canvas',canvasRevision:2};expect(canonicalBinding(input,state)).toBeNull();
    input.canvasSuggestionRefresh={targetId:'task:canvas',canvasRevision:2};delete input.targets[0]!.canvas;
    expect(canonicalBinding(input,state)).toBeNull();
  });
  it('admits a blank canvas without requiring workspace files',()=>{
    expect(canonicalBinding(request(),canonicalState({snapshot:snapshot(),files:[]},1))).not.toBeNull();
  });
  it('rejects invented canvas content and a different task target',()=>{
    const input=request(),state=canonicalState({snapshot:snapshot(),files:[]},1);
    input.targets[0]!.canvas=structuredClone(document);
    expect(canonicalBinding(input,state)).toBeNull();
    delete input.targets[0]!.canvas; input.targets[0]!.id='another:canvas';
    expect(canonicalBinding(input,state)).toBeNull();
  });
  it('binds actual content and revision and rejects edits or pin changes after capture',()=>{
    const snap=snapshot();snap.tasks[0]!.canvas={document:structuredClone(document),revision:2,updatedAt:10};
    const input=request();input.targets[0]!.revision=2;input.targets[0]!.canvas=structuredClone(document);
    const state=()=>canonicalState({snapshot:snap,files:[]},1);
    expect(canonicalBinding(input,state())).not.toBeNull();
    snap.tasks[0]!.canvas!.document!.blocks[0]!.pinned=true;
    expect(canonicalBinding(input,state())).toBeNull();
    snap.tasks[0]!.canvas!.document=structuredClone(document);snap.tasks[0]!.canvas!.revision=3;
    expect(canonicalBinding(input,state())).toBeNull();
  });
});
