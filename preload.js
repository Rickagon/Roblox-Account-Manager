const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('ram', {
  init: () => call('init'),
  setSettings: patch => call('settings:set', patch),

  addAccount: () => call('account:add'),
  addLogins: text => call('account:addLogins', text),
  addCookies: text => call('account:addCookies', text),
  relogin: id => call('account:relogin', id),
  openBrowser: (id, url) => call('account:browser', id, url),
  updateAccount: (id, patch) => call('account:update', id, patch),
  setPassword: (id, pw) => call('account:setPassword', id, pw),
  updateMany: (ids, patch) => call('account:updateMany', ids, patch),
  placeInfo: placeId => call('place:info', placeId),
  resolvePlace: (placeId, jobId) => call('place:resolve', { placeId, jobId }),
  summary: id => call('account:summary', id),
  setDisplayName: (ids, name) => call('account:setDisplayName', ids, name),
  changePassword: (ids, cur, next) => call('account:changePassword', ids, cur, next),
  setJoinPrivacy: (ids, value) => call('account:setJoinPrivacy', ids, value),
  removeAccounts: (ids, doLogout) => call('account:remove', ids, doLogout),
  reorder: ids => call('account:reorder', ids),
  copy: (id, what) => call('account:copy', id, what),
  copyMany: (ids, what) => call('account:copyMany', ids, what),
  checkAccounts: ids => call('account:check', ids),

  join: opts => call('join', opts),
  servers: (placeId, cursor) => call('servers', { placeId, cursor }),
  removeRecent: placeId => call('recent:remove', placeId),
  closeAllRoblox: () => call('roblox:closeAll'),
  arrangeWindows: () => call('roblox:arrange'),
  fixMultiRoblox: () => call('multiRoblox:fix'),
  forceFixMultiRoblox: () => call('multiRoblox:forceFix'),

  checkUpdate: () => call('update:check'),
  applyUpdate: () => call('update:apply'),
  copyText: text => call('clipboard:write', text),
  appInfo: () => call('app:info'),

  pickRamFile: () => call('import:pick'),
  importRam: (file, password) => call('import:ram', file, password),
  openExternal: url => call('open:external', url),
  openRepo: () => call('open:repo'),

  onAccounts: fn => on('accounts', fn),
  onPresence: fn => on('presence', fn),
  onRecent: fn => on('recent', fn),
  onLog: fn => on('log', fn),
  onKeepAlive: fn => on('keepalive', fn),
  onJoining: fn => on('joining', fn),
  onMultiRoblox: fn => on('multiRoblox', fn),
  onUpdate: fn => on('update', fn),
});
