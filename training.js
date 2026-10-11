// Keep the original mnemonic table. Both directions have independent records.
const table = [
  ['5.3', '19'], ['7.7', '13'], ['12', '8.3'], ['16', '6.25'], ['24', '4.2'],
  ['5.6', '18'], ['8.3', '12'], ['12.5', '8'], ['16.7', '6'], ['27', '3.7'],
  ['5.9', '17'], ['9.1', '11'], ['13', '7.7'], ['17', '5.9'], ['28.6', '3.5'],
  ['6.25', '16'], ['9.5', '10.5'], ['14', '7.1'], ['18', '5.6'], ['37', '2.7'],
  ['6.7', '15'], ['10.5', '9.5'], ['14.3', '7'], ['19', '5.3'], ['42', '2.4'],
  ['7.1', '14'], ['11.1', '9'], ['15', '6.7'], ['22.2', '4.5'], ['67', '1.5'],
];
const familiar = new Set([6, 8, 12, 16]);
export const PAIRS = table.map(([percent, denominator], index) => Object.freeze({
  id: `p${index + 1}`, percent, denominator,
  difficulty: familiar.has(Number(denominator)) ? 1 : Number.isInteger(Number(denominator)) ? 2 : 3,
}));
export const UNITS = PAIRS.flatMap(pair => ['percent', 'fraction'].map(direction =>
  Object.freeze({ key: `${pair.id}:${direction}`, pair, direction })));
const unitMap = new Map(UNITS.map(unit => [unit.key, unit]));
export const STORAGE_KEY = 'baihuafen-state-v2';
export const DAY = 86400000;
const intervals = [0, 1, 3, 7, 14, 30, 60];
const defaults = { strategy: 'adaptive', direction: 'mixed', length: 20, targetSeconds: 8, dailyGoal: 30 };
const bounded = (value, max = 1e9) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
const count = (value, max) => Math.floor(bounded(value, max));
const text = (value, max = 50) => typeof value === 'string' ? value.slice(0, max) : '';
export const getUnit = key => unitMap.get(key);
export const dayKey = (now = Date.now()) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function newSkill() {
  return { attempts: 0, correct: 0, streak: 0, lapses: 0, level: 0, dueAt: 0,
    avgMs: 0, lastAt: 0, lastSerial: 0, lastPromotedDay: '' };
}

export function createState() {
  return { version: 2, settings: { ...defaults }, skills: Object.fromEntries(UNITS.map(unit => [unit.key, newSkill()])),
    serial: 0, recentPairs: [], daily: {}, history: [], session: null };
}

export function normalizeSettings(settings = {}) {
  return {
    strategy: ['adaptive', 'shuffle', 'mistakes'].includes(settings.strategy) ? settings.strategy : defaults.strategy,
    direction: ['mixed', 'percent', 'fraction'].includes(settings.direction) ? settings.direction : defaults.direction,
    length: [10, 20, 30].includes(settings.length) ? settings.length : defaults.length,
    targetSeconds: [5, 8, 15].includes(settings.targetSeconds) ? settings.targetSeconds : defaults.targetSeconds,
    dailyGoal: [10, 20, 30, 50].includes(settings.dailyGoal) ? settings.dailyGoal : defaults.dailyGoal,
  };
}

function normalizeResult(result) {
  if (!result || !getUnit(result.unitKey)) throw new Error('训练记录中有未知题目');
  return { unitKey: result.unitKey, firstCorrect: result.firstCorrect === true, correct: result.correct === true,
    assisted: result.assisted === true, elapsedMs: bounded(result.elapsedMs, 3600000),
    answer: text(result.answer), outcome: ['correct', 'retry', 'hint', 'reveal', 'skip'].includes(result.outcome) ? result.outcome : 'skip',
    at: bounded(result.at, 1e15) };
}

