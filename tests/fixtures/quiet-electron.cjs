// Test-only native window boundary. Business code and all IPC handlers stay untouched.
module.exports = function installQuietWindows(electron) {
  const {app, BrowserWindow, dialog, Menu} = electron;
  const state = {created: [], suppressed: [], violations: []};
  app.setActivationPolicy('prohibited');
  app.focus = () => { state.suppressed.push({method: 'app.focus'}); };
  // Return actual native BrowserWindow objects. Subclassing changes the constructor
  // identity used by Electron's getAllWindows/fromWebContents bookkeeping.
  const QuietWindow = new Proxy(BrowserWindow, {
    construct(NativeWindow, [options = {}]) {
      const window = new NativeWindow({...options, show: false, focusable: false});
      state.created.push(window.id);
      window.on('show', () => { state.violations.push({id: window.id, event: 'show'}); window.hide(); });
      window.on('focus', () => { state.violations.push({id: window.id, event: 'focus'}); window.blur(); });
      for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'setAlwaysOnTop']) {
        window[method] = () => { state.suppressed.push({id: window.id, method}); };
      }
      for (const method of ['setFullScreen', 'setKiosk']) {
        window[method] = () => { throw Error('Quiet UI cannot test native ' + method + '; use the foreground project'); };
      }
      return window;
    },
  });
  const quietElectron = Object.create(electron);
  Object.defineProperty(quietElectron, 'BrowserWindow', {value: QuietWindow});
  const refuse = method => () => { throw Error('Quiet UI needs an explicit OS boundary for ' + method + '; use foreground for actual native interaction'); };
  for (const method of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox', 'showMessageBoxSync', 'showErrorBox']) dialog[method] = refuse('dialog.' + method);
  Menu.prototype.popup = refuse('Menu.popup');
  globalThis.ownedQuietWindows = state;
  return quietElectron;
};
