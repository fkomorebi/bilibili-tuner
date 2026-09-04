const $ = selector => document.querySelector(selector);
let selectedAudio = '';
let activeJobId = '';
let outputPath = '';
let notesPath = '';
const ui = {
  audioPath: $('#audio-path'), choose: $('#choose-button'), start: $('#start-button'),
  device: $('#device'), engine: $('#engine-button'), python: $('#python-path'),
  saveSettings: $('#save-settings'), status: $('#status-text'), pill: $('#status-pill'),
  progress: $('#progress-bar'), log: $('#log'), cancel: $('#cancel-button'), openOutput: $('#open-output-button'),
  showTab: $('#show-tab-button'), tabDialog: $('#tab-dialog'), closeTab: $('#close-tab-button'),
  tabScore: $('#tab-score'), tabDescription: $('#tab-description'),
  history: $('#history-list'), refreshHistory: $('#refresh-history-button')
};

function setStatus(message, kind) {
  const state = kind || 'idle';
  ui.status.textContent = message;
  ui.pill.textContent = state === 'running' ? '处理中' : state === 'ready' ? '就绪' : state === 'error' ? '错误' : '待命';
  ui.pill.className = 'pill ' + (state === 'idle' ? '' : state);
}
function addLog(message) {
  ui.log.textContent += String(message).trim() + '\n';
  ui.log.scrollTop = ui.log.scrollHeight;
}
async function checkEngine() {
  setStatus('正在检查 Python、Demucs 和 Basic Pitch…', 'running');
  const result = await window.workbench.checkEngine();
  setStatus(result.message || '引擎状态未知。', result.ok ? 'ready' : 'error');
  addLog(result.message || String(result.ok));
  return result.ok;
}
ui.choose.addEventListener('click', async () => {
  const chosen = await window.workbench.chooseAudio();
  if (!chosen) return;
  selectedAudio = chosen;
  ui.audioPath.value = chosen;
  ui.start.disabled = false;
  setStatus('文件已选择，可以开始处理。', 'ready');
});
ui.engine.addEventListener('click', checkEngine);
ui.saveSettings.addEventListener('click', async () => {
  await window.workbench.saveSettings({ pythonPath: ui.python.value });
  setStatus('设置已保存，请重新检查 AI 引擎。');
});
ui.start.addEventListener('click', async () => {
  if (!selectedAudio) return;
  ui.log.textContent = '';
  notesPath = '';
  ui.showTab.disabled = true;
  ui.start.disabled = true;
  ui.cancel.hidden = false;
  ui.progress.style.width = '2%';
  try {
    const job = await window.workbench.startJob({ inputPath: selectedAudio, device: ui.device.value });
    activeJobId = job.jobId;
    outputPath = job.outputPath;
    setStatus('任务已启动，正在准备模型…', 'running');
  } catch (error) {
    setStatus(error.message, 'error');
    ui.start.disabled = false;
    ui.cancel.hidden = true;
  }
});
ui.cancel.addEventListener('click', () => { if (activeJobId) window.workbench.cancelJob(activeJobId); });
ui.openOutput.addEventListener('click', () => { if (outputPath) window.workbench.openPath(outputPath); });
ui.closeTab.addEventListener('click', () => ui.tabDialog.close());
ui.tabDialog.addEventListener('click', event => {
  if (event.target === ui.tabDialog) ui.tabDialog.close();
});

function parseCsv(text) {
  return text.trim().split(/\r?\n/).slice(1).map(line => {
    const fields = line.split(',').map(value => value.trim());
    return { start: Number(fields[0]), end: Number(fields[1]), midi: Math.round(Number(fields[2])) };
  }).filter(note => Number.isFinite(note.start) && Number.isFinite(note.end) && Number.isFinite(note.midi));
}