// Imported and persisted data go through the same whitelist; never render raw JSON.
export function restoreState(raw) {
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || source.version !== 2 || !source.skills || typeof source.skills !== 'object') {
    throw new Error('不是有效的百化分 v2 备份');
  }
  const state = createState();
  state.settings = normalizeSettings(source.settings);
  state.serial = count(source.serial);
  for (const unit of UNITS) {
    const skill = source.skills[unit.key];
    if (!skill || typeof skill !== 'object') continue;
    const record = state.skills[unit.key];
    for (const key of ['attempts', 'correct', 'streak', 'lapses', 'lastSerial']) record[key] = count(skill[key]);
    record.correct = Math.min(record.correct, record.attempts);
    record.level = count(skill.level, 6);
    record.avgMs = bounded(skill.avgMs, 3600000);
    record.lastAt = bounded(skill.lastAt, 1e15);
    record.dueAt = bounded(skill.dueAt, 1e15);
    record.lastPromotedDay = /^\d{4}-\d{2}-\d{2}$/.test(skill.lastPromotedDay) ? skill.lastPromotedDay : '';
  }
  const pairIds = new Set(PAIRS.map(pair => pair.id));
  state.recentPairs = Array.isArray(source.recentPairs) ? source.recentPairs.filter(id => pairIds.has(id)).slice(-3) : [];
  if (source.daily && typeof source.daily === 'object') {
    for (const date of Object.keys(source.daily).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().slice(-90)) {
      const day = source.daily[date];
      if (day && typeof day === 'object') state.daily[date] = { total: count(day.total), correct: Math.min(count(day.correct), count(day.total)) };
    }
  }
  if (Array.isArray(source.history)) {
    state.history = source.history.slice(-30).map(item => {
      if (!item || !Array.isArray(item.results) || item.results.length > 30) throw new Error('训练历史格式错误');
      return { id: text(item.id), settings: normalizeSettings(item.settings), finishedAt: bounded(item.finishedAt, 1e15),
        partial: item.partial === true, results: item.results.map(normalizeResult) };
    });
  }
  if (source.session) {
    const session = source.session;
    if (!Array.isArray(session.results) || session.results.length > 30) throw new Error('未完成训练格式错误');
    const settings = normalizeSettings(session.settings);
    const results = session.results.map(normalizeResult);
    if (results.length > settings.length) throw new Error('训练题数超出范围');
    state.session = { id: text(session.id), settings, startedAt: bounded(session.startedAt, 1e15), results, current: null };
    if (session.current) {
      const current = session.current;
      if (!getUnit(current.unitKey) || !['answering', 'feedback'].includes(current.phase)) throw new Error('当前题目格式错误');
      if (current.phase === 'feedback' && results.at(-1)?.unitKey !== current.unitKey) throw new Error('当前题目与记录不一致');
      if (current.phase === 'answering' && results.length >= settings.length) throw new Error('训练已经完成');
      state.session.current = {
        unitKey: current.unitKey, phase: current.phase, input: text(current.input, 12),
        firstAnswer: text(current.firstAnswer), wrongAttempts: count(current.wrongAttempts, 999),
        helped: current.helped === true, elapsedMs: bounded(current.elapsedMs, 3600000), reason: text(current.reason),
      };
    }
  }
  return state;
}

export function availableUnits(state, settings = state.settings) {
  return UNITS.filter(unit => (settings.direction === 'mixed' || unit.direction === settings.direction) &&
    (settings.strategy !== 'mistakes' || isWeak(state.skills[unit.key])));
}

export const isWeak = skill => skill.lapses > 0 && skill.level < 2;
export const isDue = (skill, now = Date.now()) => skill.attempts > 0 && skill.dueAt <= now;

function randomPick(items, weights, rng) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let position = Math.max(0, Math.min(0.999999999, rng())) * total;
  for (let index = 0; index < items.length; index++) {
    position -= weights[index];
    if (position < 0) return items[index];
  }
  return items.at(-1);
}

