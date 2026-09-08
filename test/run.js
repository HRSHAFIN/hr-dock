'use strict';
/**
 * HR Dock test suite:  npm test
 *
 * Covers the parts where a silent mistake would be expensive and invisible —
 * calendar maths, recurrence expansion, recurring-task rollover, and the
 * reminder engine's fire/suppress/snooze decisions.
 */
const harness = require('./harness.js');

harness.stubElectron();

const DT = require('../src/shared/datetime.js');
const { ReminderEngine } = require('../src/main/reminders.js');
const { suite, report } = harness;


/**
 * A point `mins` from now, as a { date, time } pair.
 * Returning the day key alongside the clock time matters: a fixture built at
 * 23:55 with "+8 minutes" belongs to tomorrow, and pinning it to today would
 * put it ~24 hours in the past and silently invert the test.
 */
function offset(mins) {
  const d = new Date(Date.now() + mins * 60000);
  return { date: DT.key(d), time: `${DT.pad(d.getHours())}:${DT.pad(d.getMinutes())}` };
}

// --------------------------------------------------------------- date maths

suite('date & time formatting', t => {
  t.equal('24-hour formatting', DT.formatTime('13:05', 24), '13:05');
  t.equal('12-hour formatting', DT.formatTime('13:05', 12), '1:05 PM');
  t.equal('midnight in 12-hour form', DT.formatTime('00:00', 12), '12:00 AM');
  t.equal('noon in 12-hour form', DT.formatTime('12:00', 12), '12:00 PM');
  t.equal('malformed time yields nothing', DT.formatTime('25:99', 24), '');
  t.equal('minutes round-trip', DT.fromMinutes(DT.toMinutes('07:45')), '07:45');
  t.equal('day difference', DT.diffDays('2026-09-07', '2026-09-14'), 7);
  t.equal('difference across a month', DT.diffDays('2026-01-31', '2026-02-01'), 1);
  t.equal('leap day is a real day', DT.diffDays('2028-02-28', '2028-03-01'), 2);
  t.equal('month grid is six weeks', DT.monthGrid(new Date(2026, 8, 7), 1).length, 42);
  t.equal('week starts on the chosen day',
    DT.key(DT.startOfWeek(DT.fromKey('2026-09-11'), 1)), '2026-09-07');
  t.equal('week can start on Sunday',
    DT.key(DT.startOfWeek(DT.fromKey('2026-09-11'), 0)), '2026-09-06');
});

// -------------------------------------------------------------- recurrence

suite('recurrence expansion', t => {
  const weekly = { date: '2026-09-01', recurrence: 'weekly', interval: 1, weekdays: [1, 3] };
  t.equal('weekly on chosen weekdays',
    DT.occurrencesBetween(weekly, '2026-09-01', '2026-09-14').join(','),
    '2026-09-02,2026-09-07,2026-09-09,2026-09-14');

  const biweekly = { date: '2026-09-02', recurrence: 'weekly', interval: 2, weekdays: [3] };
  t.equal('fortnightly skips the in-between week',
    DT.occurrencesBetween(biweekly, '2026-09-01', '2026-10-01').join(','),
    '2026-09-02,2026-09-16,2026-09-30');

  const monthEnd = { date: '2026-01-31', recurrence: 'monthly', interval: 1 };
  t.equal('a 31st anchor clamps to shorter months',
    DT.occurrencesBetween(monthEnd, '2026-01-01', '2026-04-30').join(','),
    '2026-01-31,2026-02-28,2026-03-31,2026-04-30');

  const weekdays = { date: '2026-09-07', recurrence: 'weekdays' };
  t.equal('weekdays rule skips the weekend',
    DT.occurrencesBetween(weekdays, '2026-09-11', '2026-09-14').join(','),
    '2026-09-11,2026-09-14');

  const birthday = { date: '1996-09-09', recurrence: 'yearly', interval: 1 };
  t.equal('yearly anniversary', DT.nextOccurrence(birthday, '2026-09-07'), '2026-09-09');

  const bounded = { date: '2026-09-01', recurrence: 'daily', interval: 1, until: '2026-09-03' };
  t.equal('an end date stops the series',
    DT.occurrencesBetween(bounded, '2026-09-01', '2026-09-10').join(','),
    '2026-09-01,2026-09-02,2026-09-03');

  const skipped = { date: '2026-09-01', recurrence: 'daily', interval: 1, exceptions: ['2026-09-02'] };
  t.equal('a skipped occurrence disappears',
    DT.occurrencesBetween(skipped, '2026-09-01', '2026-09-03').join(','),
    '2026-09-01,2026-09-03');

  const single = { date: '2026-09-07', recurrence: 'none' };
  t.check('a one-off happens exactly once',
    DT.occurrencesBetween(single, '2026-09-01', '2026-09-30').length === 1);
});

