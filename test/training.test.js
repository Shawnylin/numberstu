import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, PAIRS, UNITS, createState, restoreState, getUnit, judgeAnswer, startSession,
  selectQuestion, recordAnswer, nextQuestion, finishSession, overview, availableUnits,
} from '../training.js';

const NOW = new Date(2026, 9, 10, 12).getTime();
function seeded(seed = 1) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
function forceQuestion(state, key, now = NOW) {
  if (state.session) finishSession(state, now);
  startSession(state, now, seeded(7));
  state.session.current = { unitKey: key, phase: 'answering', input: '19', firstAnswer: '', wrongAttempts: 0,
    helped: false, elapsedMs: 3000, reason: '测试' };
}

test('all 30 original conversions accept their canonical answers in both directions', () => {
  assert.equal(PAIRS.length, 30);
  assert.equal(UNITS.length, 60);
  for (const unit of UNITS) {
    const expected = unit.direction === 'percent' ? unit.pair.denominator : unit.pair.percent;
    assert.deepEqual(judgeAnswer(unit, expected), { valid: true, correct: true });
  }
});

test('numeric equivalents and correctly rounded reciprocals are accepted without accepting coarse guesses', () => {
  const fraction = getUnit('p1:percent'); // 5.3% -> 1/19, exact 18.8679...
  for (const input of ['19.0', '019', '1 / 19', '１９', '18.9', '18.87']) assert.equal(judgeAnswer(fraction, input).correct, true, input);
  for (const input of ['18', '20', '19.1', '0', '-19', '.', '19.', '1/0', '1e1', '']) assert.equal(judgeAnswer(fraction, input).correct, false, input);
  assert.equal(judgeAnswer(getUnit('p10:percent'), '4').correct, false);
  assert.equal(judgeAnswer(getUnit('p30:fraction'), '66.7%').correct, true);
  assert.equal(judgeAnswer(getUnit('p30:fraction'), '66').correct, false);
  assert.equal(judgeAnswer(getUnit('p4:percent'), '6.3').correct, false); // table expects 6.25
});

test('random coverage visits every selected-direction item exactly once in a 30-question round', () => {
  for (const direction of ['percent', 'fraction']) {
    for (let seed = 1; seed <= 50; seed++) {
      const state = createState();
      state.settings = { ...state.settings, strategy: 'shuffle', direction, length: 30 };
      const rng = seeded(seed);
      startSession(state, NOW, rng);
      const seen = [];
      do {
        const key = state.session.current.unitKey;
        assert.equal(getUnit(key).direction, direction);
        seen.push(key);
        recordAnswer(state, 'correct', NOW);
      } while (nextQuestion(state, NOW, rng));
      assert.equal(new Set(seen).size, 30);
      assert.notDeepEqual(seen, UNITS.filter(unit => unit.direction === direction).map(unit => unit.key));
    }
  }
});

test('adaptive rounds avoid the last three pairs, balance directions, and vary across seeds', () => {
  const sequences = new Set();
  for (let seed = 1; seed <= 50; seed++) {
    const state = createState();
    state.settings.length = 30;
    const rng = seeded(seed);
    startSession(state, NOW, rng);
    const pairs = [];
    const keys = [];
    let balance = 0;
    do {
      const unit = getUnit(state.session.current.unitKey);
      assert.ok(!pairs.slice(-3).includes(unit.pair.id));
      balance += unit.direction === 'percent' ? 1 : -1;
      assert.ok(Math.abs(balance) <= 2);
      pairs.push(unit.pair.id);
      keys.push(unit.key);
      state.session.current.elapsedMs = 2500;
      recordAnswer(state, 'correct', NOW);
    } while (nextQuestion(state, NOW, rng));
    sequences.add(keys.join(','));
    assert.ok(Math.abs(balance) <= 2);
  }
  assert.equal(sequences.size, 50);
});

