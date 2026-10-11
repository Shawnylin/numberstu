import {
  PAIRS, STORAGE_KEY, createState, restoreState, getUnit, answerDetails, judgeAnswer,
  availableUnits, startSession, recordAnswer, nextQuestion, finishSession, resultStats, overview, dayKey,
} from './training.js';

const $ = id => document.getElementById(id);
const strategyNames = { adaptive: '智能练习', shuffle: '随机覆盖', mistakes: '错题巩固' };
const directionNames = { mixed: '双向混合', percent: '百分数 → 分数', fraction: '分数 → 百分数' };
let state = createState();
let lastRaw = null;
let storageAvailable = true;
let route = 'home';
let timerStarted = null;
let lastSummary = null;
let pendingImport = null;
let installPrompt = null;
let registration = null;
let offlineReady = false;
let updateRequested = false;
const dialogOpeners = new WeakMap();

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

try {
  lastRaw = localStorage.getItem(STORAGE_KEY);
  if (lastRaw) state = restoreState(lastRaw);
} catch {
  if (lastRaw) {
    try {
      localStorage.setItem(`${STORAGE_KEY}-invalid-${Date.now()}`, lastRaw);
      notice('保存的记录格式异常，原数据已另存于本机。可在学习记录中选择有效备份恢复。');
    } catch {
      storageAvailable = false;
      notice('保存的记录格式异常，暂时无法写入本机。请先从有效备份恢复。');
    }
  }
  else {
    storageAvailable = false;
    notice('浏览器暂时无法保存记录，本次仍可训练。离开前请导出备份。');
  }
}

function syncFromStorage(raw) {
  timerStarted = null;
  try {
    state = raw ? restoreState(raw) : createState();
    lastRaw = raw;
    document.querySelectorAll('dialog[open]').forEach(dialog => closeDialog(dialog));
    showView('home');
    notice('另一个页面更新了记录，已同步到最新进度。点击继续本轮即可接着练习。');
  } catch {
    notice('另一个页面的记录格式异常。请先导出当前备份，再恢复有效记录。');
  }
}

function persist() {
  if (!storageAvailable) return true;
  try {
    const currentRaw = localStorage.getItem(STORAGE_KEY);
    if (currentRaw !== lastRaw) {
      syncFromStorage(currentRaw);
      return false;
    }
    const newRaw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, newRaw);
    lastRaw = newRaw;
    return true;
  } catch {
    storageAvailable = false;
    notice('浏览器暂时无法保存记录，本次仍可训练。离开前请导出备份。');
    return true;
  }
}

window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) syncFromStorage(event.key === null ? null : event.newValue);
});

function tick() {
  if (timerStarted !== null && state.session?.current?.phase === 'answering') {
    const now = performance.now();
    state.session.current.elapsedMs += now - timerStarted;
    timerStarted = now;
  }
}

function resumeTimer() {
  timerStarted = route === 'quiz' && !document.hidden && !document.querySelector('dialog[open]') &&
    state.session?.current?.phase === 'answering' ? performance.now() : null;
}

