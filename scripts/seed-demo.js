'use strict';
/**
 * Writes a demo profile (events, tasks, notes, history) into a throwaway
 * user-data directory. Used with HRDOCK_USER_DATA to preview or screenshot the
 * widget without touching real data.
 *
 *   node scripts/seed-demo.js <dir> [tab]
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const tab = process.argv[3] || 'today';
if (!dir) {
  console.error('usage: node scripts/seed-demo.js <user-data-dir> [tab]');
  process.exit(1);
}

const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return key(d);
};

const today = key(new Date());

// A believable run of completed days, in LOCAL dates — an ISO slice would be
// UTC and would shift every key by a day in eastern time zones.
function routineHistory() {
  const out = {};
  for (let i = 1; i <= 12; i++) {
    out[shift(-i)] = i % 5 === 0 ? ['a1', 'a2'] : ['a1', 'a2', 'a3', 'a4'];
  }
  return out;
}
const completions = {};
[3, 5, 2, 6, 4, 0, 3, 5, 1, 4, 2, 3].forEach((count, i) => {
  if (count) completions[shift(-i)] = count;
});
const focus = {};
[5400, 3600, 7200, 1800, 4500, 0, 2700].forEach((secs, i) => {
  if (secs) focus[shift(-i)] = secs;
});

const data = {
  version: 1,
  settings: {
    theme: 'dark',
    accent: '#5b8cff',
    timeFormat: 24,
    showSeconds: true,
    firstDayOfWeek: 1,
    opacity: 1,
    compact: tab === 'compact',
    alwaysOnTop: true,
    clickThrough: false,
    autostart: false,
    startMinimised: false,
    surface: 'glass',
    lastTab: tab === 'compact' ? 'today' : tab,
    weather: { unit: 'c', detailed: true, auto: true, place: null, refreshMinutes: 30 },
    notifications: { enabled: true, sound: true, silent: false, defaultLeadMinutes: 10, snoozeMinutes: 10 },
    system: { enabled: true },
    modules: { weather: true, schedule: true, todos: true, notes: true, system: true }
  },
  bounds: { x: 60, y: 60, width: 460, height: 700 },
  compactBounds: { x: 60, y: 60, width: 340, height: 210 },
  events: [
    { id: 'ev1', title: 'Team stand-up', date: today, time: '09:30', endTime: '09:45', category: 'meeting', priority: 'medium', location: 'Teams', notes: '', status: 'planned', remind: 5, recurrence: 'weekdays', interval: 1, exceptions: [], completedOn: [today], createdAt: Date.now() },
    { id: 'ev2', title: 'Design review — dashboard v2', date: today, time: '14:00', endTime: '15:00', category: 'work', priority: 'high', location: 'Room 3B', notes: 'Bring the latest mockups.', status: 'planned', remind: 15, recurrence: 'none', interval: 1, exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev3', title: 'Gym — leg day', date: today, time: '18:30', endTime: '19:30', category: 'health', priority: 'low', location: '', notes: '', status: 'planned', remind: 30, recurrence: 'weekly', interval: 1, weekdays: [1, 3, 5], exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev4', title: 'Quarterly report due', date: shift(2), time: '17:00', endTime: '', category: 'deadline', priority: 'critical', location: '', notes: '', status: 'planned', remind: 1440, recurrence: 'none', interval: 1, exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev5', title: 'Sofia', date: '1997-09-14', time: '09:00', endTime: '', category: 'birthday', priority: 'medium', location: '', notes: '', status: 'planned', remind: 1440, recurrence: 'yearly', interval: 1, exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev6', title: 'Dentist', date: shift(5), time: '11:15', endTime: '12:00', category: 'health', priority: 'medium', location: 'Clinic', notes: '', status: 'planned', remind: 60, recurrence: 'none', interval: 1, exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev7', title: 'Sprint planning', date: shift(4), time: '10:00', endTime: '11:30', category: 'meeting', priority: 'high', location: '', notes: '', status: 'planned', remind: 10, recurrence: 'none', interval: 1, exceptions: [], completedOn: [], createdAt: Date.now() },
    { id: 'ev8', title: 'Coffee with Marcus', date: shift(-1), time: '16:00', endTime: '', category: 'personal', priority: 'low', location: 'Kaffeine', notes: '', status: 'done', remind: null, recurrence: 'none', interval: 1, exceptions: [], completedOn: [shift(-1)], createdAt: Date.now() }
  ],
  routines: [
    { id: 'r1', name: 'Morning routine', category: 'personal', days: [0,1,2,3,4,5,6], active: true, remind: 5, completed: routineHistory('r1'), createdAt: Date.now(), updatedAt: Date.now(),
      steps: [ { id: 'a1', title: 'Wake up', time: '07:00', duration: 15 }, { id: 'a2', title: 'Stretch and hydrate', time: '07:15', duration: 20 }, { id: 'a3', title: 'Breakfast', time: '07:40', duration: 30 }, { id: 'a4', title: 'Plan the day', time: '08:15', duration: 20 } ] },
    { id: 'r2', name: 'Deep work', category: 'work', days: [1,2,3,4,5], active: true, remind: 10, completed: {}, createdAt: Date.now(), updatedAt: Date.now(),
      steps: [ { id: 'b1', title: 'Clear inbox', time: '09:00', duration: 30 }, { id: 'b2', title: 'Focus block one', time: '09:30', duration: 90 }, { id: 'b3', title: 'Break', time: '11:00', duration: 15 }, { id: 'b4', title: 'Focus block two', time: '11:15', duration: 75 } ] },
    { id: 'r3', name: 'Evening wind-down', category: 'health', days: [0,1,2,3,4,5,6], active: true, remind: 10, completed: {}, createdAt: Date.now(), updatedAt: Date.now(),
      steps: [ { id: 'c1', title: 'Shut down work', time: '18:00', duration: 20 }, { id: 'c2', title: 'Exercise', time: '18:30', duration: 45 }, { id: 'c3', title: 'Read', time: '21:30', duration: 30 } ] }
  ],
  todos: [
    { id: 'td1', title: 'Ship the release notes', notes: 'Include the migration steps.', done: false, priority: 'critical', category: 'work', due: today, dueTime: '16:00', remind: 30, recurrence: 'none', interval: 1, order: 0, createdAt: Date.now() - 86400000, completedAt: null },
    { id: 'td2', title: 'Review PR #482', notes: '', done: false, priority: 'high', category: 'work', due: today, dueTime: '', remind: false, recurrence: 'none', interval: 1, order: 1, createdAt: Date.now() - 172800000, completedAt: null },
    { id: 'td3', title: 'Water the plants', notes: '', done: false, priority: 'low', category: 'personal', due: today, dueTime: '', remind: false, recurrence: 'weekly', interval: 1, order: 2, createdAt: Date.now() - 604800000, completedAt: null },
    { id: 'td4', title: 'Book flights for the conference', notes: '', done: false, priority: 'high', category: 'personal', due: shift(-2), dueTime: '', remind: false, recurrence: 'none', interval: 1, order: 3, createdAt: Date.now() - 432000000, completedAt: null },
    { id: 'td5', title: 'Read chapter 4 — distributed systems', notes: '', done: false, priority: 'medium', category: 'study', due: shift(3), dueTime: '', remind: false, recurrence: 'none', interval: 1, order: 4, createdAt: Date.now(), completedAt: null },
    { id: 'td6', title: 'Renew gym membership', notes: '', done: false, priority: 'medium', category: 'health', due: shift(6), dueTime: '', remind: false, recurrence: 'yearly', interval: 1, order: 5, createdAt: Date.now(), completedAt: null },
    { id: 'td7', title: 'Send invoice', notes: '', done: true, priority: 'high', category: 'work', due: shift(-1), dueTime: '', remind: false, recurrence: 'none', interval: 1, order: 6, createdAt: Date.now() - 259200000, completedAt: Date.now() - 3600000 },
    { id: 'td8', title: 'Back up the photo library', notes: '', done: true, priority: 'low', category: 'personal', due: null, dueTime: '', remind: false, recurrence: 'none', interval: 1, order: 7, createdAt: Date.now() - 500000000, completedAt: Date.now() - 7200000 }
  ],
  notes: [
    { id: 'nt1', title: 'Release checklist', html: '<div class="chk" data-done="1">Tag the build</div><div class="chk" data-done="1">Run smoke tests</div><div class="chk" data-done="0">Update the changelog</div><div class="chk" data-done="0">Announce in #general</div>', color: '#5b8cff', pinned: true, category: 'work', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000 },
    { id: 'nt2', title: 'Standup notes', html: '<b>Yesterday:</b> finished the calendar grid.<br><b>Today:</b> reminder engine + notifications.<br><b>Blockers:</b> none.', color: 'transparent', pinned: false, category: 'work', createdAt: Date.now() - 172800000, updatedAt: Date.now() - 7200000 },
    { id: 'nt3', title: 'Groceries', html: '<ul><li>Oat milk</li><li>Coffee beans</li><li>Chilli oil</li><li>Rye bread</li></ul>', color: '#3fc79a', pinned: false, category: 'personal', createdAt: Date.now() - 259200000, updatedAt: Date.now() - 86400000 },
    { id: 'nt4', title: 'Book ideas', html: 'Something on the history of timekeeping — from water clocks to NTP.', color: '#f5c451', pinned: false, category: 'study', createdAt: Date.now() - 900000000, updatedAt: Date.now() - 500000000 }
  ],
  stats: {
    completions,
    focus,
    streak: { current: 5, best: 12, last: today }
  }
};

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'hrdock-data.json'), JSON.stringify(data, null, 2), 'utf8');
console.log(`seeded demo profile in ${dir} (tab: ${tab})`);
