const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  onConfigChanged: (callback) => {
    const listener = (_event, cfg) => callback(cfg);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  openLeaveDialog: () => ipcRenderer.invoke('leave:open'),
  closeLeaveDialog: () => ipcRenderer.invoke('leave:close'),
  openSalaryReport: () => ipcRenderer.invoke('report:open'),
  closeSalaryReport: () => ipcRenderer.invoke('report:close'),
  getRecords: () => ipcRenderer.invoke('records:get'),
  setLeave: (date, type, start, end) => ipcRenderer.invoke('records:set-leave', date, type, start, end),
  removeLeave: (date) => ipcRenderer.invoke('records:remove-leave', date),
  addOtRecord: (date, ms) => ipcRenderer.invoke('records:add-ot', date, ms),
  onRecordsChanged: (callback) => {
    const listener = (_event, records) => callback(records);
    ipcRenderer.on('records:changed', listener);
    return () => ipcRenderer.removeListener('records:changed', listener);
  },
  onReportRefresh: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('report:refresh', listener);
    return () => ipcRenderer.removeListener('report:refresh', listener);
  },
  hideWidget: () => ipcRenderer.invoke('widget:hide'),
  closeWidget: () => ipcRenderer.invoke('widget:close'),
  onWidgetRefresh: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('widget:refresh', listener);
    return () => ipcRenderer.removeListener('widget:refresh', listener);
  },
  onWidgetVisibility: (callback) => {
    const listener = (_event, hidden) => callback(hidden);
    ipcRenderer.on('widget:visibility', listener);
    return () => ipcRenderer.removeListener('widget:visibility', listener);
  },
  onDockState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('dock:state', listener);
    return () => ipcRenderer.removeListener('dock:state', listener);
  },
  getDockState: () => ipcRenderer.invoke('dock:get-state'),
  dockExpand: () => ipcRenderer.send('dock:expand'),
  dockCollapse: () => ipcRenderer.send('dock:collapse'),
  dockRelease: () => ipcRenderer.send('dock:release'),
  onDockMenuClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('dock:menu-closed', listener);
    return () => ipcRenderer.removeListener('dock:menu-closed', listener);
  },
  showContextMenu: () => ipcRenderer.send('widget:context-menu'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('widget:pin', value),
  resizeWidget: (width, height) => ipcRenderer.invoke('widget:resize', width, height),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (value) => ipcRenderer.invoke('autostart:set', value),
  quit: () => ipcRenderer.invoke('app:quit'),

  getHolidays: () => ipcRenderer.invoke('holidays:get'),
  getHolidayStatus: () => ipcRenderer.invoke('holidays:status'),
  getHolidayApiStatus: () => ipcRenderer.invoke('holidays:api-status'),
  syncHolidayApi: (force, source) => ipcRenderer.invoke('holidays:sync-api', force, source),
  onHolidayApiChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('holidays:api-changed', listener);
    return () => ipcRenderer.removeListener('holidays:api-changed', listener);
  },
  importHolidays: () => ipcRenderer.invoke('holidays:import'),
  openHolidayFolder: () => ipcRenderer.invoke('holidays:open-folder'),
  openHolidayUrl: (url) => ipcRenderer.invoke('holidays:open-url', url),
  clearHolidays: () => ipcRenderer.invoke('holidays:clear'),
  onHolidaysChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('holidays:changed', listener);
    return () => ipcRenderer.removeListener('holidays:changed', listener);
  },
});