// ------------------------------------------------- recurring task rollover

suite('recurring task rollover', t => {
  // Mirrors State.Todos.toggle: the series stays anchored to the original due
  // date, and only the search start moves forward.
  const nextDue = todo => DT.nextOccurrence(
    { date: todo.due, recurrence: todo.recurrence, interval: todo.interval || 1, weekdays: todo.weekdays },
    DT.key(DT.addDays(DT.fromKey(todo.due), 1)));

  t.equal('daily rolls to tomorrow', nextDue({ due: '2026-09-07', recurrence: 'daily' }), '2026-09-08');
  t.equal('weekly rolls a full week', nextDue({ due: '2026-09-07', recurrence: 'weekly' }), '2026-09-14');
  t.equal('Friday weekday task rolls to Monday', nextDue({ due: '2026-09-11', recurrence: 'weekdays' }), '2026-09-14');
  t.equal('monthly rolls a month', nextDue({ due: '2026-09-07', recurrence: 'monthly' }), '2026-10-07');
  t.equal('yearly rolls a year', nextDue({ due: '2026-09-07', recurrence: 'yearly' }), '2027-09-07');
  t.equal('fortnightly rolls two weeks',
    nextDue({ due: '2026-09-07', recurrence: 'weekly', interval: 2 }), '2026-09-21');
});

// ------------------------------------------------------- reminder engine

function makeStore(extra) {
  return {
    data: Object.assign({
      settings: {
        timeFormat: 24,
        notifications: { enabled: true, defaultLeadMinutes: 10, snoozeMinutes: 10 }
      },
      events: [],
      routines: [],
      todos: [],
      reminderState: { fired: {}, snoozed: [] }
    }, extra),
    save() {}
  };
}

function engineWith(extra) {
  const fired = [];
  const store = makeStore(extra);
  const engine = new ReminderEngine(store, { onFire: r => fired.push(r) });
  return { store, engine, fired };
}

