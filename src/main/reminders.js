'use strict';
/**
 * HR Dock — reminder engine.
 *
 * A single low-frequency tick (15s) drives every reminder. That is deliberate:
 * long setTimeout chains silently break when the machine sleeps or the clock
 * changes, whereas re-evaluating "what is due now" from the data is always
 * correct after a resume, and costs microseconds.
 *
 * Fired reminders are recorded on disk so a restart never re-fires yesterday's
 * alarms, and anything missed by more than GRACE_MS (machine was off) is
 * retired quietly instead of exploding onto the screen at login.
 */
const { Notification } = require('electron');
const DT = require('../shared/datetime.js');

const TICK_MS = 15000;
const GRACE_MS = 5 * 60 * 1000;        // still worth showing if we were late
const FIRED_TTL_MS = 14 * 24 * 3600 * 1000;

class ReminderEngine {
  constructor(store, { onFire } = {}) {
    this.store = store;
    this.onFire = onFire || (() => {});
    this.timer = null;
    if (!this.store.data.reminderState) {
      this.store.data.reminderState = { fired: {}, snoozed: [] };
    }
    this.state = this.store.data.reminderState;
    if (!this.state.fired) this.state.fired = {};
    if (!Array.isArray(this.state.snoozed)) this.state.snoozed = [];
  }

