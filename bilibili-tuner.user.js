// ==UserScript==
// @name         哔哩哔哩视频音高显示器
// @namespace    https://github.com/fkomo/bilibili-tuner
// @version      1.0.0
// @description  实时显示 B 站视频当前主音高（音名、频率和 cents 偏差）
// @author       fkomo
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/*
// @match        *://player.bilibili.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 这是一个“主音高”检测器，适合人声、独奏乐器和单音旋律。
 * 和弦、鼓点、环境声或多人同时说话没有唯一基频，结果会显示为“—”。
 * “吉他优先”会收窄分析频段和候选音域；它不等同于 AI 分离吉他轨。
 */
(function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const A4_FREQUENCY = 440;
  const A4_MIDI = 69;
  const MIN_FREQUENCY = 55;
  const MAX_FREQUENCY = 1200;
  const GUITAR_MIN_FREQUENCY = 75;    // 略低于标准吉他最低音 E2 (82.4Hz)
  const GUITAR_MAX_FREQUENCY = 1320;  // 略高于标准吉他最高空弦 E6 (1318.5Hz)
  // 快速演奏时约每秒更新 30 次；低音稳定性与响应速度之间的折中。
  const UPDATE_MS = 33;
  const ANALYSER_FFT_SIZE = 2048;
  const YIN_THRESHOLD = 0.16;

  let panel;
  let noteElement;
  let frequencyElement;
  let centsElement;
  let statusElement;
  let context;
  let analyser;
  let source;
  let analysisHighPass;
  let analysisLowPass;
  let currentVideo;
  let sampleBuffer;
  let timer = 0;
  let enabled = true;
  let guitarFocus = true;
  let videoResizeObserver;

  function style (element, rules) {
    Object.entries(rules).forEach(([name, value]) => element.style.setProperty(name, value, 'important'));
  }

  function makePanel () {
    if (panel) return;
    panel = document.createElement('aside');
    panel.id = 'bilibili-tuner-panel';
    panel.innerHTML = [
      '<div class="bt-title">当前音高</div>',
      '<div class="bt-note">—</div>',
      '<div class="bt-details"><span data-field="frequency">— Hz</span><span data-field="cents">— ¢</span></div>',
      '<div class="bt-status" data-field="status">等待播放</div>'
    ].join('');
    style(panel, {
      position: 'fixed', left: '18px', top: '110px', zIndex: '2147483647',
      width: '172px', padding: '12px 14px', border: '1px solid rgba(251,114,153,.85)',
      borderRadius: '12px', background: 'rgba(18,18,22,.84)', color: '#fff',
      boxShadow: '0 8px 28px rgba(0,0,0,.38)', backdropFilter: 'blur(8px)',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      userSelect: 'none', pointerEvents: 'none', display: 'block', visibility: 'visible', opacity: '1',
      transition: 'left .12s ease, top .12s ease'
    });
    const title = panel.querySelector('.bt-title');
    const note = panel.querySelector('.bt-note');
    const details = panel.querySelector('.bt-details');
    style(title, { color: '#b8bbc2', fontSize: '12px' });
    style(note, { marginTop: '1px', color: '#fb7299', fontSize: '34px', fontWeight: '700', letterSpacing: '1px', lineHeight: '1.15' });
    style(details, { display: 'flex', justifyContent: 'space-between', marginTop: '4px', color: '#e7e8ea', fontSize: '12px' });
    statusElement = panel.querySelector('[data-field="status"]');
    style(statusElement, { display: 'block', marginTop: '7px', color: '#989ca5', fontSize: '11px', lineHeight: '1.25' });
    document.body.appendChild(panel);
    noteElement = note;
    frequencyElement = panel.querySelector('[data-field="frequency"]');
    centsElement = panel.querySelector('[data-field="cents"]');

    const toggle = document.createElement('button');
    toggle.id = 'bilibili-tuner-toggle';
    toggle.type = 'button';
    toggle.textContent = '音高：开';
    toggle.title = '显示或隐藏音高检测器';
    style(toggle, {
      position: 'fixed', left: '18px', top: '286px', zIndex: '2147483647',
      padding: '7px 10px', border: '1px solid rgba(251,114,153,.85)', borderRadius: '7px',
      background: 'rgba(18,18,22,.84)', color: '#fff', cursor: 'pointer',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', fontSize: '12px'
    });
    toggle.addEventListener('click', () => {
      enabled = !enabled;
      panel.style.setProperty('display', enabled ? 'block' : 'none', 'important');
      toggle.textContent = enabled ? '音高：开' : '音高：关';
      if (enabled && currentVideo && !currentVideo.paused) update();
    });
    document.body.appendChild(toggle);
    panel._toggle = toggle;

    const guitarToggle = document.createElement('button');
    guitarToggle.id = 'bilibili-tuner-guitar-focus';
    guitarToggle.type = 'button';
    guitarToggle.textContent = '吉他优先：开';
    guitarToggle.title = '优先检测标准吉他常见音域，不会改变播放声音';
    style(guitarToggle, {
      position: 'fixed', left: '18px', top: '324px', zIndex: '2147483647',
      padding: '7px 10px', border: '1px solid rgba(251,114,153,.85)', borderRadius: '7px',
      background: 'rgba(18,18,22,.84)', color: '#fff', cursor: 'pointer',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', fontSize: '12px'
    });
    guitarToggle.addEventListener('click', () => {
      guitarFocus = !guitarFocus;
      configureAnalysisFilters();
      guitarToggle.textContent = guitarFocus ? '吉他优先：开' : '吉他优先：关';
      setStatus(guitarFocus ? '吉他优先已开启' : '全频分析已开启');
      if (currentVideo && !currentVideo.paused) update();
    });
    document.body.appendChild(guitarToggle);
    panel._guitarToggle = guitarToggle;
  }

  // 始终以 video 的可视区域为基准定位，而不是固定在页面右下角。
  function positionPanel () {
    if (!panel || !currentVideo || !currentVideo.isConnected) return;
    const rect = currentVideo.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 50) return;
    const panelWidth = panel.offsetWidth || 200;
    const gap = 12;
    let left = rect.right + gap;
    // 常规页面放在视频外侧；全屏或窄窗口则放到视频右侧内缘。
    if (left + panelWidth > window.innerWidth - gap) left = rect.right - panelWidth - gap;
    left = Math.max(gap, left);
    const top = Math.max(gap, Math.min(rect.bottom - 96, rect.top + 16));
    panel.style.setProperty('left', Math.round(left) + 'px', 'important');
    panel.style.setProperty('top', Math.round(top) + 'px', 'important');
    const toggle = panel._toggle;
    if (toggle) {
      toggle.style.setProperty('left', Math.round(left) + 'px', 'important');
      toggle.style.setProperty('top', Math.round(top + panel.offsetHeight + 8) + 'px', 'important');
    }
    const guitarToggle = panel._guitarToggle;
    if (guitarToggle) {
      guitarToggle.style.setProperty('left', Math.round(left) + 'px', 'important');
      guitarToggle.style.setProperty('top', Math.round(top + panel.offsetHeight + 45) + 'px', 'important');
    }
  }

  function setStatus (message) {
    if (statusElement) statusElement.textContent = message;
  }

  function frequencyToNote (frequency) {
    const exactMidi = A4_MIDI + 12 * Math.log2(frequency / A4_FREQUENCY);
    const midi = Math.round(exactMidi);
    return {
      name: NOTE_NAMES[(midi % 12 + 12) % 12] + (Math.floor(midi / 12) - 1),
      cents: Math.round((exactMidi - midi) * 100)
    };
  }

  /*
   * YIN 的差分函数 + 累积均值归一化。先把分析数据降采样，
   * 避免每次 UI 刷新时做百万级运算，同时仍覆盖 55–1200Hz。
   */
  function detectPitch (input, inputSampleRate, minFrequency, maxFrequency) {
    const stride = Math.max(1, Math.floor(inputSampleRate / 12000));
    const size = Math.floor(input.length / stride);
    const rate = inputSampleRate / stride;
    const minLag = Math.max(2, Math.floor(rate / maxFrequency));
    const maxLag = Math.min(Math.floor(rate / minFrequency), Math.floor(size / 2));
    if (maxLag <= minLag) return null;

    let mean = 0;
    for (let i = 0; i < size; i++) mean += input[i * stride];
    mean /= size;
    let rms = 0;
    const values = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const value = input[i * stride] - mean;
      values[i] = value;
      rms += value * value;
    }
    if (Math.sqrt(rms / size) < 0.008) return null;

    const cmndf = new Float32Array(maxLag + 1);
    cmndf[0] = 1;
    let runningSum = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let difference = 0;
      for (let i = 0; i < size - lag; i++) {
        const delta = values[i] - values[i + lag];
        difference += delta * delta;
      }
      runningSum += difference;
      cmndf[lag] = runningSum ? difference * lag / runningSum : 1;
    }

    let lag = -1;
    for (let candidate = minLag; candidate <= maxLag; candidate++) {
      if (cmndf[candidate] < YIN_THRESHOLD) {
        lag = candidate;
        while (lag + 1 <= maxLag && cmndf[lag + 1] < cmndf[lag]) lag++;
        break;
      }
    }
    if (lag < 0) return null;

    const before = cmndf[Math.max(0, lag - 1)];
    const center = cmndf[lag];
    const after = cmndf[Math.min(maxLag, lag + 1)];
    const denominator = before - 2 * center + after;
    const refinedLag = denominator ? lag + 0.5 * (before - after) / denominator : lag;
    const frequency = rate / refinedLag;
    if (!Number.isFinite(frequency) || frequency < minFrequency || frequency > maxFrequency) return null;
    return { frequency, confidence: Math.max(0, Math.min(1, 1 - center)) };
  }

  function update () {
    clearTimeout(timer);
    positionPanel();
    if (!enabled) {
      timer = window.setTimeout(update, UPDATE_MS);
      return;
    }
    if (!currentVideo || currentVideo.paused || currentVideo.ended) {
      setStatus(currentVideo?.ended ? '播放结束' : '已暂停');
      return;
    }
    if (!analyser || !context || context.state !== 'running') {
      setStatus('点击播放器以启用分析');
      return;
    }
    analyser.getFloatTimeDomainData(sampleBuffer);
    const result = detectPitch(
      sampleBuffer,
      context.sampleRate,
      guitarFocus ? GUITAR_MIN_FREQUENCY : MIN_FREQUENCY,
      guitarFocus ? GUITAR_MAX_FREQUENCY : MAX_FREQUENCY
    );
    if (result) {
      const note = frequencyToNote(result.frequency);
      noteElement.textContent = note.name;
      frequencyElement.textContent = result.frequency.toFixed(1) + ' Hz';
      centsElement.textContent = (note.cents >= 0 ? '+' : '') + note.cents + ' ¢';
      setStatus((guitarFocus ? '吉他优先 · ' : '') + '置信度 ' + Math.round(result.confidence * 100) + '%');
    } else {
      noteElement.textContent = '—';
      frequencyElement.textContent = '— Hz';
      centsElement.textContent = '— ¢';
      setStatus('未检测到清晰主音');
    }
    timer = window.setTimeout(update, UPDATE_MS);
  }

  function unlockAudio () {
    if (context?.state === 'suspended') {
      context.resume().then(() => {
        if (currentVideo && !currentVideo.paused) update();
      }).catch(() => setStatus('浏览器阻止了音频分析'));
    }
  }

  function configureAnalysisFilters () {
    if (!analysisHighPass || !analysisLowPass) return;
    // 仅用于检测支路，播放器的声音仍走 source → destination 的原始路径。
    analysisHighPass.frequency.setValueAtTime(guitarFocus ? 75 : 35, context.currentTime);
    analysisLowPass.frequency.setValueAtTime(guitarFocus ? 1600 : 4000, context.currentTime);
  }

  function disconnectGraph () {
    clearTimeout(timer);
    if (source) source.disconnect();
    if (analyser) analyser.disconnect();
    if (analysisHighPass) analysisHighPass.disconnect();
    if (analysisLowPass) analysisLowPass.disconnect();
    if (context) context.close().catch(() => {});
    context = analyser = source = analysisHighPass = analysisLowPass = sampleBuffer = null;
  }

  function attachToVideo (video) {
    if (!video || video === currentVideo) return;
    disconnectGraph();
    currentVideo = video;
    makePanel();
    positionPanel();
    if (typeof ResizeObserver !== 'undefined') {
      videoResizeObserver?.disconnect();
      videoResizeObserver = new ResizeObserver(positionPanel);
      videoResizeObserver.observe(video);
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('浏览器不支持 Web Audio');
      context = new AudioContextClass();
      source = context.createMediaElementSource(video);
      analyser = context.createAnalyser();
      analysisHighPass = context.createBiquadFilter();
      analysisHighPass.type = 'highpass';
      analysisHighPass.Q.value = 0.7;
      analysisLowPass = context.createBiquadFilter();
      analysisLowPass.type = 'lowpass';
      analysisLowPass.Q.value = 0.7;
      // 48kHz 下约为 43ms 的分析窗口，更适合快速拨弦/音阶。
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source.connect(context.destination);
      source.connect(analysisHighPass);
      analysisHighPass.connect(analysisLowPass);
      analysisLowPass.connect(analyser);
      configureAnalysisFilters();
      sampleBuffer = new Float32Array(analyser.fftSize);
      video.addEventListener('play', () => { unlockAudio(); update(); });
      video.addEventListener('pause', () => { clearTimeout(timer); setStatus('已暂停'); });
      video.addEventListener('ended', () => { clearTimeout(timer); setStatus('播放结束'); });
      video.addEventListener('emptied', () => setStatus('正在切换视频'));
      setStatus(context.state === 'running' ? '等待播放' : '点击播放器以启用分析');
      if (!video.paused) { unlockAudio(); update(); }
    } catch (error) {
      noteElement.textContent = '不可用';
      setStatus('无法接入音频：' + (error?.message || error));
    }
  }

  function findVideo () {
    const videos = [...document.querySelectorAll('video')];
    const video = videos.find(item => item.readyState > 0 && item.getBoundingClientRect().width > 100) || videos[0];
    if (video) attachToVideo(video);
    else setStatus('正在查找 B 站播放器…');
  }

  function start () {
    // 即使播放器仍在异步加载，也先给出一个明确的“脚本已运行”信号。
    makePanel();
    setStatus('正在查找 B 站播放器…');
    findVideo();
    new MutationObserver(findVideo).observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(findVideo, 1000);
    // AudioContext 只能由用户手势解锁；捕获阶段覆盖点击播放器、空格键等操作。
    document.addEventListener('pointerdown', unlockAudio, true);
    document.addEventListener('keydown', unlockAudio, true);
    window.addEventListener('resize', positionPanel, { passive: true });
    document.addEventListener('scroll', positionPanel, { capture: true, passive: true });
    document.addEventListener('fullscreenchange', positionPanel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
