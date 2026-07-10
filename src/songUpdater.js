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
  let lastSong = null;
  let timer = null;
  let stopped = false;

  async function fetchSong() {
    const res = await fetch(endpoint, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    // Try common keys.
    const candidate =
      data?.currentSong ??
      data?.current_song ??
      data?.song ??
      data?.title ??
      data?.track ??
      data?.nowPlaying ??
      data?.now_playing ??
      null;

    const normalized = typeof candidate === 'string' ? candidate.trim() : (candidate == null ? null : String(candidate));

    return normalized || null;
  }

  async function tick() {
    if (stopped) return;

    try {
      const song = await fetchSong();
      if (song && song !== lastSong) {
        lastSong = song;
        onSongChange(song);
      }
    } catch (e) {
      if (onError) onError();
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

  return { start, stop, getLastSong: () => lastSong };
}

module.exports = { createSongPoller };

