import { expect, it } from 'vitest';
import { createAgentService, prepareContext, validateProposal, type RegisteredAction } from '../../packages/agent/src/index';
import { fakeProvider, proposal, request } from './fixtures';

const edit = (before: string): RegisteredAction => ({
  type: 'ProposeWorkspaceEdit', targetId: 'workspace-1', expectedRevision: 7,
  edits: [{ path: 'src/timer.ts', before, after: 'const duration = 400;' }],
});

it('labels partial file context explicitly without transmitting the hidden tail', () => {
  const input = request();
  const content = 'a'.repeat(9000) + 'PRIVATE_TAIL_MARKER';
  input.targets[2]!.files![0]!.content = content;
  const prepared = prepareContext(input, 'cloud');
  const wire = JSON.parse(prepared.input.data);
  expect(wire.targets[2].files[0]).toMatchObject({
    content: 'a'.repeat(8000), contentTruncated: true,
    contentRange: { start: 0, end: 8000, total: content.length },
  });
  expect(prepared.input.data).not.toContain('PRIVATE_TAIL_MARKER');
  expect(input.targets[2]!.files![0]!.content).toBe(content);
});

it('preserves the original offsets of a host-admitted selection without representing it as a whole file', () => {
  const input = request();
  const file = input.targets[2]!.files![0]!;
  file.contentRange = { start: 1000, end: 1000 + file.content.length, total: 8000 };
  const wire = JSON.parse(prepareContext(input, 'cloud').input.data);
  expect(wire.targets[2].files[0]).toMatchObject({ content: file.content, contentTruncated: true, contentRange: file.contentRange });
});

it('rejects inconsistent selected-file ranges before opening a provider request', async () => {
  const input = request(); input.targets[2]!.files![0]!.contentRange = { start: 20, end: 21, total: 100 };
  const cloud = fakeProvider();
  const service = createAgentService({ providers: [cloud.provider], isCurrent: () => true });
  try {
    expect(await service.request(input)).toMatchObject({ status: 'failed', code: 'INVALID_REQUEST' });
    expect(cloud.generate).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

it('rejects a seemingly unique replacement when another match lies outside the transmitted excerpt', () => {
  const input = request();
  const before = 'const duration = 200;';
  input.targets[2]!.files![0]!.content = before + '\n' + ' '.repeat(9000) + before;
  const prepared = prepareContext(input, 'cloud');
  expect(prepared.targets[2]!.files![0]!.content.split(before)).toHaveLength(2);
  expect(() => validateProposal(proposal({ actions: [edit(before)] }), input, prepared))
    .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ACTION' }));
});

it('rejects overlapping matches instead of treating nonoverlapping split counts as uniqueness', () => {
  const input = request(); input.targets[2]!.files![0]!.content = 'aaa';
  expect(() => validateProposal(proposal({ actions: [edit('aa')] }), input, prepareContext(input, 'cloud')))
    .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ACTION' }));
});

it('admits a bounded exact proposal only when it is unique in the complete captured content', () => {
  const input = request(); const before = 'const duration = 200;';
  input.targets[2]!.files![0]!.content = before + '\n' + ' '.repeat(9000);
  const output = proposal({ actions: [edit(before)] });
  expect(validateProposal(output, input, prepareContext(input, 'cloud'))).toEqual(output);
});

it('refuses duplicate file targets before opening a provider request', async () => {
  const input = request(); input.targets[2]!.files!.push({ ...input.targets[2]!.files![0]! });
  const cloud = fakeProvider();
  const service = createAgentService({ providers: [cloud.provider], isCurrent: () => true });
  try {
    expect(await service.request(input)).toMatchObject({ status: 'failed', code: 'INVALID_REQUEST' });
    expect(cloud.generate).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

it('admits disjoint changes in one supplied file and rejects intersecting original ranges', () => {
  const input = request(); input.targets[2]!.files![0]!.content = 'const duration = 200; const easing = "linear";';
  const action = edit('duration = 200') as Extract<RegisteredAction, {type:'ProposeWorkspaceEdit'}>;
  action.edits.push({path:'src/timer.ts',before:'"linear"',after:'"ease-out"'});
  expect(validateProposal(proposal({actions:[action]}),input,prepareContext(input,'cloud')).actions).toEqual([action]);
  action.edits.push({path:'src/timer.ts',before:'easing = "linear"',after:'easing = "ease-in"'});
  expect(()=>validateProposal(proposal({actions:[action]}),input,prepareContext(input,'cloud'))).toThrow('overlapping');
});