function showView(view) {
  tick();
  timerStarted = null;
  route = view;
  document.body.dataset.view = view;
  for (const name of ['home', 'quiz', 'result']) $(`${name}View`).hidden = name !== view;
  if (view === 'home') renderHome();
  if (view === 'quiz') renderQuiz();
  resumeTimer();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setStat(id, value, suffix) {
  const small = document.createElement('small');
  small.textContent = suffix;
  $(id).replaceChildren(document.createTextNode(`${value} `), small);
}

function renderHome() {
  const info = overview(state);
  setStat('masteredCount', info.mastered, '/ 60');
  setStat('streakCount', info.streak, '天');
  $('dueCount').textContent = info.due;
  $('dailyProgress').textContent = `${info.today} / ${state.settings.dailyGoal} 题`;
  $('dailyBar').style.width = `${Math.min(100, info.today / state.settings.dailyGoal * 100)}%`;
  const settings = state.session?.settings || state.settings;
  $('strategy').value = settings.strategy;
  $('direction').value = settings.direction;
  $('roundLength').value = settings.length;
  $('pace').value = settings.targetSeconds;
  $('settingsForm').querySelectorAll('select').forEach(select => { select.disabled = Boolean(state.session); });
  const hasSession = Boolean(state.session);
  $('startBtn').textContent = hasSession ? '继续训练' : '开始训练';
  const empty = !hasSession && !availableUnits(state).length;
  $('startBtn').disabled = empty;
  $('emptyMistakes').hidden = !empty;
  $('resumeNote').hidden = !hasSession;
  $('endBtn').hidden = !hasSession;
  if (hasSession) $('resumeNote').textContent = `已完成 ${state.session.results.length} / ${settings.length} 题 · 本轮设置已锁定`;
}

function renderQuiz() {
  const session = state.session;
  if (!session?.current) { completeSession(); return; }
  const question = session.current;
  const unit = getUnit(question.unitKey);
  const details = answerDetails(unit);
  const stats = resultStats(session.results);
  const answered = question.phase === 'feedback';
  $('sessionLabel').textContent = `${strategyNames[session.settings.strategy]} · ${directionNames[session.settings.direction]}`;
  $('progress').textContent = `${Math.min(session.settings.length, stats.total + Number(!answered))} / ${session.settings.length}`;
  $('accuracy').textContent = stats.total ? `${stats.accuracy}%` : '—';
  $('sessionBar').style.width = `${stats.total / session.settings.length * 100}%`;
  $('targetLabel').textContent = `目标 ${session.settings.targetSeconds} 秒`;
  $('timer').textContent = `${(question.elapsedMs / 1000).toFixed(1)}s`;
  $('questionReason').textContent = question.reason;
  $('difficultyLabel').textContent = ['', '基础', '进阶', '近似转换'][unit.pair.difficulty];
  $('questionLabel').textContent = unit.direction === 'percent' ? '换算为分数' : '换算为百分数';
  $('prompt').textContent = details.prompt;
  $('answer').value = question.input;
  $('answer').setAttribute('aria-label', unit.direction === 'percent' ? '答案：分母' : '答案：百分数数值');
  $('answerPrefix').hidden = unit.direction !== 'percent';
  $('answerSuffix').hidden = unit.direction !== 'fraction';
  $('submitBtn').textContent = answered ? stats.total >= session.settings.length ? '查看总结' : '下一题 →' : '确认';
  $('keypad').querySelectorAll('button').forEach(button => { button.disabled = answered && button.dataset.key !== 'enter'; });
  $('helpActions').hidden = answered;
  $('helpNote').hidden = answered;
  $('hintBtn').disabled = question.helped;
  $('explanation').hidden = !answered;
  if (answered) {
    const result = session.results.at(-1);
    $('feedback').className = `feedback ${result.firstCorrect ? 'ok' : 'hint'}`;
    $('feedback').textContent = result.firstCorrect ? '首答正确' : result.correct ? '答对，已计入错题' : `答案：${details.display}`;
    $('explanation').textContent = details.explanation;
  } else if (question.helped) {
    $('feedback').className = 'feedback hint';
    $('feedback').textContent = details.hint;
  } else if (question.wrongAttempts) {
    $('feedback').className = 'feedback bad';
    $('feedback').textContent = '答案有误，可重试或看答案';
  } else {
    $('feedback').className = 'feedback';
    $('feedback').textContent = '';
  }
  resumeTimer();
  if (!answered) $('answer').focus({ preventScroll: true });
}

function begin() {
  if (!state.session && !startSession(state)) return;
  if (!persist()) return;
  if (storageAvailable) notice('');
  showView('quiz');
}

function completeSession() {
  tick();
  timerStarted = null;
  const current = state.session?.current;
  // Do not erase evidence of a failed or assisted answer when ending early.
  if (current?.phase === 'answering' && (current.wrongAttempts || current.helped)) recordAnswer(state, 'skip');
  const summary = finishSession(state);
  if (!summary || !persist()) return;
  if (storageAvailable) notice('');
  lastSummary = summary;
  renderResult(summary);
  showView('result');
}

function renderResult(summary) {
  const stats = resultStats(summary.results);
  $('resultTag').textContent = summary.partial ? '本轮已结束' : '本轮完成';
  $('resultMessage').textContent = stats.total ? `首答 ${stats.correct} / ${stats.total} 题正确` : '本轮未答题';
  $('resultAccuracy').textContent = stats.total ? `${stats.accuracy}%` : '—';
  $('resultTime').textContent = `${stats.avgSeconds.toFixed(1)}s`;
  $('resultCount').textContent = stats.total;
  const weak = [...new Map(stats.weak.map(result => [result.unitKey, result])).values()];
  const slow = summary.results.filter(result => result.firstCorrect && result.elapsedMs > summary.settings.targetSeconds * 1000);
  const items = [...weak, ...new Map(slow.map(result => [result.unitKey, result])).values()].filter((item, index, all) => all.findIndex(other => other.unitKey === item.unitKey) === index);
  $('weakCount').textContent = `${weak.length} 个待巩固方向`;
  $('resultList').replaceChildren();
  for (const result of items) {
    const unit = getUnit(result.unitKey);
    const details = answerDetails(unit);
    const item = document.createElement('div');
    item.className = 'review-item';
    const title = document.createElement('strong');
    title.textContent = `${details.prompt} ≈ ${details.display}`;
    const note = document.createElement('span');
    const label = result.firstCorrect ? '答对但偏慢' : { retry: '重试后答对', hint: '提示后答对', reveal: '查看过答案', skip: '跳过', correct: '待巩固' }[result.outcome];
    note.textContent = `${label} · ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.answer && !result.firstCorrect ? ` · 首次输入：${result.answer}` : ''}`;
    item.append(title, note);
    $('resultList').append(item);
  }
  if (!items.length) {
    const paragraph = document.createElement('p');
    paragraph.className = 'field-note';
    paragraph.textContent = '暂无待巩固项';
    $('resultList').append(paragraph);
  }
  $('reviewWeakBtn').textContent = '进入错题巩固';
  $('reviewWeakBtn').hidden = !availableUnits(state, { ...summary.settings, strategy: 'mistakes' }).length;
}

function submit() {
  const question = state.session?.current;
  if (route !== 'quiz' || !question) return;
  if (question.phase === 'feedback') {
    if (!nextQuestion(state)) { completeSession(); return; }
    if (persist()) renderQuiz();
    return;
  }
  const judgement = judgeAnswer(getUnit(question.unitKey), question.input);
  if (!judgement.valid) {
    $('feedback').className = 'feedback hint';
    $('feedback').textContent = '请输入正数';
    return;
  }
  tick();
  if (!question.firstAnswer) question.firstAnswer = question.input;
  if (judgement.correct) {
    recordAnswer(state, 'correct');
    timerStarted = null;
    if (persist()) renderQuiz();
  } else {
    question.wrongAttempts++;
    question.input = '';
    if (persist()) renderQuiz();
  }
}

function keyInput(key) {
  if (key === 'enter') { submit(); return; }
  const question = state.session?.current;
  if (route !== 'quiz' || question?.phase !== 'answering') return;
  if (key === 'clear') question.input = '';
  else if (key === 'backspace') question.input = question.input.slice(0, -1);
  else if (key === 'decimal') {
    if (!question.input.includes('.') && question.input.length < 11) question.input += question.input ? '.' : '0.';
  } else if (/^\d$/.test(key) && question.input.length < 12) question.input += key;
  else return;
  tick();
  if (persist()) {
    $('answer').value = question.input;
    $('answer').focus({ preventScroll: true });
  }
}

$('keypad').addEventListener('click', event => {
  const button = event.target.closest('button[data-key]');
  if (button && !button.disabled) keyInput(button.dataset.key);
});
document.addEventListener('keydown', event => {
  if (route !== 'quiz' || document.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const target = event.target;
  if (target.matches('button, a, select') && ['Enter', ' '].includes(event.key)) return;
  const keys = { Enter: 'enter', Backspace: 'backspace', Delete: 'clear', Escape: 'clear', '.': 'decimal', ',': 'decimal' };
  const key = keys[event.key] || (/^\d$/.test(event.key) ? event.key : null);
  if (key) { event.preventDefault(); keyInput(key); }
});
$('hintBtn').addEventListener('click', () => {
  const question = state.session?.current;
  if (question?.phase !== 'answering') return;
  tick();
  question.helped = true;
  if (persist()) renderQuiz();
});
for (const [id, outcome] of [['revealBtn', 'reveal'], ['skipBtn', 'skip']]) {
  $(id).addEventListener('click', () => {
    tick();
    if (!recordAnswer(state, outcome)) return;
    timerStarted = null;
    if (persist()) renderQuiz();
  });
}
$('startBtn').addEventListener('click', begin);
$('pauseBtn').addEventListener('click', () => { tick(); timerStarted = null; if (persist()) showView('home'); });
$('endBtn').addEventListener('click', completeSession);
$('homeBtn').addEventListener('click', () => showView('home'));
$('againBtn').addEventListener('click', () => {
  if (lastSummary) state.settings = { ...lastSummary.settings, dailyGoal: state.settings.dailyGoal };
  begin();
});
$('reviewWeakBtn').addEventListener('click', () => {
  state.settings = { ...lastSummary.settings, dailyGoal: state.settings.dailyGoal, strategy: 'mistakes' };
  begin();
});
$('settingsForm').addEventListener('submit', event => event.preventDefault());
$('settingsForm').addEventListener('change', () => {
  if (state.session) return;
  state.settings = { ...state.settings, strategy: $('strategy').value, direction: $('direction').value,
    length: Number($('roundLength').value), targetSeconds: Number($('pace').value) };
  if (persist()) renderHome();
});
$('dailyGoal').addEventListener('change', () => {
  state.settings.dailyGoal = Number($('dailyGoal').value);
  if (persist() && route === 'home') renderHome();
});

function syncDialogState() {
  const open = Boolean(document.querySelector('dialog[open]'));
  $('dialogBackdrop').hidden = !open;
  document.querySelector('.app').inert = open;
  document.body.classList.toggle('dialog-open', open);
  document.querySelectorAll('dialog').forEach(dialog => { dialog.hidden = !dialog.open; });
  resumeTimer();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  syncDialogState();
  const opener = dialogOpeners.get(dialog);
  dialogOpeners.delete(dialog);
  if (!document.querySelector('dialog[open]') && opener?.isConnected && !opener.closest('[hidden], [inert]')) {
    opener.focus({ preventScroll: true });
  }
}

function openDialog(id) {
  if (document.querySelector('dialog[open]')) return;
  tick();
  timerStarted = null;
  if (!persist()) return;
  const dialog = $(id);
  dialogOpeners.set(dialog, document.activeElement);
  dialog.hidden = false;
  // Manage the backdrop and inert state explicitly. Closing releases page input
  // synchronously without depending on native modal top-layer cleanup on mobile.
  dialog.show();
  syncDialogState();
  dialog.querySelector('[data-close]').focus({ preventScroll: true });
}

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => closeDialog($(button.dataset.close)));
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => { if (!dialog.open) closeDialog(dialog); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog); });
});
$('dialogBackdrop').addEventListener('click', () => {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) closeDialog(dialog);
});
document.addEventListener('keydown', event => {
  const dialog = document.querySelector('dialog[open]');
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(dialog);
  } else if (event.key === 'Tab') {
    const controls = [...dialog.querySelectorAll('button, a[href], input, select, [tabindex]')]
      .filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
    const target = event.shiftKey ? controls.at(-1) : controls[0];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (!dialog.contains(document.activeElement) || document.activeElement === edge) {
      event.preventDefault();
      target?.focus();
    }
  }
});
// Preserve repeated key clicks while cancelling the browser's double-click action.
document.addEventListener('dblclick', event => event.preventDefault());

