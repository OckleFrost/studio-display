(function (global) {
  function parseTimeToMinutes(value) {
    const [hours, minutes] = String(value || '').split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return (hours * 60) + minutes;
  }

  function getSydneyClock() {
    const formatter = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return {
      hour: Number(values.hour || 0),
      minute: Number(values.minute || 0),
      second: Number(values.second || 0)
    };
  }

  function msUntilNextSydneyTarget(targetTimes) {
    const now = getSydneyClock();
    const currentMinutes = (now.hour * 60) + now.minute + (now.second / 60);
    const targets = targetTimes.map(parseTimeToMinutes).filter(Number.isFinite);
    if (!targets.length) return 6 * 60 * 60 * 1000;

    let bestMinutes = Infinity;
    for (const target of targets) {
      let diff = target - currentMinutes;
      if (diff <= 0) diff += 24 * 60;
      if (diff < bestMinutes) bestMinutes = diff;
    }

    return Math.max(15000, Math.round(bestMinutes * 60 * 1000));
  }

  function normaliseFeed(feed) {
    if (!feed || typeof feed !== 'object') return null;

    const streamUrl = feed.stream_url || feed.streamUrl;
    const snapshotUrl = feed.snapshot_url || feed.snapshotUrl;
    const streamId = feed.streamid || feed.streamId;

    if (!streamUrl || !snapshotUrl) return null;

    return {
      streamId: streamId || null,
      streamUrl,
      snapshotUrl
    };
  }

  function initAdelaideFeed(options) {
    const config = Object.assign({
      feedUrl: '../feeds/adelaide.json',
      fallbackRefreshMs: 30000,
      scheduledChecksSydney: ['06:55', '13:55'],
      videoId: 'adelaide-video',
      fallbackId: 'adelaide-fallback'
    }, options || {});

    const video = document.getElementById(config.videoId);
    const fallback = document.getElementById(config.fallbackId);

    if (!video || !fallback) return null;

    const state = {
      currentStreamId: config.initialStreamId || null,
      currentStreamUrl: config.initialStreamUrl,
      currentSnapshotUrl: config.initialSnapshotUrl,
      hls: null,
      fallbackIntervalId: null,
      scheduledRefreshTimeoutId: null,
      refreshPromise: null
    };

    function stopHls() {
      if (state.hls) {
        state.hls.destroy();
        state.hls = null;
      }
    }

    function stopFallbackRefresh() {
      if (!state.fallbackIntervalId) return;
      global.clearInterval(state.fallbackIntervalId);
      state.fallbackIntervalId = null;
    }

    function showFallback() {
      fallback.src = `${state.currentSnapshotUrl}?t=${Date.now()}`;
      fallback.classList.remove('hidden');
      video.classList.add('hidden');
    }

    function hideFallback() {
      fallback.classList.add('hidden');
      video.classList.remove('hidden');
    }

    function startFallbackRefresh() {
      showFallback();
      if (state.fallbackIntervalId) return;
      state.fallbackIntervalId = global.setInterval(() => {
        fallback.src = `${state.currentSnapshotUrl}?t=${Date.now()}`;
      }, config.fallbackRefreshMs);
    }

    function applyFeed(feed, restartPlayer) {
      const changed = Boolean(
        feed.streamId !== state.currentStreamId ||
        feed.streamUrl !== state.currentStreamUrl ||
        feed.snapshotUrl !== state.currentSnapshotUrl
      );

      state.currentStreamId = feed.streamId;
      state.currentStreamUrl = feed.streamUrl;
      state.currentSnapshotUrl = feed.snapshotUrl;
      fallback.src = state.currentSnapshotUrl;

      if (changed || restartPlayer) {
        startPlayback();
      }

      return changed;
    }

    async function fetchFeed() {
      const response = await fetch(`${config.feedUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`feed-http-${response.status}`);
      }

      const feed = normaliseFeed(await response.json());
      if (!feed) {
        throw new Error('feed-invalid');
      }

      return feed;
    }

    async function refreshFeed({ restartPlayer = false } = {}) {
      if (state.refreshPromise) return state.refreshPromise;

      state.refreshPromise = (async () => {
        try {
          const feed = await fetchFeed();
          return applyFeed(feed, restartPlayer);
        } catch (_) {
          return false;
        } finally {
          state.refreshPromise = null;
        }
      })();

      return state.refreshPromise;
    }

    function handlePlaybackFailure() {
      refreshFeed({ restartPlayer: true }).then((changed) => {
        if (!changed) startFallbackRefresh();
      });
    }

    function startPlayback() {
      stopFallbackRefresh();
      stopHls();
      hideFallback();

      video.pause();
      video.removeAttribute('src');
      video.load();
      video.muted = true;
      video.playsInline = true;

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = state.currentStreamUrl;
        video.play().catch(handlePlaybackFailure);
        return;
      }

      if (global.Hls && global.Hls.isSupported()) {
        const hls = new global.Hls({ maxLiveSyncPlaybackRate: 1.5, liveDurationInfinity: true, enableWorker: true });
        state.hls = hls;
        hls.loadSource(state.currentStreamUrl);
        hls.attachMedia(video);
        hls.on(global.Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(handlePlaybackFailure);
        });
        hls.on(global.Hls.Events.ERROR, (_, data) => {
          if (data && data.fatal) handlePlaybackFailure();
        });
        return;
      }

      startFallbackRefresh();
    }

    function scheduleNextTimedRefresh() {
      if (state.scheduledRefreshTimeoutId) {
        global.clearTimeout(state.scheduledRefreshTimeoutId);
      }

      const timeoutMs = msUntilNextSydneyTarget(config.scheduledChecksSydney);
      state.scheduledRefreshTimeoutId = global.setTimeout(async () => {
        await refreshFeed({ restartPlayer: true });
        scheduleNextTimedRefresh();
      }, timeoutMs);
    }

    video.addEventListener('error', handlePlaybackFailure);
    startPlayback();
    refreshFeed();
    scheduleNextTimedRefresh();

    const exportedState = {
      refreshFeed,
      getState: () => ({
        streamId: state.currentStreamId,
        streamUrl: state.currentStreamUrl,
        snapshotUrl: state.currentSnapshotUrl
      })
    };

    global.__adelaideFeedState = exportedState;
    return exportedState;
  }

  global.initAdelaideFeed = initAdelaideFeed;
})(window);