export function selectQuestion(state, session, now = Date.now(), rng = Math.random) {
  let candidates = availableUnits(state, session.settings);
  if (!candidates.length) return null;
  const recent = new Set(state.recentPairs.slice(-3));
  const spaced = candidates.filter(unit => !recent.has(unit.pair.id));
  // A small mistake pool may need repeats, but never show the same pair twice in
  // succession if any other pair is available (including its reverse direction).
  candidates = spaced.length ? spaced : candidates.filter(unit => unit.pair.id !== state.recentPairs.at(-1));
  if (!candidates.length) candidates = availableUnits(state, session.settings);
  if (session.settings.strategy === 'shuffle') {
    const seen = new Set(session.results.map(result => result.unitKey));
    const unseen = candidates.filter(unit => !seen.has(unit.key));
    if (unseen.length) candidates = unseen;
  }
  if (session.settings.direction === 'mixed') {
    const balance = session.results.reduce((sum, result) => sum + (getUnit(result.unitKey).direction === 'percent' ? 1 : -1), 0);
    const balanced = candidates.filter(unit => unit.direction === (balance > 0 ? 'fraction' : 'percent'));
    if (Math.abs(balance) >= 2 && balanced.length) candidates = balanced;
  }
  let reason = session.settings.strategy === 'shuffle' ? '随机覆盖' : '能力匹配';
  if (session.settings.strategy !== 'shuffle') {
    const repairs = candidates.filter(unit => {
      const skill = state.skills[unit.key];
      return isWeak(skill) && state.serial - skill.lastSerial >= 3;
    });
    const due = candidates.filter(unit => isDue(state.skills[unit.key], now));
    const fresh = candidates.filter(unit => !state.skills[unit.key].attempts);
    if (repairs.length && state.serial % 3 === 0) { candidates = repairs; reason = '错题巩固'; }
    else if (due.length && state.serial % 3 === 1) { candidates = due; reason = '到期复习'; }
    else if (fresh.length && state.serial % 4 === 0) { candidates = fresh; reason = '拓展覆盖'; }
  }
  const recentResults = session.results.slice(-8);
  const rate = recentResults.length ? recentResults.filter(result => result.firstCorrect).length / recentResults.length : 0;
  const speed = recentResults.length ? recentResults.reduce((sum, result) => sum + result.elapsedMs, 0) / recentResults.length : Infinity;
  const target = rate >= 0.85 && speed <= session.settings.targetSeconds * 1000 ? 3 : rate >= 0.65 ? 2 : 1;
  const weights = candidates.map(unit => {
    if (session.settings.strategy === 'shuffle') return 1;
    const skill = state.skills[unit.key];
    let weight = !skill.attempts ? 5 : skill.level >= 3 ? 0.6 : 3;
    if (isWeak(skill)) weight += 7;
    if (isDue(skill, now)) weight += 6 + Math.min(4, (now - skill.dueAt) / DAY);
    if (skill.attempts) weight += 4 * (1 - skill.correct / skill.attempts);
    if (skill.avgMs > session.settings.targetSeconds * 1000) weight += 2;
    const seen = session.results.filter(result => result.unitKey === unit.key).length;
    return weight / (1 + Math.abs(unit.pair.difficulty - target) * 0.6) / (1 + seen * 1.5);
  });
  const chosen = randomPick(candidates, weights, rng);
  if (reason === '能力匹配') {
    const skill = state.skills[chosen.key];
    reason = isWeak(skill) ? '薄弱项练习' : isDue(skill, now) ? '到期复习' : !skill.attempts ? '新题探索' : '巩固记忆';
  }
  return { unitKey: chosen.key, phase: 'answering', input: '', firstAnswer: '', wrongAttempts: 0, helped: false, elapsedMs: 0, reason };
}

export function startSession(state, now = Date.now(), rng = Math.random) {
  if (state.session) return state.session;
  const settings = normalizeSettings(state.settings);
  const session = { id: `${now}-${Math.floor(rng() * 1e9)}`, settings, startedAt: now, results: [], current: null };
  session.current = selectQuestion(state, session, now, rng);
  if (!session.current) return null;
  state.session = session;
  return session;
}

export function answerDetails(unit) {
  const { percent, denominator } = unit.pair;
  const forward = unit.direction === 'percent';
  const exact = 100 / Number(forward ? percent : denominator);
  const rounded = Number(exact.toFixed(4)).toString();
  return { prompt: forward ? `${percent}%` : `1 / ${denominator}`,
    expected: forward ? denominator : percent,
    display: forward ? `1 / ${denominator}` : `${percent}%`,
    hint: forward ? '把百分数写成 p / 100，分母约为 100 ÷ p。' : '把分数乘以 100，百分数约为 100 ÷ 分母。',
    explanation: forward ? `100 ÷ ${percent} ≈ ${rounded}，常用速记为 1 / ${denominator}。` : `100 ÷ ${denominator} ≈ ${rounded}，常用速记为 ${percent}%。` };
}

export function judgeAnswer(unit, raw) {
  let value = String(raw).trim().replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 65296)).replace(/．/g, '.').replace(/％/g, '%').replace(/／/g, '/');
  if (unit.direction === 'percent') value = value.replace(/^1\s*\/\s*/, '');
  else value = value.replace(/%$/, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || !(Number(value) > 0)) return { valid: false, correct: false };
  const expected = answerDetails(unit).expected;
  const exact = 100 / Number(unit.direction === 'percent' ? unit.pair.percent : unit.pair.denominator);
  // Use the mathematical reciprocal as the tolerance center in both directions.
  // A 1% relative error accepts 66 / 66.7 / 67 for 1/1.5, but rejects 4 for 27%.
  // Extra decimal places must not change the result; mnemonic answers stay valid.
  const epsilon = Math.max(1, exact) * 1e-12;
  const correct = Math.abs(Number(value) - Number(expected)) <= epsilon ||
    Math.abs(Number(value) - exact) <= exact * 0.01 + epsilon;
  return { valid: true, correct };
}

