/* HR Dock — live clock.
   One self-correcting timer drives the whole app's sense of time: it aligns to
   the next real second boundary (so it never drifts or double-fires after a
   sleep) and broadcasts minute and day ticks that other modules listen for
   instead of running timers of their own. */
(function (global) {
  'use strict';

  const { $ } = UI;

  let timer = null;
  let lastMinute = null;
  let lastDay = null;
  let els = null;
  let running = false;

  function cache() {
    els = {
      main: $('#clockMain'),
      seconds: $('#clockSeconds'),
      period: $('#clockPeriod'),
      weekday: $('#heroWeekday'),
      date: $('#heroDate'),
      zone: $('#heroZone')
    };
  }

  function zoneLabel(now) {
    try {
      const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(now);
      const zone = parts.find(p => p.type === 'timeZoneName');
      if (zone) return zone.value;
    } catch (_) { /* fall through to the offset form */ }
    const offset = -now.getTimezoneOffset() / 60;
    return `UTC${offset >= 0 ? '+' : ''}${offset}`;
  }

  function render(now) {
    const settings = State.settings();
    const use12 = Number(settings.timeFormat) === 12;
    const showSeconds = settings.showSeconds !== false;

    let hours = now.getHours();
    let period = '';
    if (use12) {
      period = hours < 12 ? 'AM' : 'PM';
      hours = hours % 12 === 0 ? 12 : hours % 12;
    }

    const hh = use12 ? String(hours) : DT.pad(hours);
    const mm = DT.pad(now.getMinutes());

    els.main.textContent = `${hh}:${mm}`;
    els.seconds.textContent = showSeconds ? DT.pad(now.getSeconds()) : '';
    els.seconds.style.display = showSeconds ? '' : 'none';
    els.period.textContent = period;

    const minuteNow = now.getHours() * 60 + now.getMinutes();
    if (minuteNow !== lastMinute) {
      lastMinute = minuteNow;
      State.emit('tick:minute', now);
    }

    const dayNow = DT.key(now);
    if (dayNow !== lastDay) {
      lastDay = dayNow;
      els.weekday.textContent = DT.DAY_NAMES[now.getDay()];
      els.date.textContent = `${DT.MONTH_NAMES[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
      els.zone.textContent = zoneLabel(now);
      State.emit('tick:day', dayNow);
    }
  }

  function schedule() {
    if (!running) return;
    const showSeconds = State.settings().showSeconds !== false;
    const now = new Date();
    // Land just after the next boundary so the displayed value is never early.
    const period = showSeconds ? 1000 : 60000;
    const elapsed = showSeconds
      ? now.getMilliseconds()
      : now.getSeconds() * 1000 + now.getMilliseconds();
    const delay = period - elapsed + 12;

    timer = setTimeout(() => {
      const at = new Date();
      render(at);
      schedule();
    }, delay);
  }

  function start() {
    if (!els) cache();
    if (running) return;
    running = true;
    render(new Date());
    schedule();
  }

  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function init() {
    cache();
    start();

    // A hidden widget does not need to repaint the clock 60 times a minute.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else { start(); State.emit('tick:minute', new Date()); }
    });

    // Re-render immediately when the 12/24-hour or seconds preference changes.
    State.on('settings', () => {
      if (!running) return;
      stop();
      lastDay = null;
      start();
    });

    // After a suspend/resume the wall clock may have jumped hours.
    hrdock.on('system:resume', () => {
      lastDay = null;
      lastMinute = null;
      if (running) { stop(); start(); }
    });
  }

  global.Clock = { init, start, stop };
}(window));
