import { ipcRenderer } from 'electron';

/** Keep Electron's method names out of ordinary product error messages. */
export async function invoke(channel: string, ...arguments_: unknown[]) {
  try { return await ipcRenderer.invoke(channel, ...arguments_); }
  catch (error) {
    const original = error instanceof Error ? error.message : 'Eve could not complete this action. Try again.';
    const message = original.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    throw new Error(message || 'Eve could not complete this action. Try again.');
  }
}
