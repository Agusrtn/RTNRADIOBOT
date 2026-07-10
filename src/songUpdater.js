// Fetches current song from the RTN backend and notifies listeners only when it changes.

const DEFAULT_POLL_MS = 2000;

/**
 * Creates a polling loop.
 * @param {Object} params
 * @param {string} params.endpoint - API endpoint for current song.
 * @param {number} [params.pollMs]
 * @param {(song: string) => void} params.onSongChange
 * @param {() => void} [params.onError]
 */
function createSongPoller({ endpoint, pollMs = DEFAULT_POLL_MS, onSongChange, onError }) {
  let timer = null;
  let lastSongObject = null;
  let lastSongTitle = null;
  let lastAudioUrl = null;
  let stopped = false;

  async function fetchSong() {
    console.log('[songPoller] fetching from', endpoint);
    const res = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    console.log('[songPoller] fetched data:', data && typeof data === 'object' ? JSON.stringify(data).slice(0, 1000) : String(data));

    // Guardamos el objeto completo por si el backend ya incluye audioUrl.
    const obj = data?.station?.currentSong ?? data?.currentSong ?? data?.current_song ?? data;
    lastSongObject = obj;

    // Intentamos sacar un string “title/nombre” para comparar.
    const candidate =
      obj?.title ??
      obj?.song ??
      obj?.name ??
      data?.song ??
      data?.title ??
      data?.track ??
      data?.nowPlaying ??
      data?.now_playing ??
      null;

    const normalizedTitle = typeof candidate === 'string' ? candidate.trim() : (candidate == null ? null : String(candidate));

    // Intentamos obtener la URL de audio desde campos comunes.
    const audioUrl =
      obj?.audioUrl ??
      obj?.audio_url ??
      obj?.url ??
      obj?.streamUrl ??
      obj?.stream_url ??
      data?.audioUrl ??
      data?.audio_url ??
      data?.url ??
      data?.streamUrl ??
      null;

    return { title: normalizedTitle || null, audioUrl: audioUrl || null, object: lastSongObject };
  }

  async function tick() {
    if (stopped) return;

    try {
      const info = await fetchSong();

      const titleChanged = info.title && info.title !== lastSongTitle;
      const audioChanged = info.audioUrl && info.audioUrl !== lastAudioUrl;

      if (titleChanged || audioChanged) {
        console.log('[songPoller] change detected. titleChanged:', titleChanged, 'audioChanged:', audioChanged);
        lastSongTitle = info.title;
        lastAudioUrl = info.audioUrl;
        onSongChange(info);
      }
    } catch (e) {
      console.warn('[songPoller] fetch error', e?.message || e);
      if (onError) onError(e);
      // Keep polling even if the API fails.
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, pollMs);
      }
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setTimeout(tick, 0);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    getLastSong: () => lastSongTitle,
    getLastSongObject: () => lastSongObject,
  };
}

module.exports = { createSongPoller };