  start() {
    if (this.timer) return;
    this.pruneFired();
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) { console.error('[reminders] tick failed:', err); }
    }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  pruneFired() {
    const cutoff = Date.now() - FIRED_TTL_MS;
    let changed = false;
    for (const k of Object.keys(this.state.fired)) {
      if (this.state.fired[k] < cutoff) { delete this.state.fired[k]; changed = true; }
    }
    if (changed) this.store.save();
  }

  /**
   * Every reminder that could fire in the near window, flattened from events
   * and dated to-dos. Only the current and next occurrence of a recurring item
   * is considered — anything further out cannot be due yet.
   */
  collect() {
    const out = [];
    const data = this.store.data;
    const settings = data.settings.notifications || {};
    const lead = Number(settings.defaultLeadMinutes) || 0;
    // 0 disables the follow-up nudge entirely.
    const nudgeAfter = settings.routineNudgeMinutes === undefined
      ? 10 : Number(settings.routineNudgeMinutes) || 0;
    const today = DT.todayKey();
    const yesterday = DT.key(DT.addDays(new Date(), -1));

    for (const ev of data.events || []) {
      if (ev.remind === null || ev.remind === undefined || ev.remind === false) continue;
      if (ev.status === 'cancelled') continue;
      const minutes = ev.remind === true ? lead : Number(ev.remind);
      if (!Number.isFinite(minutes)) continue;

      // The occurrence in progress plus the next one covers every live alarm.
      const days = [];
      const cur = DT.nextOccurrence(ev, yesterday, 400);
      if (cur) {
        days.push(cur);
        const nxt = DT.nextOccurrence(ev, DT.key(DT.addDays(DT.fromKey(cur), 1)), 400);
        if (nxt) days.push(nxt);
      }

      for (const day of days) {
        const when = DT.at(day, ev.time || '09:00');
        if (!when) continue;
        const fireAt = when.getTime() - minutes * 60000;
        const isBirthday = ev.category === 'birthday';
        out.push({
          key: `event:${ev.id}:${day}`,
          kind: isBirthday ? 'birthday' : 'event',
          refId: ev.id,
          day,
          fireAt,
          title: isBirthday ? `🎂 ${ev.title}` : ev.title,
          body: this.describeEvent(ev, day, minutes, isBirthday),
          category: ev.category || 'general'
        });
      }
    }

    // Routines: each step is its own alarm, on the weekdays the routine runs.
    // Today and tomorrow are enough — anything further out cannot be due yet.
    for (const routine of data.routines || []) {
      if (!routine.active || !Array.isArray(routine.steps)) continue;
      const stepLead = routine.remind === true ? lead : Number(routine.remind);
      if (!Number.isFinite(stepLead)) continue;

      for (const dayKey of [today, DT.key(DT.addDays(new Date(), 1))]) {
        const weekday = DT.fromKey(dayKey).getDay();
        if (Array.isArray(routine.days) && routine.days.length && !routine.days.includes(weekday)) continue;
        const doneToday = (routine.completed && routine.completed[dayKey]) || [];

        for (const step of routine.steps) {
          if (!step.time || doneToday.includes(step.id)) continue;
          const when = DT.at(dayKey, step.time);
          if (!when) continue;
          out.push({
            key: `routine:${routine.id}:${step.id}:${dayKey}`,
            kind: 'routine',
            refId: routine.id,
            stepId: step.id,
            day: dayKey,
            fireAt: when.getTime() - stepLead * 60000,
            title: step.title,
            body: `${routine.name} · ${DT.formatTime(step.time, data.settings.timeFormat)}`
              + (stepLead > 0 ? ` — in ${stepLead} min` : ''),
            category: routine.category || 'general'
          });

          // Accountability: one follow-up if the step is still untouched a
          // while after it was due. A routine you silently skip is a routine
          // that quietly stops existing, so it gets exactly one nudge — not a
          // stream of them.
          if (nudgeAfter > 0 && dayKey === today) {
            out.push({
              key: `routine-nudge:${routine.id}:${step.id}:${dayKey}`,
              kind: 'routine-nudge',
              refId: routine.id,
              stepId: step.id,
              day: dayKey,
              fireAt: when.getTime() + nudgeAfter * 60000,
              title: `Still open: ${step.title}`,
              body: `${routine.name} · due at ${DT.formatTime(step.time, data.settings.timeFormat)}`,
              category: routine.category || 'general'
            });
          }
        }
      }
    }

    for (const todo of data.todos || []) {
      // `remind` of 0 means "at the due time" — falsy, but very much set.
      const unset = todo.remind === false || todo.remind === null || todo.remind === undefined;
      if (todo.done || !todo.due || unset) continue;
      const minutes = todo.remind === true ? lead : Number(todo.remind);
      if (!Number.isFinite(minutes)) continue;
      const when = DT.at(todo.due, todo.dueTime || '09:00');
      if (!when) continue;
      out.push({
        key: `todo:${todo.id}:${todo.due}`,
        kind: 'todo',
        refId: todo.id,
        day: todo.due,
        fireAt: when.getTime() - minutes * 60000,
        title: todo.title,
        body: todo.due === today
          ? `Task due ${todo.dueTime ? 'at ' + DT.formatTime(todo.dueTime, data.settings.timeFormat) : 'today'}`
          : `Task due ${DT.relativeDay(todo.due)}`,
        category: todo.category || 'task'
      });
    }

    for (const s of this.state.snoozed) {
      out.push({ ...s, snoozed: true });
    }
    return out;
  }

  describeEvent(ev, day, minutes, isBirthday) {
    const fmt = this.store.data.settings.timeFormat;
    if (isBirthday) {
      const born = DT.fromKey(ev.date);
      const age = born ? DT.fromKey(day).getFullYear() - born.getFullYear() : null;
      return age && age > 0 ? `Turns ${age} today` : 'Birthday today';
    }
    const time = ev.time ? DT.formatTime(ev.time, fmt) : 'all day';
    const when = minutes > 0 ? `in ${minutes} min` : 'now';
    return ev.location
      ? `${time} · ${ev.location} — starts ${when}`
      : `${time} — starts ${when}`;
  }

  tick() {
    const now = Date.now();
    const settings = this.store.data.settings.notifications || {};
    if (!settings.enabled) return;

    let dirty = false;
    for (const r of this.collect()) {
      if (r.fireAt > now) continue;
      if (this.state.fired[r.key] && !r.snoozed) continue;

      if (r.snoozed) {
        this.state.snoozed = this.state.snoozed.filter(s => s.key !== r.key || s.fireAt !== r.fireAt);
        dirty = true;
      }

      if (now - r.fireAt > GRACE_MS) {
        // Machine was asleep or the app was closed: retire it silently.
        this.state.fired[r.key] = now;
        dirty = true;
        continue;
      }

      this.state.fired[r.key] = now;
      dirty = true;
      this.fire(r);
    }
    if (dirty) this.store.save();
  }

  fire(reminder) {
    const settings = this.store.data.settings.notifications || {};
    const silent = !!settings.silent;

    if (!silent && Notification.isSupported()) {
      try {
        const n = new Notification({
          title: reminder.title,
          body: reminder.body,
          silent: true,               // the renderer owns the chime, so it can respect Silent mode
          timeoutType: 'default'
        });
        n.on('click', () => this.onFire({ ...reminder, action: 'click' }));
        n.show();
      } catch (err) {
        console.error('[reminders] notification failed:', err.message);
      }
    }
    this.onFire({ ...reminder, action: 'fire', silent });
  }

  /** Push a reminder forward; it comes back through the same pipeline. */
  snooze(reminder, minutes) {
    const mins = Number(minutes) || Number(this.store.data.settings.notifications.snoozeMinutes) || 10;
    const entry = {
      key: reminder.key,
      kind: reminder.kind,
      refId: reminder.refId,
      day: reminder.day,
      title: reminder.title,
      body: reminder.body,
      category: reminder.category,
      fireAt: Date.now() + mins * 60000
    };
    this.state.snoozed = this.state.snoozed.filter(s => s.key !== entry.key);
    this.state.snoozed.push(entry);
    this.store.save();
    return entry;
  }

  dismiss(key) {
    this.state.snoozed = this.state.snoozed.filter(s => s.key !== key);
    this.state.fired[key] = Date.now();
    this.store.save();
  }

  /** Called after any data edit so newly-changed items are picked up at once. */
  refresh() { this.tick(); }
}

module.exports = { ReminderEngine };
