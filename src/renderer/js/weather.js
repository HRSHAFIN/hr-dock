/* HR Dock — weather presentation.
   Fetching lives in the main process; this module only renders and schedules
   refreshes. It keeps the last good payload so a dropped connection degrades
   to a stale badge rather than an empty card. */
(function (global) {
  'use strict';

  const { $, esc } = UI;

  let latest = null;
  let refreshTimer = null;
  let loading = false;
  let expanded = false;          // is the hourly/5-day section open?

  const round = n => (Number.isFinite(n) ? Math.round(n) : null);

  function unitSymbol() {
    return State.settings().weather.unit === 'f' ? '°F' : '°C';
  }

  /** 'HH:MM' out of an ISO local timestamp like '2026-09-07T06:31'. */
  function isoTime(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const t = iso.split('T')[1];
    return t ? t.slice(0, 5) : '';
  }

  function fmtClock(iso) {
    return DT.formatTime(isoTime(iso), State.settings().timeFormat);
  }

  // ------------------------------------------------------------ hero chip

  function renderHero() {
    const iconEl = $('#hwIcon');
    const tempEl = $('#hwTemp');
    const descEl = $('#hwDesc');
    if (!iconEl) return;

    if (!latest || latest.error && !latest.current) {
      iconEl.innerHTML = Icons.icon('cloud', 24);
      tempEl.textContent = '--°';
      descEl.textContent = latest && latest.error ? 'Unavailable' : 'Loading…';
      return;
    }

    const cur = latest.current || {};
    const glyph = Icons.weatherGlyph(cur.weather_code, cur.is_day);
    iconEl.innerHTML = Icons.icon(glyph.icon, 24);
    tempEl.textContent = `${round(cur.temperature_2m)}${unitSymbol().charAt(0) === '°' ? '°' : ''}`;
    const place = latest.place ? latest.place.name : '';
    descEl.textContent = `${glyph.label}${place ? ' · ' + place : ''}`;
    $('#heroWeather').title = latest.stale
      ? 'Weather data is stale — click to retry'
      : `${glyph.label} · updated ${new Date(latest.fetchedAt).toLocaleTimeString()}\nClick to refresh`;
  }

  // ----------------------------------------------------------- full card

  function metric(value, label) {
    return `<div class="wx-metric"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  }

  function renderCard() {
    const card = $('#weatherCard');
    if (!card) return;

    // The card lives on Today; a background refresh should not repaint it
    // while the user is on another tab (setTab re-renders Today on return).
    if (!State.isActiveTab('today')) return;

    const settings = State.settings();
    if (!settings.modules.weather) { card.hidden = true; return; }
    card.hidden = false;

    if (!latest) {
      card.innerHTML = `
        <div class="wx-top">
          <div class="wx-glyph skeleton" style="border-radius:50%"></div>
          <div class="wx-main">
            <div class="skeleton" style="height:26px;width:110px;margin-bottom:6px"></div>
            <div class="skeleton" style="height:12px;width:150px"></div>
          </div>
        </div>`;
      return;
    }

    if (latest.error && !latest.current) {
      card.innerHTML = `
        <div class="empty">
          <strong>Weather unavailable</strong>
          ${esc(latest.error)}
          <div style="margin-top:10px"><button class="ghost-btn" id="wxRetry">Try again</button></div>
        </div>`;
      const retry = $('#wxRetry');
      if (retry) retry.onclick = () => refresh(true);
      return;
    }

    const cur = latest.current || {};
    const daily = latest.daily || {};
    const glyph = Icons.weatherGlyph(cur.weather_code, cur.is_day);
    const detailed = settings.weather.detailed !== false;
    const u = unitSymbol();
    const windUnit = latest.units ? latest.units.wind : 'km/h';

    let html = `
      <div class="wx-top">
        <div class="wx-glyph">${Icons.icon(glyph.icon, 42)}</div>
        <div class="wx-main">
          <div class="wx-temp">${round(cur.temperature_2m)}<sup>${esc(u)}</sup></div>
          <div class="wx-cond">${esc(glyph.label)} · feels like ${round(cur.apparent_temperature)}°</div>
          <div class="wx-place">${Icons.icon('mapPin', 11)} ${esc(latest.place.name)}${latest.place.country ? ', ' + esc(latest.place.country) : ''}</div>
        </div>
      </div>`;

    html += `<div class="wx-metrics">
      ${metric(`${round(cur.relative_humidity_2m)}%`, 'Humidity')}
      ${metric(`${round(cur.wind_speed_10m)}`, windUnit)}
      ${metric(`${round(cur.apparent_temperature)}°`, 'Feels like')}
      ${metric(`${round((daily.precipitation_probability_max || [])[0]) ?? 0}%`, 'Rain')}
    </div>`;

    if (detailed) {
      const sunrise = (daily.sunrise || [])[0];
      const sunset = (daily.sunset || [])[0];
      if (sunrise && sunset) {
        html += `<div class="wx-sun">
          <div>${Icons.icon('sunrise', 14)} <span>${esc(fmtClock(sunrise))}</span></div>
          <div>${Icons.icon('sunset', 14)} <span>${esc(fmtClock(sunset))}</span></div>
          <div>${Icons.icon('gauge', 14)} <span>${round(cur.pressure_msl)} hPa</span></div>
          <div>${Icons.icon('sun', 14)} <span>UV ${round((daily.uv_index_max || [])[0]) ?? '—'}</span></div>
        </div>`;
      }

      // The hourly strip and five-day outlook are tall, and the Today view's
      // job is the schedule — so they live behind a disclosure that remembers
      // its state instead of pushing the agenda below the fold.
      html += `<button class="wx-toggle" id="wxToggle" aria-expanded="${expanded}">
        <span>Hourly &amp; 5-day forecast</span>${Icons.icon('chevronR', 13)}
      </button><div class="wx-extended"${expanded ? '' : ' hidden'}>`;

      // Next eight hours, starting from the current hour.
      const hourly = latest.hourly || {};
      const times = hourly.time || [];
      const nowIso = new Date().toISOString().slice(0, 13);
      let startIdx = times.findIndex(t => t.slice(0, 13) >= nowIso);
      if (startIdx < 0) startIdx = 0;
      const slice = times.slice(startIdx, startIdx + 8);
      if (slice.length) {
        html += '<div class="wx-hours">';
        slice.forEach((t, i) => {
          const idx = startIdx + i;
          const g = Icons.weatherGlyph(hourly.weather_code[idx], !isNight(t, daily));
          html += `<div class="wx-hour">
            ${esc(i === 0 ? 'Now' : DT.formatTime(isoTime(t), State.settings().timeFormat === 12 ? 12 : 24).replace(':00', ''))}
            ${Icons.icon(g.icon, 17)}
            <b>${round(hourly.temperature_2m[idx])}°</b>
          </div>`;
        });
        html += '</div>';
      }

      // Five-day outlook with a relative range bar.
      const days = (daily.time || []).slice(0, 5);
      if (days.length) {
        const lows = daily.temperature_2m_min.slice(0, 5);
        const highs = daily.temperature_2m_max.slice(0, 5);
        const min = Math.min(...lows);
        const max = Math.max(...highs);
        const span = Math.max(1, max - min);
        html += '<div class="wx-days">';
        days.forEach((d, i) => {
          const g = Icons.weatherGlyph(daily.weather_code[i], true);
          const left = ((lows[i] - min) / span) * 100;
          const width = Math.max(6, ((highs[i] - lows[i]) / span) * 100);
          const label = i === 0 ? 'Today' : DT.DAY_NAMES[DT.fromKey(d).getDay()].slice(0, 3);
          html += `<div class="wx-day">
            <span class="wd-name">${esc(label)}</span>
            ${Icons.icon(g.icon, 17)}
            <span class="wd-range">
              <span class="wd-lo">${round(lows[i])}°</span>
              <span class="wx-bar"><i style="left:${left}%;width:${width}%"></i></span>
              <span class="wd-hi">${round(highs[i])}°</span>
            </span>
          </div>`;
        });
        html += '</div>';
      }

      html += '</div>';           // close .wx-extended
    }

    if (latest.stale) {
      html += `<div class="wx-stale">Showing last known reading — ${esc(latest.error || 'offline')}</div>`;
    }

    card.innerHTML = html;

    const toggle = $('#wxToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        const panel = card.querySelector('.wx-extended');
        if (panel) panel.hidden = !expanded;
        State.patchSettings({ weather: { expanded } });
      });
    }
  }

  /** Rough day/night test for an hourly slot, using today's sun times. */
  function isNight(iso, daily) {
    const sunrise = (daily.sunrise || [])[0];
    const sunset = (daily.sunset || [])[0];
    if (!sunrise || !sunset) return false;
    const hm = isoTime(iso);
    return hm < isoTime(sunrise) || hm > isoTime(sunset);
  }

  // -------------------------------------------------------------- fetching

  async function refresh(force) {
    if (loading) return latest;
    loading = true;
    const chip = $('#heroWeather');
    if (chip && force) chip.classList.add('busy');
    try {
      latest = await hrdock.weather.get({ force: !!force });
      renderHero();
      renderCard();
      if (force && latest && latest.error) {
        UI.toast({ kind: 'error', title: 'Weather refresh failed', message: latest.error });
      }
    } catch (err) {
      console.error('[weather]', err);
    } finally {
      loading = false;
      if (chip) chip.classList.remove('busy');
    }
    return latest;
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const minutes = Math.max(5, Number(State.settings().weather.refreshMinutes) || 30);
    refreshTimer = setInterval(() => refresh(false), minutes * 60000);
  }

  function init() {
    expanded = !!State.settings().weather.expanded;
    const chip = $('#heroWeather');
    if (chip) {
      chip.addEventListener('click', () => refresh(true));
    }

    refresh(false);
    scheduleRefresh();

    State.on('settings', () => { scheduleRefresh(); renderCard(); renderHero(); });
    // A resumed machine may have been closed for hours — and may have moved.
    hrdock.on('system:resume', () => refresh(true));
  }

  global.Weather = {
    init,
    refresh,
    renderCard,
    current: () => latest
  };
}(window));
