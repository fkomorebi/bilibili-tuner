const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let mainWindow;
const jobs = new Map();

function backendScript() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'transcribe.py');
  return path.join(__dirname, '..', 'backend', 'transcribe.py');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { pythonPath: process.env.GUITAR_TRANSCRIBER_PYTHON || '' };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function parseEvents(jobId, chunk, state) {
  state.buffer += chunk.toString();
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      emit('job:event', Object.assign({ jobId }, JSON.parse(line)));
    } catch {
      emit('job:event', { jobId, type: 'log', message: line });
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 760, minWidth: 860, minHeight: 600,
    backgroundColor: '#101116',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('audio:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扒谱的本地音频',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, settings) => {
    saveSettings({ pythonPath: String(settings.pythonPath || '').trim() });
    return loadSettings();
  });

  ipcMain.handle('engine:check', () => {
    const settings = loadSettings();
    const python = settings.pythonPath || process.env.GUITAR_TRANSCRIBER_PYTHON || 'python';
    return new Promise(resolve => {
      const child = spawn(python, [backendScript(), '--check'], {
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONUTF8: '1' })
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', error => resolve({ ok: false, message: error.message }));
      child.on('close', code => {
        try {
          const line = stdout.trim().split(/\r?\n/).pop();
          const result = JSON.parse(line);
          resolve({ ok: code === 0 && result.type === 'ready', message: result.message || stderr });
        } catch {
          resolve({ ok: false, message: stderr || stdout || '无法启动 Python 引擎。' });
        }
      });
    });
  });

  ipcMain.handle('job:start', (_event, options) => {
    const inputPath = String(options.inputPath || '');
    if (!inputPath || !fs.existsSync(inputPath)) throw new Error('请选择存在的本地音频文件。');
    const settings = loadSettings();
    const python = settings.pythonPath || process.env.GUITAR_TRANSCRIBER_PYTHON || 'python';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(app.getPath('documents'), '吉他扒谱助手', stamp);
    fs.mkdirSync(outputPath, { recursive: true });
    const jobId = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    const device = options.device === 'cuda' ? 'cuda' : 'cpu';
    const child = spawn(python, [backendScript(), '--input', inputPath, '--output', outputPath, '--device', device], {
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUTF8: '1' })
    });
    const state = { buffer: '' };
    jobs.set(jobId, child);
    child.stdout.on('data', data => parseEvents(jobId, data, state));
    child.stderr.on('data', data => emit('job:event', { jobId, type: 'log', message: data.toString() }));
    child.on('error', error => emit('job:event', { jobId, type: 'error', message: error.message }));
    child.on('close', code => {
      if (state.buffer.trim()) parseEvents(jobId, Buffer.from('\n'), state);
      emit('job:finished', { jobId, code, outputPath });
      jobs.delete(jobId);
    });
    return { jobId, outputPath };
  });

  ipcMain.handle('job:cancel', (_event, jobId) => {
    const child = jobs.get(jobId);
    if (child && !child.killed) child.kill();
    return Boolean(child);
  });
  ipcMain.handle('notes:read', (_event, notesPath) => {
    const resolvedPath = path.resolve(String(notesPath || ''));
    if (path.extname(resolvedPath).toLowerCase() !== '.csv') {
      throw new Error('只能读取转录生成的音符 CSV 文件。');
    }
    if (!fs.existsSync(resolvedPath)) throw new Error('找不到音符事件文件。');
    return fs.readFileSync(resolvedPath, 'utf8');
  });
  ipcMain.handle('path:open', (_event, targetPath) => shell.openPath(targetPath));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const child of jobs.values()) child.kill();
  if (process.platform !== 'darwin') app.quit();
});
