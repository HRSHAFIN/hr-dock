/**
 * HR Dock — shared date, time and recurrence helpers.
 * Loaded by the main process via require() and by the renderer via <script>.
 * All calendar maths runs on local calendar days keyed 'YYYY-MM-DD', so an
 * event never drifts across a day boundary because of a UTC conversion.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MS_DAY = 86400000;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const pad = n => String(n).padStart(2, '0');

  /** Local calendar-day key for a Date. */
  function key(date) {
    return pad(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /** Date at local midnight for a 'YYYY-MM-DD' key. */
  function fromKey(k) {
    if (!k || typeof k !== 'string') return null;
    const parts = k.split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function todayKey() { return key(new Date()); }

  function addDays(date, n) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function addMonths(date, n) {
    const d = new Date(date.getFullYear(), date.getMonth(), 1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), last));
    return d;
  }

  function diffDays(aKey, bKey) {
    const a = fromKey(aKey);
    const b = fromKey(bKey);
    if (!a || !b) return 0;
    return Math.round((b - a) / MS_DAY);
  }

  function startOfWeek(date, firstDay) {
    const first = firstDay === undefined ? 1 : firstDay;
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() - first + 7) % 7));
    return d;
  }

  /** 6x7 grid of Dates covering the month that `date` falls in. */
  function monthGrid(date, firstDay) {
    const start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1), firstDay);
    const cells = [];
    for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
    return cells;
  }

  /** '09:30' -> 570 minutes. null when blank or malformed. */
  function toMinutes(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function fromMinutes(mins) {
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  /** Format a time-of-day for display, honouring the 12/24-hour preference. */
  function formatTime(hhmm, format) {
    const mins = toMinutes(hhmm);
    if (mins === null) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (Number(format) === 12) {
      const suffix = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return h12 + ':' + pad(m) + ' ' + suffix;
    }
    return pad(h) + ':' + pad(m);
  }

  /** A Date combining a day key with an optional 'HH:MM'. */
  function at(dayKey, hhmm) {
    const d = fromKey(dayKey);
    if (!d) return null;
    const mins = toMinutes(hhmm);
    if (mins !== null) d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d;
  }

  function relativeDay(dayKey) {
    const delta = diffDays(todayKey(), dayKey);
    if (delta === 0) return 'Today';
    if (delta === 1) return 'Tomorrow';
    if (delta === -1) return 'Yesterday';
    const d = fromKey(dayKey);
    if (!d) return '';
    if (delta > 0 && delta < 7) return DAY_NAMES[d.getDay()];
    if (delta < 0 && delta > -7) return 'Last ' + DAY_NAMES[d.getDay()];
    return MONTH_NAMES[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
  }

  // ---------------------------------------------------------------- recurrence

  /**
   * Does a recurring item land on `dayKey`?
   * Item shape: { date, recurrence, interval, until, weekdays[], exceptions[] }
   * where `date` is the anchor (first) occurrence.
   */
  function occursOn(item, dayKey) {
    const anchor = item.date;
    if (!anchor || !dayKey) return false;
    const rec = item.recurrence || 'none';
    if (dayKey < anchor) return false;
    if (item.until && dayKey > item.until) return false;
    if (Array.isArray(item.exceptions) && item.exceptions.indexOf(dayKey) !== -1) return false;
    if (rec === 'none') return dayKey === anchor;

    const interval = Math.max(1, Number(item.interval) || 1);
    const a = fromKey(anchor);
    const d = fromKey(dayKey);
    if (!a || !d) return false;

    switch (rec) {
      case 'daily':
        return diffDays(anchor, dayKey) % interval === 0;
      case 'weekdays':
        return d.getDay() >= 1 && d.getDay() <= 5;
      case 'weekly': {
        const days = Array.isArray(item.weekdays) && item.weekdays.length
          ? item.weekdays
          : [a.getDay()];
        if (days.indexOf(d.getDay()) === -1) return false;
        const weeks = Math.floor(
          diffDays(key(startOfWeek(a, 0)), key(startOfWeek(d, 0))) / 7);
        return weeks % interval === 0;
      }
      case 'monthly': {
        const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
        if (months % interval !== 0) return false;
        const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        // A 31st anchor lands on the last day of shorter months.
        return d.getDate() === Math.min(a.getDate(), lastOfMonth);
      }
      case 'yearly':
        return d.getDate() === a.getDate()
          && d.getMonth() === a.getMonth()
          && (d.getFullYear() - a.getFullYear()) % interval === 0;
      default:
        return dayKey === anchor;
    }
  }

  /** Every day key in [startKey, endKey] on which `item` occurs. */
  function occurrencesBetween(item, startKey, endKey) {
    const out = [];
    const start = fromKey(startKey);
    const end = fromKey(endKey);
    if (!start || !end) return out;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const k = key(d);
      if (occursOn(item, k)) out.push(k);
    }
    return out;
  }

  /** Next day key on or after `from`, searched up to `limit` days ahead. */
  function nextOccurrence(item, from, limit) {
    let d = fromKey(from || todayKey());
    if (!d) return null;
    const max = limit || 800;
    for (let i = 0; i < max; i++) {
      const k = key(d);
      if (occursOn(item, k)) return k;
      d = addDays(d, 1);
    }
    return null;
  }

  return {
    MS_DAY: MS_DAY,
    DAY_NAMES: DAY_NAMES,
    MONTH_NAMES: MONTH_NAMES,
    pad: pad,
    key: key,
    fromKey: fromKey,
    todayKey: todayKey,
    addDays: addDays,
    addMonths: addMonths,
    diffDays: diffDays,
    startOfWeek: startOfWeek,
    monthGrid: monthGrid,
    toMinutes: toMinutes,
    fromMinutes: fromMinutes,
    formatTime: formatTime,
    at: at,
    relativeDay: relativeDay,
    occursOn: occursOn,
    occurrencesBetween: occurrencesBetween,
    nextOccurrence: nextOccurrence
  };
}));