suite('reminder engine', t => {
  {
    const at = offset(10);
    const { engine, fired } = engineWith({
      events: [{ id: 'e1', title: 'Standup', date: at.date, time: at.time, remind: 10, recurrence: 'none' }]
    });
    engine.tick();
    t.check('fires when the lead time is reached', fired.length === 1 && fired[0].title === 'Standup');
    engine.tick();
    t.check('never fires the same reminder twice', fired.length === 1);
  }

  {
    const at = offset(-6 * 60);          // six hours ago, well beyond the grace window
    const { store, engine, fired } = engineWith({
      events: [{ id: 'e2', title: 'Hours ago', date: at.date, time: at.time, remind: 0, recurrence: 'none' }]
    });
    engine.tick();
    t.check('a long-missed reminder stays silent', fired.length === 0);
    t.check('the missed reminder is still retired', Object.keys(store.data.reminderState.fired).length === 1);
  }

  {
    const due = offset(-1);
    const { engine, fired } = engineWith({
      todos: [{ id: 't1', title: 'Submit form', due: due.date, dueTime: due.time, remind: 0, done: false }]
    });
    engine.tick();
    t.check('a task reminder of 0 means "at the due time"', fired.length === 1 && fired[0].kind === 'todo');
  }

  {
    const due = offset(-1);
    const { engine, fired } = engineWith({
      todos: [{ id: 't2', title: 'Already done', due: due.date, dueTime: due.time, remind: 0, done: true }]
    });
    engine.tick();
    t.check('a completed task never nags', fired.length === 0);
  }

  {
    const at = offset(8);
    const { store, engine, fired } = engineWith({
      events: [{ id: 'e3', title: 'Call', date: at.date, time: at.time, remind: 10, recurrence: 'none' }]
    });
    engine.tick();
    t.check('event fires once', fired.length === 1);
    engine.snooze(fired[0], 5);
    t.check('snooze queues the reminder', store.data.reminderState.snoozed.length === 1);
    engine.tick();
    t.check('a snoozed reminder stays quiet', fired.length === 1);
    store.data.reminderState.snoozed[0].fireAt = Date.now() - 1000;
    engine.tick();
    t.check('a snoozed reminder returns when due', fired.length === 2);
  }

  {
    const at = offset(2);
    const born = DT.fromKey(at.date);     // the anniversary must match the firing day
    const { engine, fired } = engineWith({
      events: [{
        id: 'e4', title: 'Sofia', category: 'birthday',
        date: `1990-${DT.pad(born.getMonth() + 1)}-${DT.pad(born.getDate())}`,
        time: at.time, remind: 5, recurrence: 'yearly', interval: 1
      }]
    });
    engine.tick();
    t.check('a birthday fires on the anniversary', fired.length === 1 && fired[0].kind === 'birthday');
    t.check('the birthday says how old they are', fired.length === 1 && /Turns \d+ today/.test(fired[0].body));
  }

  {
    const at = offset(1);
    const weekday = DT.fromKey(at.date).getDay();
    const { engine, fired } = engineWith({
      routines: [{
        id: 'r1', name: 'Morning', active: true, remind: 5, days: [weekday],
        steps: [{ id: 's1', title: 'Stretch', time: at.time }], completed: {}
      }]
    });
    engine.tick();
    t.check('a routine step fires its own reminder',
      fired.length === 1 && fired[0].kind === 'routine' && fired[0].title === 'Stretch');
    t.check('the routine reminder names its routine',
      fired.length === 1 && fired[0].body.indexOf('Morning') === 0, fired[0] && fired[0].body);
  }

  {
    // Accountability: a step still untouched a while after its time gets one
    // follow-up, and only one.
    const at = offset(-11);
    const weekday = DT.fromKey(at.date).getDay();
    const { engine, fired } = engineWith({
      routines: [{
        id: 'rn', name: 'Morning', active: true, remind: 0, days: [weekday],
        steps: [{ id: 'sn', title: 'Stretch', time: at.time }], completed: {}
      }]
    });
    engine.tick();
    const nudges = fired.filter(f => f.kind === 'routine-nudge');
    t.check('an overdue routine step raises a nudge', nudges.length === 1,
      fired.map(f => f.kind).join(','));
    t.check('the nudge says what is still open',
      nudges.length === 1 && nudges[0].title.indexOf('Stretch') > -1, nudges[0] && nudges[0].title);
    engine.tick();
    t.check('the nudge fires only once',
      fired.filter(f => f.kind === 'routine-nudge').length === 1);
  }

  {
    const at = offset(-11);
    const weekday = DT.fromKey(at.date).getDay();
    const { engine, fired } = engineWith({
      routines: [{
        id: 'rd', name: 'Morning', active: true, remind: 0, days: [weekday],
        steps: [{ id: 'sd', title: 'Done already', time: at.time }],
        completed: { [at.date]: ['sd'] }
      }]
    });
    engine.tick();
    t.check('a ticked-off step is never nudged',
      fired.filter(f => f.kind === 'routine-nudge').length === 0);
  }

  {
    const at = offset(1);
    const weekday = DT.fromKey(at.date).getDay();
    const otherDay = (weekday + 3) % 7;
    const { engine, fired } = engineWith({
      routines: [{
        id: 'r2', name: 'Gym', active: true, remind: 5, days: [otherDay],
        steps: [{ id: 's2', title: 'Squats', time: at.time }], completed: {}
      }]
    });
    engine.tick();
    t.check('a routine stays quiet on a day it does not run', fired.length === 0);
  }

  {
    const at = offset(1);
    const weekday = DT.fromKey(at.date).getDay();
    const { engine, fired } = engineWith({
      routines: [{
        id: 'r3', name: 'Paused', active: false, remind: 5, days: [weekday],
        steps: [{ id: 's3', title: 'Nope', time: at.time }], completed: {}
      }]
    });
    engine.tick();
    t.check('a paused routine never fires', fired.length === 0);
  }

  {
    const at = offset(1);
    const weekday = DT.fromKey(at.date).getDay();
    const { engine, fired } = engineWith({
      routines: [{
        id: 'r4', name: 'Done already', active: true, remind: 5, days: [weekday],
        steps: [{ id: 's4', title: 'Ticked', time: at.time }],
        completed: { [at.date]: ['s4'] }
      }]
    });
    engine.tick();
    t.check('a step already ticked off today does not nag', fired.length === 0);
  }

  {
    const { store, engine, fired } = engineWith({
      events: [{ id: 'e5', title: 'Quiet', date: offset(1).date, time: offset(1).time, remind: 5, recurrence: 'none' }]
    });
    store.data.settings.notifications.enabled = false;
    engine.tick();
    t.check('nothing fires while reminders are off', fired.length === 0);
  }
});

// ------------------------------------------------------------------ store

suite('data store defaults', t => {
  const { DEFAULTS } = require('../src/main/store.js');
  t.check('settings ship with a weather block', !!DEFAULTS.settings.weather);
  t.check('notifications default to on', DEFAULTS.settings.notifications.enabled === true);
  t.check('collections start empty', DEFAULTS.events.length === 0 && DEFAULTS.todos.length === 0);
  t.check('stats are initialised', !!DEFAULTS.stats.streak && DEFAULTS.stats.streak.current === 0);
});

process.exit(report() ? 0 : 1);
