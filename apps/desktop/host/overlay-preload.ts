import { invoke } from './presentation-invoke';
import { contextBridge, ipcRenderer } from 'electron';
import type { EveOverlayBridge, OverlayState } from '../shared/bridge';
const bridge: EveOverlayBridge = {
  search: query => invoke('eve:overlay-search', query),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: OverlayState | null) => listener(state);
    ipcRenderer.on('eve:overlay-state', handler);
    return () => ipcRenderer.removeListener('eve:overlay-state', handler);
  },
  action: action => ipcRenderer.send('eve:overlay-event', action),
  ready: () => ipcRenderer.send('eve:overlay-ready'),
};
contextBridge.exposeInMainWorld('eveOverlay', bridge);
