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

    const kind = feed.kind || feed.type || (feed.image_url || feed.imageUrl ? 'image' : 'hls');
    const imageUrl = feed.image_url || feed.imageUrl;
    const streamUrl = feed.stream_url || feed.streamUrl;
    const snapshotUrl = feed.snapshot_url || feed.snapshotUrl;
    const streamId = feed.streamid || feed.streamId;
    const panorama = Boolean(feed.panorama || feed.isPanorama || feed.presentation === 'panorama');
    const refreshSeconds = Number(feed.refresh_seconds ?? feed.refreshSeconds);
    const refreshMs = Number.isFinite(refreshSeconds) && refreshSeconds >= 15
      ? Math.round(refreshSeconds * 1000)
      : null;

    if (kind === 'image') {
      if (!imageUrl && !snapshotUrl) return null;
      return {
        kind: 'image',
        streamId: streamId || null,
        streamUrl: null,
        snapshotUrl: imageUrl || snapshotUrl,
        imageUrl: imageUrl || snapshotUrl,
        panorama,
        refreshMs
      };
    }

    if (!streamUrl || !snapshotUrl) return null;

    return {
      kind: 'hls',
      streamId: streamId || null,
      streamUrl,
      snapshotUrl,
      imageUrl: null,
      panorama: false,
      refreshMs
    };
  }

  function initRecoveringHlsFeed(options) {
    const config = Object.assign({
      feedUrl: '../feeds/adelaide.json',
      fallbackRefreshMs: 30000,
      periodicFeedRefreshMs: 120000,
      scheduledChecksSydney: ['06:55', '13:55'],
      watchdogCheckMs: 15000,
      watchdogStallMs: 45000,
      minRecoveryGapMs: 20000,
      emergencyImageUrl: '../assets/adelaide-fallback.jpg',
      emergencyPanorama: false,
      videoId: 'adelaide-video',
      fallbackId: 'adelaide-fallback',
      stateName: '__recoveringHlsFeedState'
    }, options || {});

    const video = document.getElementById(config.videoId);
    const fallback = document.getElementById(config.fallbackId);

    if (!video || !fallback) return null;

    const state = {
      currentKind: config.initialKind || 'hls',
      currentStreamId: config.initialStreamId || null,
      currentStreamUrl: config.initialStreamUrl,
      currentSnapshotUrl: config.initialSnapshotUrl,
      currentImageUrl: config.initialImageUrl || null,
      currentPanorama: Boolean(config.initialPanorama),
      currentFallbackRefreshMs: config.fallbackRefreshMs,
      snapshotFailed: false,
      hls: null,
      fallbackIntervalId: null,
      periodicRefreshIntervalId: null,
      scheduledRefreshTimeoutId: null,
      watchdogIntervalId: null,
      fallbackIntervalMs: null,
      fallbackLoad: null,
      fallbackLoadToken: 0,
      refreshPromise: null,
      lastProgressAt: Date.now(),
      lastCurrentTime: 0,
      lastPlaybackStartAt: 0,
      lastRecoveryAt: 0
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
      state.fallbackIntervalMs = null;
    }

    function stopWatchdog() {
      if (!state.watchdogIntervalId) return;
      global.clearInterval(state.watchdogIntervalId);
      state.watchdogIntervalId = null;
    }

    function noteProgress(force) {
      const now = Date.now();
      const currentTime = Number(video.currentTime || 0);
      if (force || currentTime > state.lastCurrentTime + 0.01) {
        state.lastCurrentTime = currentTime;
        state.lastProgressAt = now;

        if (!fallback.classList.contains('hidden') && video.readyState >= 2 && !video.paused && !video.ended) {
          stopFallbackRefresh();
          hideFallback();
        }
      }
    }

    function fallbackUrl() {
      return state.snapshotFailed ? config.emergencyImageUrl : (state.currentSnapshotUrl || config.emergencyImageUrl);
    }

    function updateFallbackPresentation() {
      fallback.classList.toggle('feed-panorama', Boolean(state.currentPanorama || (state.snapshotFailed && config.emergencyPanorama)));
    }

    function cacheBust(url) {
      const separator = String(url).includes('?') ? '&' : '?';
      return `${url}${separator}t=${Date.now()}`;
    }

    function revealFallback() {
      fallback.classList.remove('hidden');
      video.classList.add('hidden');
    }

    function preloadFallback({ reveal = true } = {}) {
      const sourceUrl = fallbackUrl();
      if (!sourceUrl) return Promise.resolve(false);

      if (state.fallbackLoad && state.fallbackLoad.sourceUrl === sourceUrl) {
        state.fallbackLoad.reveal = state.fallbackLoad.reveal || reveal;
        return state.fallbackLoad.promise;
      }

      if (state.fallbackLoad) {
        state.fallbackLoad.resolve(false);
      }

      const token = ++state.fallbackLoadToken;
      const candidateUrl = cacheBust(sourceUrl);
      const image = new global.Image();
      const load = {
        sourceUrl,
        candidateUrl,
        reveal,
        resolve: null,
        promise: null
      };
      load.promise = new Promise((resolve) => {
        load.resolve = resolve;
      });
      state.fallbackLoad = load;

      image.onload = () => {
        if (token !== state.fallbackLoadToken || state.fallbackLoad !== load) {
          load.resolve(false);
          return;
        }

        state.fallbackLoad = null;
        fallback.src = candidateUrl;
        updateFallbackPresentation();
        if (load.reveal) revealFallback();
        load.resolve(true);
      };
      image.onerror = () => {
        if (token !== state.fallbackLoadToken || state.fallbackLoad !== load) {
          load.resolve(false);
          return;
        }

        state.fallbackLoad = null;
        if (!state.snapshotFailed && config.emergencyImageUrl && sourceUrl !== config.emergencyImageUrl) {
          state.snapshotFailed = true;
          preloadFallback({ reveal: load.reveal }).then(load.resolve);
          return;
        }
        load.resolve(false);
      };
      image.src = candidateUrl;
      return load.promise;
    }

    function showFallback() {
      return preloadFallback({ reveal: true });
    }

    function hideFallback() {
      fallback.classList.add('hidden');
      video.classList.remove('hidden');
    }

    function startFallbackRefresh() {
      showFallback();
      const refreshMs = Math.max(15000, Number(state.currentFallbackRefreshMs || config.fallbackRefreshMs));
      if (state.fallbackIntervalId && state.fallbackIntervalMs === refreshMs) return;
      stopFallbackRefresh();
      state.fallbackIntervalMs = refreshMs;
      state.fallbackIntervalId = global.setInterval(() => {
        showFallback();
      }, refreshMs);
    }

    function applyFeed(feed, restartPlayer) {
      const changed = Boolean(
        feed.kind !== state.currentKind ||
        feed.streamId !== state.currentStreamId ||
        feed.streamUrl !== state.currentStreamUrl ||
        feed.snapshotUrl !== state.currentSnapshotUrl ||
        feed.imageUrl !== state.currentImageUrl ||
        feed.panorama !== state.currentPanorama ||
        (feed.refreshMs || config.fallbackRefreshMs) !== state.currentFallbackRefreshMs
      );

      state.currentKind = feed.kind;
      state.currentStreamId = feed.streamId;
      state.currentStreamUrl = feed.streamUrl;
      state.currentSnapshotUrl = feed.snapshotUrl;
      state.currentImageUrl = feed.imageUrl;
      state.currentPanorama = feed.panorama;
      state.currentFallbackRefreshMs = feed.refreshMs || config.fallbackRefreshMs;
      state.snapshotFailed = false;

      if (changed || restartPlayer) {
        startPlayback();
      }

      return changed;
    }

    async function fetchFeed() {
      const headers = config.feedAccept ? { Accept: config.feedAccept } : undefined;
      const response = await fetch(cacheBust(config.feedUrl), {
        cache: 'no-store',
        headers
      });
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

    function recoverPlayback() {
      const now = Date.now();
      if (now - state.lastRecoveryAt < config.minRecoveryGapMs) return;
      state.lastRecoveryAt = now;
      refreshFeed({ restartPlayer: true }).then((changed) => {
        if (!changed && state.currentKind !== 'image') startPlayback();
      });
    }

    function handlePlaybackFailure() {
      const now = Date.now();
      if (now - state.lastRecoveryAt < config.minRecoveryGapMs) {
        startFallbackRefresh();
        return;
      }

      state.lastRecoveryAt = now;
      refreshFeed({ restartPlayer: true }).then((changed) => {
        if (!changed) startFallbackRefresh();
      });
    }

    function startPlayback() {
      stopFallbackRefresh();
      stopHls();
      state.lastPlaybackStartAt = Date.now();
      state.lastProgressAt = state.lastPlaybackStartAt;
      state.lastCurrentTime = 0;

      video.pause();
      video.removeAttribute('src');
      video.load();
      video.muted = true;
      video.playsInline = true;

      if (state.currentKind === 'image') {
        startFallbackRefresh();
        return;
      }

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

    function startWatchdog() {
      stopWatchdog();
      state.watchdogIntervalId = global.setInterval(() => {
        const now = Date.now();

        if (!fallback.classList.contains('hidden')) {
          if (state.currentKind === 'image') return;
          if (now - state.lastRecoveryAt >= config.watchdogStallMs) {
            recoverPlayback();
          }
          return;
        }

        const currentTime = Number(video.currentTime || 0);
        if (currentTime > state.lastCurrentTime + 0.01) {
          noteProgress(false);
          return;
        }

        const startupAge = now - state.lastPlaybackStartAt;
        const stalledFor = now - state.lastProgressAt;
        const appearsActive = !video.paused && !video.ended;

        if (appearsActive && startupAge >= config.watchdogStallMs && stalledFor >= config.watchdogStallMs) {
          recoverPlayback();
          return;
        }

        if (video.readyState < 2 && startupAge >= config.watchdogStallMs) {
          recoverPlayback();
        }
      }, config.watchdogCheckMs);
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

    function startPeriodicFeedRefresh() {
      if (!config.periodicFeedRefreshMs || config.periodicFeedRefreshMs < 15000) return;
      if (state.periodicRefreshIntervalId) global.clearInterval(state.periodicRefreshIntervalId);
      state.periodicRefreshIntervalId = global.setInterval(() => {
        refreshFeed();
      }, config.periodicFeedRefreshMs);
    }

    video.addEventListener('error', handlePlaybackFailure);
    fallback.addEventListener('error', () => {
      if (state.snapshotFailed || !config.emergencyImageUrl) return;
      state.snapshotFailed = true;
      preloadFallback({ reveal: !fallback.classList.contains('hidden') });
    });
    ['loadeddata', 'loadedmetadata', 'canplay', 'canplaythrough', 'playing', 'timeupdate', 'progress', 'seeked'].forEach((eventName) => {
      video.addEventListener(eventName, () => noteProgress(true));
    });
    ['stalled', 'waiting', 'ended'].forEach((eventName) => {
      video.addEventListener(eventName, handlePlaybackFailure);
    });
    startPlayback();
    refreshFeed();
    startPeriodicFeedRefresh();
    scheduleNextTimedRefresh();
    startWatchdog();

    const exportedState = {
      refreshFeed,
      getState: () => ({
        kind: state.currentKind,
        streamId: state.currentStreamId,
        streamUrl: state.currentStreamUrl,
        snapshotUrl: state.currentSnapshotUrl,
        imageUrl: state.currentImageUrl,
        panorama: state.currentPanorama,
        fallbackRefreshMs: state.currentFallbackRefreshMs
      })
    };

    global[config.stateName] = exportedState;
    return exportedState;
  }

  const ADELAIDE_API_BASE = 'https://api.github.com/repos/OckleFrost/studio-display/contents/';

  global.initRecoveringHlsFeed = initRecoveringHlsFeed;
  global.initAdelaideFeed = function initAdelaideFeed(options) {
    return initRecoveringHlsFeed(Object.assign({
      stateName: '__adelaideFeedState',
      feedUrl: `${ADELAIDE_API_BASE}feeds/adelaide.json?ref=main`,
      feedAccept: 'application/vnd.github.raw+json',
      emergencyImageUrl: 'https://raw.githubusercontent.com/OckleFrost/studio-display/main/assets/adelaide-fallback.jpg'
    }, options || {}));
  };
})(window);