// Standard guitar tuning, low E to high E. Prefer the highest playable string so
// the generated tab stays close to conventional hand positions.
function toFret(note) {
  const tuning = [40, 45, 50, 55, 59, 64];
  for (let string = tuning.length - 1; string >= 0; string -= 1) {
    const fret = note.midi - tuning[string];
    if (fret >= 0 && fret <= 24) return { ...note, string, fret };
  }
  return null;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function buildTab(notes) {
  const playable = notes.map(toFret).filter(Boolean).sort((a, b) => a.start - b.start || a.string - b.string);
  if (!playable.length) return { systems: [], skipped: notes.length };
  const groups = [];
  for (const note of playable) {
    const group = groups.findLast(item => Math.abs(item.start - note.start) < 0.04);
    if (group) group.notes.push(note);
    else groups.push({ start: note.start, notes: [note] });
  }
  const systems = [];
  for (let index = 0; index < groups.length; index += 16) systems.push(groups.slice(index, index + 16));
  return { systems, skipped: notes.length - playable.length };
}

function renderTab(notes) {
  const { systems, skipped } = buildTab(notes);
  ui.tabScore.replaceChildren();
  if (!systems.length) {
    ui.tabScore.textContent = '没有可显示的吉他音符。请检查此次转录生成的 CSV。';
    return;
  }
  const names = ['E', 'A', 'D', 'G', 'B', 'e'];
  for (const system of systems) {
    const section = document.createElement('section');
    section.className = 'tab-system';
    const time = document.createElement('div');
    time.className = 'tab-time';
    time.textContent = `${formatTime(system[0].start)} – ${formatTime(system.at(-1).start)}`;
    const grid = document.createElement('div');
    grid.className = 'tab-grid';
    grid.style.gridTemplateColumns = `24px repeat(${system.length}, minmax(32px, 1fr))`;
    for (let string = 5; string >= 0; string -= 1) {
      const label = document.createElement('span');
      label.className = 'tab-string-name';
      label.textContent = names[string];
      grid.append(label);
      for (const group of system) {
        const cell = document.createElement('span');
        cell.className = 'tab-cell';
        const frets = group.notes.filter(note => note.string === string).map(note => note.fret).join('/');
        cell.textContent = frets || '—';
        if (frets) cell.classList.add('has-note');
        grid.append(cell);
      }
    }
    section.append(time, grid);
    ui.tabScore.append(section);
  }
  ui.tabDescription.textContent = `共 ${notes.length} 个识别音符；每列为同时起音的音符，时间从 CSV 读取。${skipped ? ` ${skipped} 个超出 24 品标准吉他音域的音符未显示。` : ''} 请结合 MIDI 与分离吉他轨校对弦位、节奏和推弦。`;
}

async function openTab(notesFile, description) {
  if (!notesFile) return;
  ui.tabScore.textContent = '正在载入音符事件…';
  ui.tabDescription.textContent = description;
  ui.tabDialog.showModal();
  try {
    renderTab(parseCsv(await window.workbench.readNotes(notesFile)));
  } catch (error) {
    ui.tabScore.textContent = `无法读取 TAB 草稿：${error.message}`;
  }
}

function formatHistoryTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '完成时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function createHistoryButton(label, handler, disabled) {
  const button = document.createElement('button');
  button.className = 'secondary';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
}

async function loadHistory() {
  ui.history.replaceChildren();
  try {
    const history = await window.workbench.listHistory();
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '还没有完成的任务。完成一次转录后，会自动显示在这里。';
      ui.history.append(empty);
      return;
    }
    for (const entry of history) {
      const item = document.createElement('article');
      item.className = 'history-item';
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const name = document.createElement('div');
      name.className = 'history-name';
      name.textContent = entry.inputName || '未命名音频';
      name.title = entry.inputPath || '';
      const detail = document.createElement('div');
      detail.className = 'history-detail';
      detail.textContent = `${formatHistoryTime(entry.completedAt)} · ${entry.device === 'cuda' ? 'CUDA' : 'CPU'}`;
      meta.append(name, detail);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      actions.append(
        createHistoryButton('打开 TAB', () => openTab(entry.notesPath, `正在打开历史任务：${entry.inputName || '未命名音频'}。`), !entry.notesPath),
        createHistoryButton('打开文件夹', () => window.workbench.openPath(entry.outputPath), !entry.outputPath)
      );
      item.append(meta, actions);
      ui.history.append(item);
    }
  } catch (error) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = `无法读取任务历史：${error.message}`;
    ui.history.append(empty);
  }
}

ui.refreshHistory.addEventListener('click', loadHistory);

ui.showTab.addEventListener('click', async () => {
  openTab(notesPath, '依据本次转录生成的 CSV 自动排版。');
});
window.workbench.onJobEvent(event => {
  if (event.jobId !== activeJobId) return;
  if (event.type === 'progress') {
    ui.progress.style.width = String(event.percent || 0) + '%';
    setStatus(event.message || '正在处理…', 'running');
  } else if (event.type === 'result') {
    outputPath = event.outputPath || outputPath;
    notesPath = event.notesPath || notesPath;
    ui.openOutput.disabled = false;
    ui.showTab.disabled = !notesPath;
    addLog('已生成：' + event.midiPath);
  } else if (event.type === 'error') {
    setStatus(event.message, 'error');
    addLog('错误：' + event.message);
  } else if (event.message) addLog(event.message);
});
window.workbench.onJobFinished(event => {
  if (event.jobId !== activeJobId) return;
  activeJobId = '';
  ui.cancel.hidden = true;
  ui.start.disabled = false;
  if (event.code === 0) {
    ui.progress.style.width = '100%';
    ui.openOutput.disabled = false;
    setStatus('处理完成。请用吉他分轨和 MIDI 草稿人工校对。', 'ready');
    loadHistory();
  } else if (ui.pill.classList.contains('running')) {
    setStatus('任务没有完成，请查看日志。', 'error');
  }
});
(async () => {
  const settings = await window.workbench.loadSettings();
  ui.python.value = settings.pythonPath || '';
  loadHistory();
})();