export function recordAnswer(state, outcome, now = Date.now()) {
  const session = state.session;
  const question = session?.current;
  if (!question || question.phase !== 'answering') return null;
  const correct = outcome === 'correct';
  const firstCorrect = correct && question.wrongAttempts === 0 && !question.helped;
  const result = { unitKey: question.unitKey, firstCorrect, correct, assisted: question.helped,
    elapsedMs: question.elapsedMs, answer: question.firstAnswer || question.input,
    outcome: correct ? question.helped ? 'hint' : question.wrongAttempts ? 'retry' : 'correct' : outcome, at: now };
  const skill = state.skills[question.unitKey];
  skill.attempts++;
  skill.correct += Number(firstCorrect);
  skill.avgMs = skill.attempts === 1 ? result.elapsedMs : skill.avgMs * 0.7 + result.elapsedMs * 0.3;
  state.serial++;
  skill.lastSerial = state.serial;
  skill.lastAt = now;
  const fast = result.elapsedMs <= session.settings.targetSeconds * 1000;
  if (firstCorrect) {
    skill.streak++;
    // Repeating within a day cannot turn a freshly seen item into "mastered".
    if (fast && skill.lastPromotedDay !== dayKey(now)) {
      skill.level = Math.min(6, skill.level + 1);
      skill.lastPromotedDay = dayKey(now);
    }
    skill.dueAt = now + (fast ? intervals[Math.max(1, skill.level)] * DAY : 10 * 60000);
  } else {
    skill.streak = 0;
    skill.level = 0;
    skill.lapses++;
    skill.dueAt = now + 10 * 60000;
  }
  const pairId = getUnit(question.unitKey).pair.id;
  state.recentPairs = [...state.recentPairs, pairId].slice(-3);
  const date = dayKey(now);
  const daily = state.daily[date] ||= { total: 0, correct: 0 };
  daily.total++;
  daily.correct += Number(firstCorrect);
  for (const old of Object.keys(state.daily).sort().slice(0, -90)) delete state.daily[old];
  session.results.push(result);
  question.phase = 'feedback';
  return result;
}

export function nextQuestion(state, now = Date.now(), rng = Math.random) {
  const session = state.session;
  if (!session || session.current?.phase === 'answering') return false;
  session.current = session.results.length < session.settings.length ? selectQuestion(state, session, now, rng) : null;
  return Boolean(session.current);
}

export function finishSession(state, now = Date.now()) {
  const session = state.session;
  if (!session) return null;
  const summary = { id: session.id, settings: session.settings, finishedAt: now,
    partial: session.results.length < session.settings.length, results: session.results.slice() };
  if (summary.results.length) state.history = [...state.history, summary].slice(-30);
  state.session = null;
  return summary;
}

export function resultStats(results) {
  const total = results.length;
  const correct = results.filter(result => result.firstCorrect).length;
  return { total, correct, accuracy: total ? Math.round(correct / total * 100) : 0,
    avgSeconds: total ? results.reduce((sum, result) => sum + result.elapsedMs, 0) / total / 1000 : 0,
    weak: results.filter(result => !result.firstCorrect) };
}

export function overview(state, now = Date.now()) {
  const skills = Object.values(state.skills);
  const total = skills.reduce((sum, skill) => sum + skill.attempts, 0);
  const correct = skills.reduce((sum, skill) => sum + skill.correct, 0);
  let streak = 0;
  const date = new Date(now);
  if (!state.daily[dayKey(date.getTime())]?.total) date.setDate(date.getDate() - 1);
  for (let index = 0; index < 90 && state.daily[dayKey(date.getTime())]?.total; index++) {
    streak++;
    date.setDate(date.getDate() - 1);
  }
  return { total, accuracy: total ? Math.round(correct / total * 100) : 0,
    mastered: skills.filter(skill => skill.level >= 3).length,
    due: skills.filter(skill => isDue(skill, now)).length,
    weak: skills.filter(isWeak).length, streak, today: state.daily[dayKey(now)]?.total || 0 };
}
