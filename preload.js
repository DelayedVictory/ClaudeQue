const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cq', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),

  selectProject: (dir) => ipcRenderer.invoke('project:select', dir),
  browseProject: () => ipcRenderer.invoke('project:browse'),
  forgetProject: (dir) => ipcRenderer.invoke('project:forget', dir),

  add: (text) => ipcRenderer.invoke('queue:add', text),
  remove: (id) => ipcRenderer.invoke('queue:remove', id),
  update: (id, text) => ipcRenderer.invoke('queue:update', id, text),
  move: (id, delta) => ipcRenderer.invoke('queue:move', id, delta),
  setPaused: (paused) => ipcRenderer.invoke('queue:pause', paused),
  clear: () => ipcRenderer.invoke('queue:clear'),

  focusSession: () => ipcRenderer.invoke('session:focus'),

  pin: (pinned) => ipcRenderer.invoke('window:pin', pinned),
  openFolder: () => ipcRenderer.invoke('app:openFolder'),
});