test('due reviews and delayed mistake repairs receive priority, but fresh topics still get coverage', () => {
  const state = createState();
  for (const skill of Object.values(state.skills)) Object.assign(skill, { attempts: 10, correct: 10, level: 4, dueAt: NOW + DAY });
  const weakKey = 'p1:percent';
  Object.assign(state.skills[weakKey], { lapses: 2, correct: 4, level: 0, lastSerial: 1, dueAt: NOW + 600000 });
  state.serial = 6;
  const session = { settings: state.settings, results: [] };
  assert.equal(selectQuestion(state, session, NOW, seeded(8)).unitKey, weakKey);
  state.serial = 7;
  const dueKey = 'p2:fraction';
  state.skills[dueKey].dueAt = NOW - DAY;
  assert.equal(selectQuestion(state, session, NOW, seeded(8)).unitKey, dueKey);
  state.serial = 8;
  const newKey = 'p3:percent';
  state.skills[newKey].attempts = 0;
  assert.equal(selectQuestion(state, session, NOW, seeded(8)).unitKey, newKey);
  state.recentPairs = ['p1'];
  state.serial = 9;
  assert.notEqual(selectQuestion(state, session, NOW, seeded(8)).unitKey, weakKey);
});

test('sustained accurate and fast answers shift selection toward harder conversions', () => {
  const state = createState();
  const session = { settings: state.settings, results: [] };
  const sample = successful => {
    session.results = Array.from({ length: 8 }, () => ({ unitKey: 'p1:percent', firstCorrect: successful, elapsedMs: successful ? 2500 : 18000 }));
    const rng = seeded(912);
    let total = 0;
    for (let index = 0; index < 2000; index++) total += getUnit(selectQuestion(state, session, NOW, rng).unitKey).pair.difficulty;
    return total / 2000;
  };
  assert.ok(sample(true) > sample(false) + 0.2);
});

test('weak directions are selected more frequently than mastered directions', () => {
  const state = createState();
  for (const skill of Object.values(state.skills)) Object.assign(skill, { attempts: 10, correct: 10, level: 3, dueAt: NOW + DAY });
  Object.assign(state.skills['p1:percent'], { lapses: 4, level: 0, correct: 2 });
  state.serial = 2; // Weighted sampling rather than a forced review turn.
  const session = { settings: state.settings, results: [] };
  const rng = seeded(193);
  let weak = 0;
  let samePairMastered = 0;
  for (let index = 0; index < 2000; index++) {
    const key = selectQuestion(state, session, NOW, rng).unitKey;
    weak += Number(key === 'p1:percent');
    samePairMastered += Number(key === 'p1:fraction');
  }
  assert.ok(weak > samePairMastered * 5);
});

test('mistake mode has a safe empty state and never introduces unrelated questions', () => {
  const state = createState();
  state.settings.strategy = 'mistakes';
  assert.equal(startSession(state, NOW, seeded()), null);
  state.skills['p1:percent'].lapses = 1;
  state.skills['p2:fraction'].lapses = 1;
  startSession(state, NOW, seeded());
  for (let index = 0; index < 10; index++) {
    const key = state.session.current.unitKey;
    assert.ok(['p1:percent', 'p2:fraction'].includes(key));
    const prior = getUnit(key).pair.id;
    recordAnswer(state, 'skip', NOW);
    if (!nextQuestion(state, NOW, seeded(index + 1))) break;
    assert.notEqual(getUnit(state.session.current.unitKey).pair.id, prior);
  }
  state.settings.direction = 'fraction';
  assert.deepEqual(availableUnits(state).map(unit => unit.key), ['p2:fraction']);
});

test('duplicate submission and reloading feedback cannot inflate scores or repeat a record', () => {
  let state = createState();
  forceQuestion(state, 'p1:percent');
  recordAnswer(state, 'correct', NOW);
  assert.equal(recordAnswer(state, 'correct', NOW), null);
  state = restoreState(JSON.stringify(state));
  assert.equal(state.session.current.phase, 'feedback');
  assert.equal(recordAnswer(state, 'correct', NOW), null);
  assert.equal(state.skills['p1:percent'].attempts, 1);
  assert.equal(overview(state, NOW).total, 1);
});