$('referenceBtn').addEventListener('click', () => {
  if (state.session?.current?.phase === 'answering') state.session.current.helped = true;
  $('referenceBody').replaceChildren();
  for (const pair of [...PAIRS].sort((a, b) => Number(a.denominator) - Number(b.denominator))) {
    const row = document.createElement('tr');
    const skills = ['percent', 'fraction'].map(direction => state.skills[`${pair.id}:${direction}`]);
    const mastered = skills.filter(skill => skill.level >= 3).length;
    const status = mastered === 2 ? '双向已掌握' : mastered === 1 ? '单向已掌握' : skills.some(skill => skill.lapses && skill.level < 2) ? '需要巩固' : skills.some(skill => skill.attempts) ? '练习中' : '尚未练习';
    for (const value of [`${pair.percent}%`, `1 / ${pair.denominator}`, status]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    $('referenceBody').append(row);
  }
  openDialog('referenceDialog');
});

function renderHistory() {
  const info = overview(state);
  $('lifetimeStats').textContent = `累计 ${info.total} 题 · 首答正确率 ${info.total ? `${info.accuracy}%` : '—'} · ${info.weak} 个待巩固方向`;
  $('dailyGoal').value = state.settings.dailyGoal;
  $('historyList').replaceChildren();
  for (const summary of [...state.history].reverse()) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const description = document.createElement('div');
    const title = document.createElement('strong');
    const date = new Date(summary.finishedAt);
    title.textContent = `${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${strategyNames[summary.settings.strategy]}`;
    const stats = resultStats(summary.results);
    const note = document.createElement('span');
    note.textContent = `${directionNames[summary.settings.direction]} · ${stats.total} 题 · ${stats.avgSeconds.toFixed(1)} 秒/题${summary.partial ? ' · 提前结束' : ''}`;
    const score = document.createElement('div');
    score.className = 'history-score';
    score.textContent = `${stats.accuracy}%`;
    description.append(title, note);
    item.append(description, score);
    $('historyList').append(item);
  }
  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'field-note';
    empty.textContent = '暂无训练记录';
    $('historyList').append(empty);
  }
}
$('historyBtn').addEventListener('click', () => {
  renderHistory();
  openDialog('historyDialog');
});
$('exportBtn').addEventListener('click', () => {
  tick();
  if (!persist()) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `百化分备份-${dayKey()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('importStatus').textContent = '已生成备份文件，请确认浏览器已保存下载。';
});
$('importFile').addEventListener('change', async event => {
  pendingImport = null;
  $('confirmImportBtn').hidden = true;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('备份文件超过 1 MB，请选择百化分导出的 JSON 文件');
    const restored = restoreState(await file.text());
    pendingImport = restored;
    const info = overview(restored);
    $('importStatus').textContent = `备份包含 ${info.total} 道已完成题目、${restored.history.length} 轮记录${restored.session ? '和一轮未完成训练' : ''}。确认后会替换本地记录。`;
    $('confirmImportBtn').hidden = false;
  } catch (error) {
    $('importStatus').textContent = `无法恢复：${error.message}。当前记录保持不变。`;
  }
  event.target.value = '';
});
$('confirmImportBtn').addEventListener('click', () => {
  if (!pendingImport) return;
  state = pendingImport;
  pendingImport = null;
  timerStarted = null;
  if (!persist()) return;
  $('confirmImportBtn').hidden = true;
  closeDialog($('historyDialog'));
  showView('home');
  notice('备份已恢复，可以继续练习。');
});

document.addEventListener('visibilitychange', () => {
  tick();
  timerStarted = null;
  if (!persist()) return;
  resumeTimer();
  if (!document.hidden && route === 'home') renderHome();
});
window.addEventListener('pagehide', () => { tick(); timerStarted = null; persist(); });
setInterval(() => {
  if (route !== 'quiz' || timerStarted === null) return;
  tick();
  $('timer').textContent = `${(state.session.current.elapsedMs / 1000).toFixed(1)}s`;
}, 250);
// Persist the timer periodically as mobile browsers may kill a background page.
setInterval(() => { if (timerStarted !== null) { tick(); persist(); } }, 5000);

function connectionStatus() {
  $('connectionStatus').textContent = !navigator.onLine ? offlineReady ? '离线模式' : '离线资源未就绪' :
    offlineReady ? '离线可用' : '准备离线资源…';
}
window.addEventListener('online', connectionStatus);
window.addEventListener('offline', connectionStatus);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('installBtn').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('installBtn').hidden = true; });
$('installHelpBtn').addEventListener('click', () => openDialog('installDialog'));
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  tick();
  timerStarted = null;
  if (!persist()) return;
  const prompt = installPrompt;
  installPrompt = null;
  $('installBtn').hidden = true;
  try { await prompt.prompt(); await prompt.userChoice; }
  finally { resumeTimer(); }
});

function showUpdate() { $('updateBanner').hidden = !registration?.waiting; }
$('updateBtn').addEventListener('click', () => {
  tick();
  timerStarted = null;
  if (!persist()) return;
  if (!registration?.waiting) { location.reload(); return; }
  updateRequested = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
    else { offlineReady = true; connectionStatus(); showUpdate(); }
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(async worker => {
    registration = worker;
    showUpdate();
    worker.addEventListener('updatefound', () => {
      const installing = worker.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') showUpdate();
        if (installing.state === 'activated') { offlineReady = true; connectionStatus(); showUpdate(); }
      });
    });
    await navigator.serviceWorker.ready;
    const cached = await caches.match(new URL('./training.js', location.href).href);
    offlineReady = Boolean(cached);
    connectionStatus();
  }).catch(() => {
    $('connectionStatus').textContent = '离线资源准备失败';
  });
} else $('connectionStatus').textContent = '在线模式';

syncDialogState();
showView('home');
