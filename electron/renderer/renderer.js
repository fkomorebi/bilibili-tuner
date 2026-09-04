const $ = selector => document.querySelector(selector);
let selectedAudio = '';
let activeJobId = '';
let outputPath = '';
const ui = {
  audioPath: $('#audio-path'), choose: $('#choose-button'), start: $('#start-button'),
  device: $('#device'), engine: $('#engine-button'), python: $('#python-path'),
  saveSettings: $('#save-settings'), status: $('#status-text'), pill: $('#status-pill'),
  progress: $('#progress-bar'), log: $('#log'), cancel: $('#cancel-button'), openOutput: $('#open-output-button')
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
window.workbench.onJobEvent(event => {
  if (event.jobId !== activeJobId) return;
  if (event.type === 'progress') {
    ui.progress.style.width = String(event.percent || 0) + '%';
    setStatus(event.message || '正在处理…', 'running');
  } else if (event.type === 'result') {
    outputPath = event.outputPath || outputPath;
    ui.openOutput.disabled = false;
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
  } else if (ui.pill.classList.contains('running')) {
    setStatus('任务没有完成，请查看日志。', 'error');
  }
});
(async () => {
  const settings = await window.workbench.loadSettings();
  ui.python.value = settings.pythonPath || '';
})();
