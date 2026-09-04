const $ = selector => document.querySelector(selector);
let selectedAudio = '';
let activeJobId = '';
let outputPath = '';
let notesPath = '';
let alphaTabApi = null;
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

const GUITAR_TUNING = [40, 45, 50, 55, 59, 64]; // low E to high E
const QUANTUM_SECONDS = 0.125; // 120 BPM 的十六分音符，保持 CSV 的秒级时间轴。

function candidatesForNote(note) {
  const preferredString = Math.max(0, Math.min(5, Math.round((note.midi - 40) / 5)));
  return GUITAR_TUNING.map((openMidi, string) => ({ string, fret: note.midi - openMidi }))
    .filter(position => position.fret >= 0 && position.fret <= 24)
    .sort((a, b) => (
      Math.abs(a.string - preferredString) * 4 + a.fret * 0.3
      - Math.abs(b.string - preferredString) * 4 - b.fret * 0.3
    ));
}

// Resolve a chord as a small assignment problem: one note per string, preferring
// normal playing positions around the string where that pitch is usually found.
function assignFrets(notes) {
  const candidates = notes.map(note => ({ note, positions: candidatesForNote(note) }));
  let best = [];
  let bestCost = Infinity;
  function visit(index, usedStrings, assigned, cost) {
    if (cost >= bestCost) return;
    if (index === candidates.length) {
      best = assigned;
      bestCost = cost;
      return;
    }
    const item = candidates[index];
    for (const position of item.positions) {
      if (usedStrings.has(position.string)) continue;
      const nextUsed = new Set(usedStrings);
      nextUsed.add(position.string);
      visit(index + 1, nextUsed, [...assigned, { ...item.note, ...position }], cost + item.positions.indexOf(position));
    }
    // Basic Pitch can occasionally report more than six simultaneous pitches.
    // Keeping the best playable subset is more useful than dropping that whole onset.
    visit(index + 1, usedStrings, assigned, cost + 100);
  }
  visit(0, new Set(), [], 0);
  return best;
}

function groupOnsets(notes) {
  const groups = [];
  for (const note of [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi)) {
    const previous = groups.at(-1);
    if (previous && note.start - previous.start < 0.045) previous.notes.push(note);
    else groups.push({ start: note.start, notes: [note] });
  }
  return groups;
}

function buildAlphaTex(notes) {
  const onsetGroups = groupOnsets(notes);
  if (!onsetGroups.length) return { tex: '', displayed: 0, skipped: 0, tempo: 120 };
  const origin = onsetGroups[0].start;
  const timeline = new Map();
  let skipped = 0;
  let displayed = 0;
  for (const group of onsetGroups) {
    const step = Math.max(0, Math.round((group.start - origin) / QUANTUM_SECONDS));
    const merged = timeline.get(step) || [];
    timeline.set(step, merged.concat(group.notes));
  }
  for (const [step, groupedNotes] of timeline) {
    const assigned = assignFrets(groupedNotes);
    skipped += groupedNotes.length - assigned.length;
    displayed += assigned.length;
    timeline.set(step, assigned);
  }
  if (!displayed) return { tex: '', displayed, skipped: notes.length, tempo: 120 };

  const lastStep = Math.max(...timeline.keys());
  const beats = [];
  for (let step = 0; step <= lastStep; step += 1) {
    const chord = timeline.get(step);
    if (!chord || !chord.length) beats.push('r');
    else {
      // alphaTex string 1 is the high E string, while our tuning array is low-to-high.
      const values = chord.map(note => `${note.fret}.${6 - note.string}`);
      beats.push(values.length === 1 ? values[0] : `(${values.join(' ')})`);
    }
  }
  while (beats.length % 16) beats.push('r'); // complete the final 4/4 bar.
  const bars = [];
  for (let index = 0; index < beats.length; index += 16) bars.push(beats.slice(index, index + 16).join(' '));
  return {
    tex: [
      '\\title "自动 TAB 草稿"',
      '\\subtitle "从转录音符自动量化；请人工校对"',
      '\\tempo 120',
      '\\ts 4 4',
      '\\tuning (E4 B3 G3 D3 A2 E2) { label "Standard" }',
      '.',
      `:16 ${bars.join(' | ')}`
    ].join('\n'),
    displayed,
    skipped,
    tempo: 120
  };
}

function clearAlphaTab() {
  if (alphaTabApi) alphaTabApi.destroy();
  alphaTabApi = null;
  ui.tabScore.replaceChildren();
}

function showTabMessage(message) {
  clearAlphaTab();
  const messageElement = document.createElement('p');
  messageElement.className = 'tab-message';
  messageElement.textContent = message;
  ui.tabScore.append(messageElement);
}

function renderTab(notes) {
  const score = buildAlphaTex(notes);
  if (!score.tex) {
    showTabMessage('没有可显示的标准吉他音符。请检查此次转录生成的 CSV。');
    return;
  }
  if (!window.alphaTab) {
    showTabMessage('alphaTab 资源未能加载，无法渲染 TAB。');
    return;
  }
  clearAlphaTab();
  try {
    const assets = new URL('../../node_modules/@coderline/alphatab/dist/', window.location.href).href;
    alphaTabApi = new window.alphaTab.AlphaTabApi(ui.tabScore, {
      core: {
        engine: 'svg',
        useWorkers: false,
        enableLazyLoading: false,
        scriptFile: `${assets}alphaTab.min.js`,
        fontDirectory: `${assets}font/`
      },
      display: { scale: 0.9, barsPerRow: 4 }
    });
    alphaTabApi.error.on(error => showTabMessage(`无法渲染 TAB：${error.message}`));
    alphaTabApi.tex(score.tex);
    ui.tabDescription.textContent = `已用 alphaTab 排版 ${score.displayed} 个音符（120 BPM、4/4、十六分音符量化）。${score.skipped ? ` ${score.skipped} 个音符因超出 24 品范围或同一时刻弦位冲突而未显示。` : ''} 节奏和指法均为自动推断，请结合分离吉他轨与 MIDI 校对。`;
  } catch (error) {
    showTabMessage(`无法初始化 alphaTab：${error.message}`);
  }
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
