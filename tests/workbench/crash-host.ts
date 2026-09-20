/** Test-only host subprocess. IPC is private to its parent, never exposed to a renderer. */
import { startWorkbench, type WorkbenchOptions, type WorkbenchService } from '../../apps/desktop/host/workbench';
import type { WorkbenchMethod } from '../../extensions/eve-workbench/src/protocol';

let service: WorkbenchService | undefined;
process.on('message', async (input: { id: string; method: string; params: any }) => {
  try {
    let result: unknown;
    if (input.method === 'start') {
      service = await startWorkbench(input.params as WorkbenchOptions);
      let cookie: unknown;
      await service.authenticate({ cookies: { set: async value => { cookie = value; } } });
      result = { url: service.url, cookie, recoveryDirectory: service.recoveryDirectory };
    } else if (input.method === 'connected') result = await service!.waitUntilConnected();
    else if (input.method === 'recovery') result = await service!.loadRecovery();
    else if (input.method === 'durable-recovery') result = await service!.captureDurableRecovery();
    else if (input.method === 'recovery-batch') result = await service!.loadRecoveryBatch();
    else if (input.method === 'acknowledge-recovery') result = await service!.acknowledgeRecovery(input.params);
    else if (input.method === 'close') { await service!.close(); result = true; }
    else result = await service!.call(input.method as WorkbenchMethod, input.params);
    process.send?.({ id: input.id, result });
    if (input.method === 'close') process.disconnect();
  } catch (error) { process.send?.({ id: input.id, error: error instanceof Error ? error.message : String(error) }); }
});
