/* HR Dock — inline icon set.
   Stroke-based 24px glyphs in the Fluent/Lucide idiom, inlined so the widget
   ships with no icon font, no network request and no extra paint pass. */
(function (global) {
  'use strict';

  const P = {
    // chrome + navigation
    pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/>',
    compact: '<rect x="3" y="4" width="18" height="7" rx="2"/><path d="M3 15h18M3 19h11"/>',
    expand: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/>',
    power: '<path d="M12 3.5v8"/><path d="M7.6 6.4a7.5 7.5 0 1 0 8.8 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>',
    eyeOff: '<path d="M9.9 4.2A9.6 9.6 0 0 1 12 4c6 0 10 8 10 8a17 17 0 0 1-3 4"/><path d="M6.6 6.6A17 17 0 0 0 2 12s4 8 10 8a9.6 9.6 0 0 0 4.2-1"/><path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.8"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h6M8 17h4"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    routine: '<path d="M20.5 9A9 9 0 0 0 5 6.2"/><path d="M3.5 15A9 9 0 0 0 19 17.8"/><path d="M21 3.5V9h-5.5M3 20.5V15h5.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',

    // actions
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevronL: '<path d="m15 5-7 7 7 7"/>',
    chevronR: '<path d="m9 5 7 7-7 7"/>',
    grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>',
    upload: '<path d="M12 21V9"/><path d="m7 13 5-5 5 5"/><path d="M4 3h16"/>',
    play: '<path d="M7 4v16l13-8Z"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    reset: '<path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 3v6h6"/>',

    listBullet: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/>',
    listNumber: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 7V3.5L2.8 4.3"/><path d="M2.6 11.2c.3-.6 1-1 1.7-.7.8.3.9 1.3.3 1.9L2.6 14h3"/><path d="M2.7 17h2.6l-1.5 1.7c.9 0 1.6.4 1.6 1.2 0 .7-.6 1.2-1.5 1.2-.7 0-1.2-.2-1.5-.6"/>',
    checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.8 2.8L16.5 9"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7L11.1 7"/><path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7L12.9 17"/>',
    highlight: '<path d="m14 4 6 6-8.5 8.5H6l-1.5-3L14 4Z"/><path d="M4 21h16"/>',
    clearFormat: '<path d="M8 5h11M13 5 9.5 19"/><path d="m15 13 6 6M21 13l-6 6"/>',

    // meta / attributes
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-3 7-3 7h18s-3-1-3-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    bellOff: '<path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M6 9v-1M18 8c0 6 3 7 3 7H7"/><path d="m2 2 20 20"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    flag: '<path d="M4 21V4"/><path d="M4 5h13l-2 4 2 4H4"/>',
    tag: '<path d="M20 12.6 12.6 20a2 2 0 0 1-2.8 0l-6-6A2 2 0 0 1 3.2 12l.6-7a1 1 0 0 1 1-1l7-.6a2 2 0 0 1 1.6.6l6.6 6.6a2 2 0 0 1 0 3Z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
    pinSm: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/>',
    mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    flame: '<path d="M12 22c4 0 7-2.7 7-6.5 0-4.5-4-6-4-10.5C11 7 9 8.5 9 11c-1-.6-1.5-1.6-1.5-3C6 9.7 5 12 5 15.5 5 19.3 8 22 12 22Z"/>',
    alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="m4 4 3-2M20 4l-3-2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
    cake: '<path d="M4 20h16"/><path d="M4 20v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6"/><path d="M12 12V8M9 4.5c0 1 3 1 3 0S9 3.5 9 4.5Z"/>',

    // weather
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
    cloudSun: '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1"/><path d="M17 20H8a4 4 0 0 1-.6-8 5 5 0 0 1 9.5 1.4A3.3 3.3 0 0 1 17 20Z"/>',
    cloud: '<path d="M17.5 19H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/>',
    cloudRain: '<path d="M17.5 16H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/><path d="M8 19.5 7 22M12.5 19.5l-1 2.5M17 19.5l-1 2.5"/>',
    cloudDrizzle: '<path d="M17.5 16H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/><path d="M9 19.5v1M13 19.5v1M17 19.5v1"/>',
    cloudSnow: '<path d="M17.5 16H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/><path d="M9 20h.01M13 20h.01M17 20h.01M11 22h.01M15 22h.01"/>',
    cloudLightning: '<path d="M17.5 15.5H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/><path d="m13 14-3 5h4l-2 4"/>',
    fog: '<path d="M17.5 14H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.7 3.7 3.7 0 0 1-.3 7.3Z"/><path d="M4 18h16M6 21.5h12"/>',
    sunrise: '<path d="M12 3v6M8.5 6.5 12 3l3.5 3.5"/><path d="M2 18h4M18 18h4M4.9 12.9l1.8 1.8M19.1 12.9l-1.8 1.8"/><path d="M8 18a4 4 0 0 1 8 0"/><path d="M2 22h20"/>',
    sunset: '<path d="M12 9V3M8.5 5.5 12 9l3.5-3.5"/><path d="M2 18h4M18 18h4M4.9 12.9l1.8 1.8M19.1 12.9l-1.8 1.8"/><path d="M8 18a4 4 0 0 1 8 0"/><path d="M2 22h20"/>',
    wind: '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h14a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
    droplet: '<path d="M12 3s6 6.2 6 10a6 6 0 0 1-12 0c0-3.8 6-10 6-10Z"/>',
    thermometer: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z"/>',
    gauge: '<path d="M12 14 16 9"/><path d="M20.5 17a9.5 9.5 0 1 0-17 0"/><circle cx="12" cy="14" r="1.5"/>',

    // system
    memory: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3"/>',
    disk: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h.01M10 12h6"/>',
    wifi: '<path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12.5a11 11 0 0 1 14 0"/><path d="M8.5 16a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>'
  };

  /** Wrap a glyph in an SVG shell. `cls` lets callers style hit areas. */
  function icon(name, size, cls) {
    const body = P[name];
    if (!body) return '';
    const s = size || 24;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" `
      + `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" `
      + `stroke-linejoin="round"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${body}</svg>`;
  }

  /**
   * WMO weather code -> { icon, label }.
   * Codes follow the Open-Meteo / WMO 4677 table.
   */
  function weatherGlyph(code, isDay) {
    const day = isDay === undefined ? true : !!isDay;
    const clear = day ? 'sun' : 'moon';
    const table = {
      0: [clear, 'Clear sky'],
      1: [day ? 'sun' : 'moon', 'Mainly clear'],
      2: [day ? 'cloudSun' : 'cloud', 'Partly cloudy'],
      3: ['cloud', 'Overcast'],
      45: ['fog', 'Fog'],
      48: ['fog', 'Rime fog'],
      51: ['cloudDrizzle', 'Light drizzle'],
      53: ['cloudDrizzle', 'Drizzle'],
      55: ['cloudDrizzle', 'Heavy drizzle'],
      56: ['cloudDrizzle', 'Freezing drizzle'],
      57: ['cloudDrizzle', 'Freezing drizzle'],
      61: ['cloudRain', 'Light rain'],
      63: ['cloudRain', 'Rain'],
      65: ['cloudRain', 'Heavy rain'],
      66: ['cloudRain', 'Freezing rain'],
      67: ['cloudRain', 'Freezing rain'],
      71: ['cloudSnow', 'Light snow'],
      73: ['cloudSnow', 'Snow'],
      75: ['cloudSnow', 'Heavy snow'],
      77: ['cloudSnow', 'Snow grains'],
      80: ['cloudRain', 'Rain showers'],
      81: ['cloudRain', 'Rain showers'],
      82: ['cloudRain', 'Violent showers'],
      85: ['cloudSnow', 'Snow showers'],
      86: ['cloudSnow', 'Snow showers'],
      95: ['cloudLightning', 'Thunderstorm'],
      96: ['cloudLightning', 'Storm with hail'],
      99: ['cloudLightning', 'Storm with hail']
    };
    const hit = table[code] || ['cloud', 'Unknown'];
    return { icon: hit[0], label: hit[1] };
  }

  global.Icons = { icon, weatherGlyph, PATHS: P };
}(window));
