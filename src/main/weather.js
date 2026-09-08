'use strict';
/**
 * HR Dock — weather service.
 *
 * Uses Open-Meteo, which needs no API key and no account. All network calls
 * happen here in the main process so the renderer can keep a strict
 * connect-src 'none' CSP. Results are cached and served stale when offline.
 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const IP_LOOKUPS = ['https://ipapi.co/json/', 'http://ip-api.com/json/'];

const CURRENT = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day',
  'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'
].join(',');
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'sunrise', 'sunset', 'precipitation_probability_max', 'uv_index_max'
].join(',');
const HOURLY = ['temperature_2m', 'weather_code', 'precipitation_probability'].join(',');

async function getJSON(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HR Dock-Widget/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class WeatherService {
  constructor() {
    this.cache = null;       // last successful payload
    this.cachedAt = 0;
    this.ipPlace = null;
    this.inflight = null;
  }

  /** Best-effort location from the public IP address. */
  async detectPlace(force = false) {
    if (this.ipPlace && !force) return this.ipPlace;
    for (const url of IP_LOOKUPS) {
      try {
        const j = await getJSON(url, 6000);
        const lat = Number(j.latitude ?? j.lat);
        const lon = Number(j.longitude ?? j.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          this.ipPlace = {
            name: j.city || j.regionName || j.region || 'Current location',
            country: j.country_name || j.country || '',
            lat, lon, auto: true
          };
          return this.ipPlace;
        }
      } catch (_) { /* try the next provider */ }
    }
    return null;
  }

  async searchPlaces(query) {
    if (!query || query.trim().length < 2) return [];
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(query.trim())}&count=8&language=en&format=json`;
    try {
      const j = await getJSON(url);
      return (j.results || []).map(r => ({
        name: r.name,
        country: r.country || '',
        admin: r.admin1 || '',
        lat: r.latitude,
        lon: r.longitude
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * @param {{lat:number, lon:number, name?:string}|null} place
   * @param {{unit?:'c'|'f', force?:boolean, maxAgeMs?:number}} opts
   */
  async fetchWeather(place, opts = {}) {
    const { unit = 'c', force = false, maxAgeMs = 10 * 60 * 1000 } = opts;
    let target = place;
    if (!target || !Number.isFinite(target.lat)) target = await this.detectPlace();
    if (!target) {
      return this.cache
        ? { ...this.cache, stale: true, error: 'No location available' }
        : { error: 'Could not determine a location. Set one manually in Settings.' };
    }

    const fresh = this.cache
      && this.cache.place
      && Math.abs(this.cache.place.lat - target.lat) < 0.01
      && Math.abs(this.cache.place.lon - target.lon) < 0.01
      && this.cache.unit === unit
      && Date.now() - this.cachedAt < maxAgeMs;
    if (fresh && !force) return this.cache;
    if (this.inflight) return this.inflight;

    const tempUnit = unit === 'f' ? 'fahrenheit' : 'celsius';
    const windUnit = unit === 'f' ? 'mph' : 'kmh';
    const url = `${FORECAST_URL}?latitude=${target.lat}&longitude=${target.lon}`
      + `&current=${CURRENT}&daily=${DAILY}&hourly=${HOURLY}`
      + `&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`
      + '&timezone=auto&forecast_days=6&forecast_hours=24';

    this.inflight = (async () => {
      try {
        const j = await getJSON(url);
        const payload = {
          place: {
            name: target.name || 'Current location',
            country: target.country || '',
            lat: target.lat,
            lon: target.lon,
            auto: !!target.auto
          },
          unit,
          units: {
            temp: unit === 'f' ? '°F' : '°C',
            wind: unit === 'f' ? 'mph' : 'km/h'
          },
          current: j.current || {},
          daily: j.daily || {},
          hourly: j.hourly || {},
          timezone: j.timezone,
          fetchedAt: Date.now(),
          stale: false
        };
        this.cache = payload;
        this.cachedAt = Date.now();
        return payload;
      } catch (err) {
        if (this.cache) return { ...this.cache, stale: true, error: err.message };
        return { error: `Weather unavailable (${err.message})` };
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }
}

module.exports = { WeatherService };
