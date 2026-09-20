import { describe, expect, it } from 'vitest';
import { compileCanvasSuggestion, normalizedImageAdjustments, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { applyCanvasPatch } from '../../packages/agent/src/canvas-patches';
import { proposal, request } from './fixtures';

const image: Extract<CanvasBlock, {kind:'image'}> = {kind:'image',id:'photo',title:'My original',placement:'main',pinned:false,sourceIds:[],assetId:'original',caption:'My own caption.'};
const writing: CanvasBlock = {kind:'text',id:'notes',title:'Notes',placement:'aside',pinned:true,sourceIds:[],body:'Preserve my observations.'};
const original: CanvasDocument = {version:1,title:'Photographs',subtitle:'',layout:'split',blocks:[image,writing],suggestions:[]};
const adjusted = {...normalizedImageAdjustments(),brightness:1.12,contrast:1.06,saturation:0.92,straighten:2,crop:{left:0.1,top:0.05,right:0.9,bottom:0.95}};
const change = (adjustments:unknown = adjusted) => ({type:'adjust-image',adjustments});
const captured = (canvas=original): AgentRequest => {
  const value=request({role:'prepare',sources:[]});
  value.intent.text='Show a slightly brighter cropped variation to review.';
  value.targets=[{id:'orbit:canvas',kind:'canvas',revision:3,canvas,assets:[{id:'original',title:'My original',mediaType:'image/jpeg'}]}];
  return value;
};
const compose = (document:unknown, input=captured()): CanvasDocument => {
  const result=validateProposal({...proposal({basis:'general',citations:[]}),actions:[{type:'ComposeCanvas',targetId:'orbit:canvas',expectedRevision:3,document}]},input,prepareContext(input,'local'));
  const action=result.actions[0]!;
  if(action.type!=='ComposeCanvas') throw new Error('Expected canvas');
  return action.document;
};
const choice = (adjustments:unknown = adjusted) => ({id:'lighter',label:'Try a lighter variation',description:'Review the supplied settings while keeping your original.',request:'Preview the brightness, color, crop and angle settings.',targetBlockId:'photo',prepared:{edits:[{type:'patch',id:'photo',changes:[change(adjustments)]}]}});

describe('registered photo adjustments at the model boundary',()=>{
  it('expands a direct photo patch while preserving the original identity, caption, sources and pinned writing',()=>{
    const input=captured(), untouched=structuredClone(input);
    const result=compose({...original,blocks:[{kind:'patch',id:'photo',changes:[change()]},{kind:'keep',id:'notes'}]},input);
    expect(result.blocks).toEqual([{...image,adjustments:adjusted},writing]);
    expect(input).toEqual(untouched);
  });
  it('prepares a reviewable exact replacement without changing the current photo',()=>{
    const result=compose({...original,blocks:[{kind:'keep',id:'photo'},{kind:'keep',id:'notes'}],suggestions:[choice()]});
    expect(result.blocks).toEqual(original.blocks);
    expect(result.suggestions![0]!.prepared).toEqual({before:[image],edits:[{type:'replace',block:{...image,adjustments:adjusted}}]});
    expect(compileCanvasSuggestion(result,'lighter').blocks).toEqual([{...image,adjustments:adjusted},writing]);
  });
  it('retains a stale photo plan after newer caption edits instead of rebasing it silently',()=>{
    const first=compose({...original,suggestions:[choice()]});
    const current={...first,blocks:[{...image,caption:'A newer caption.'},writing]};
    const next=compose({...current,suggestions:[choice()]},captured(current));
    expect(next.suggestions![0]!.prepared).toEqual(first.suggestions![0]!.prepared);
    expect(()=>compileCanvasSuggestion(next,'lighter')).toThrow(/changed/i);
  });
  it('can reset a saved adjustment while preserving the separate managed original',()=>{
    const current={...image,adjustments:adjusted};
    expect(applyCanvasPatch(current,{id:'photo',changes:[change(null)]})).toEqual({...image,adjustments:null});
    expect(()=>applyCanvasPatch(image,{id:'photo',changes:[change(null)]})).toThrow(/does not change/i);
    expect(()=>applyCanvasPatch(image,{id:'photo',changes:[change(normalizedImageAdjustments())]})).toThrow(/does not change/i);
  });
  it.each([
    {...adjusted,brightness:2.01}, {...adjusted,straighten:16}, {...adjusted,saturation:-1},
    {...adjusted,crop:{left:0.9,top:0,right:0.5,bottom:1}},
    {...adjusted,crop:{left:0,top:0,right:0.04,bottom:1}},
    {...adjusted,crop:{left:0,top:0,right:1.01,bottom:1}},
    {...adjusted,filter:'url(https://invalid.example/filter)'},
  ])('rejects invalid or arbitrary image transformation data before producing any candidate',bad=>{
    expect(()=>compose({...original,suggestions:[choice(bad)]})).toThrow(expect.objectContaining({code:'INVALID_OUTPUT'}));
  });
  it('rejects pins, unrelated owners and duplicate adjustment operations',()=>{
    expect(()=>applyCanvasPatch({...image,pinned:true},{id:'photo',changes:[change()]})).toThrow(/unpin/i);
    expect(()=>applyCanvasPatch({...writing,pinned:false},{id:'notes',changes:[change()]})).toThrow(/only on an image/i);
    expect(()=>applyCanvasPatch(image,{id:'photo',changes:[change(),change(null)]})).toThrow(/only once/i);
  });
  it('does not turn adjustments into authority for another asset or private source',()=>{
    const other={...image,assetId:'not-attached',adjustments:adjusted};
    expect(()=>compose({...original,blocks:[other,writing]})).toThrow(/not attached/i);
    expect(()=>compose({...original,blocks:[{...image,adjustments:adjusted,sourceIds:['unknown']},writing]})).toThrow(/not attached/i);
  });
  it('requires nullable bounded settings on new image wire blocks and exposes a registered adjustment patch',()=>{
    const schema=prepareContext(captured(),'local').input.schema as any;
    const doc=schema.properties.actions.items.anyOf.find((branch:any)=>branch.properties.type.const==='ComposeCanvas').properties.document;
    const picture=doc.properties.blocks.items.anyOf.find((branch:any)=>branch.properties.kind.const==='image');
    expect(picture.required).toContain('adjustments');
    expect(picture.properties.adjustments.anyOf.some((branch:any)=>branch.type==='null')).toBe(true);
    const patch=doc.properties.blocks.items.anyOf.find((branch:any)=>branch.properties.kind.const==='patch');
    const adjustment=patch.properties.changes.items.anyOf.find((branch:any)=>branch.properties.type.const==='adjust-image');
    expect(adjustment.additionalProperties).toBe(false);
    expect(adjustment.properties.adjustments.anyOf.find((branch:any)=>branch.properties?.crop).properties.crop.additionalProperties).toBe(false);
    expect(JSON.parse(prepareContext(captured(),'local').input.data).targets[0].canvas.blocks[0]).toEqual(image);
  });
});