test('retries, hints, reveals and skips each create one lapse and never count as independent first answers', () => {
  for (const kind of ['retry', 'hint', 'reveal', 'skip']) {
    const state = createState();
    forceQuestion(state, 'p1:percent');
    if (kind === 'retry') state.session.current.wrongAttempts = 2;
    if (kind === 'hint') state.session.current.helped = true;
    const result = recordAnswer(state, ['retry', 'hint'].includes(kind) ? 'correct' : kind, NOW);
    assert.equal(result.firstCorrect, false);
    assert.equal(state.skills['p1:percent'].attempts, 1);
    assert.equal(state.skills['p1:percent'].correct, 0);
    assert.equal(state.skills['p1:percent'].level, 0);
    assert.equal(state.skills['p1:percent'].lapses, 1);
    assert.equal(state.skills['p1:percent'].dueAt, NOW + 600000);
    assert.equal(state.skills['p1:fraction'].attempts, 0);
  }
});

test('mastery requires separate days, increases review intervals, and drops after a lapse', () => {
  const state = createState();
  for (let index = 0; index < 5; index++) {
    forceQuestion(state, 'p1:percent');
    recordAnswer(state, 'correct', NOW);
  }
  assert.equal(state.skills['p1:percent'].level, 1);
  assert.equal(state.skills['p1:percent'].dueAt, NOW + DAY);
  for (let day = 1; day <= 2; day++) {
    forceQuestion(state, 'p1:percent', NOW + DAY * day);
    recordAnswer(state, 'correct', NOW + DAY * day);
  }
  assert.equal(state.skills['p1:percent'].level, 3);
  assert.equal(state.skills['p1:percent'].dueAt, NOW + DAY * 9);
  assert.equal(overview(state, NOW + DAY * 2).mastered, 1);
  forceQuestion(state, 'p1:percent', NOW + DAY * 9);
  recordAnswer(state, 'skip', NOW + DAY * 9);
  assert.equal(state.skills['p1:percent'].level, 0);
  assert.equal(overview(state, NOW + DAY * 9).mastered, 0);
});

test('slow independent answers stay correct but do not prematurely advance mastery', () => {
  const state = createState();
  forceQuestion(state, 'p1:percent');
  state.session.current.elapsedMs = 20000;
  recordAnswer(state, 'correct', NOW);
  assert.equal(state.skills['p1:percent'].correct, 1);
  assert.equal(state.skills['p1:percent'].level, 0);
  assert.equal(state.skills['p1:percent'].dueAt, NOW + 600000);
});

test('unknown items are not overdue; history is bounded and finishing twice is harmless', () => {
  const state = createState();
  assert.equal(overview(state, NOW).due, 0);
  for (let index = 0; index < 35; index++) {
    forceQuestion(state, 'p1:percent');
    recordAnswer(state, 'correct', NOW);
    finishSession(state, NOW);
  }
  assert.equal(state.history.length, 30);
  assert.equal(finishSession(state, NOW), null);
  assert.equal(overview(state, NOW).total, 35);
  assert.equal(overview(state, NOW).today, 35);
  assert.equal(overview(state, NOW).streak, 1);
});

test('backup restores a partially answered question, sanitizes values, and rejects corrupt sessions', () => {
  const state = createState();
  forceQuestion(state, 'p1:percent');
  state.session.current.input = '18.';
  state.session.current.wrongAttempts = 1;
  state.skills['p1:percent'].correct = 99;
  const restored = restoreState(JSON.stringify(state));
  assert.equal(restored.session.current.input, '18.');
  assert.equal(restored.session.current.wrongAttempts, 1);
  assert.equal(restored.skills['p1:percent'].correct, 0);
  assert.throws(() => restoreState('{broken'));
  assert.throws(() => restoreState({ version: 1 }));
  assert.throws(() => restoreState({ ...state, session: { ...state.session, current: { ...state.session.current, unitKey: 'unknown' } } }));
  assert.throws(() => restoreState({ ...state, session: { ...state.session, current: { ...state.session.current, phase: 'feedback' } } }));
});
