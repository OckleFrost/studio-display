(function (global) {
  const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/OckleFrost/studio-display/main/feeds/brisbane.json';
  const DEFAULT_FALLBACK_VIDEO_ID = 'I7OY3JC15EE';

  const pendingPlayerInitializers = [];
  const previousReady = global.onYouTubeIframeAPIReady;

  global.onYouTubeIframeAPIReady = function () {
    if (typeof previousReady === 'function') previousReady();
    while (pendingPlayerInitializers.length) {
      const initializer = pendingPlayerInitializers.shift();
      initializer();
    }
  };

  function cacheBust(url) {
    const separator = String(url).includes('?') ? '&' : '?';
    return `${url}${separator}t=${Date.now()}`;
  }

  function buildEmbedUrl(videoId) {
    const url = new URL(`https://www.youtube.com/embed/${videoId}`);
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('mute', '1');
    url.searchParams.set('controls', '0');
    url.searchParams.set('modestbranding', '1');
    url.searchParams.set('playsinline', '1');
    url.searchParams.set('rel', '0');
    url.searchParams.set('enablejsapi', '1');
    return url.toString();
  }

  function normaliseFeed(feed) {
    if (!feed || typeof feed !== 'object') return null;

    const primaryVideoId = feed.primary_video_id || feed.primaryVideoId || feed.video_id || feed.videoId || null;
    const fallbackVideoId = feed.fallback_video_id || feed.fallbackVideoId || DEFAULT_FALLBACK_VIDEO_ID;

    if (!primaryVideoId && !fallbackVideoId) return null;

    return {
      primaryVideoId,
      fallbackVideoId,
      status: feed.status || 'unknown'
    };
  }

  function initBrisbaneFeed(options) {
    const config = Object.assign({
      frameId: 'brisbane-frame',
      feedUrl: DEFAULT_FEED_URL,
      feedAccept: null,
      initialVideoId: null,
      fallbackVideoId: DEFAULT_FALLBACK_VIDEO_ID,
      refreshMs: 300000,
      noPlayMs: 90000,
      bufferMs: 90000,
      fallbackHoldMs: 300000,
      recoveryCheckMs: 10000,
      recoverySuccessesRequired: 3
    }, options || {});

    const frame = document.getElementById(config.frameId);
    if (!frame) return null;

    const state = {
      primaryVideoId: config.initialVideoId || frame.dataset.primaryVideoId || null,
      fallbackVideoId: config.fallbackVideoId || frame.dataset.fallbackVideoId || DEFAULT_FALLBACK_VIDEO_ID,
      player: null,
      usedFallback: false,
      noPlayTimer: null,
      bufferTimer: null,
      refreshTimer: null,
      refreshPromise: null,
      recoveryTimer: null,
      recoveryInterval: null,
      recoverySuccesses: 0,
      recovering: false
    };

    function clearTimers() {
      global.clearTimeout(state.noPlayTimer);
      global.clearTimeout(state.bufferTimer);
      global.clearTimeout(state.recoveryTimer);
      global.clearInterval(state.recoveryInterval);
    }

    function loadVideo(videoId) {
      if (!videoId) return;
      frame.dataset.currentVideoId = videoId;
      const src = buildEmbedUrl(videoId);
      if (frame.src !== src) frame.src = src;
      if (state.player && typeof state.player.loadVideoById === 'function') {
        try {
          state.player.loadVideoById(videoId);
        } catch (_) {
          frame.src = src;
        }
      }
    }

    function armNoPlayTimer() {
      global.clearTimeout(state.noPlayTimer);
      state.noPlayTimer = global.setTimeout(() => switchToFallback('no-playing-state'), config.noPlayMs);
    }

    function armBufferTimer() {
      global.clearTimeout(state.bufferTimer);
      state.bufferTimer = global.setTimeout(() => switchToFallback('buffering-timeout'), config.bufferMs);
    }

    function attemptNativeRecovery() {
      if (!state.player) return;
      try {
        if (typeof state.player.playVideo === 'function') state.player.playVideo();
      } catch (_) {}
    }

    function beginPrimaryRecovery() {
      if (!state.usedFallback || state.recovering || !state.primaryVideoId) return;
      state.recovering = true;
      state.recoverySuccesses = 0;
      clearTimers();
      loadVideo(state.primaryVideoId);
      armNoPlayTimer();
      state.recoveryInterval = global.setInterval(() => {
        if (!state.player || !state.recovering) return;
        let playerState = null;
        try { playerState = state.player.getPlayerState(); } catch (_) {}
        if (playerState === YT.PlayerState.PLAYING) {
          state.recoverySuccesses += 1;
          if (state.recoverySuccesses >= config.recoverySuccessesRequired) {
            state.usedFallback = false;
            state.recovering = false;
            clearTimers();
            delete frame.dataset.fallbackReason;
          }
        } else {
          state.recoverySuccesses = 0;
        }
      }, config.recoveryCheckMs);
    }

    function switchToFallback(reason) {
      if (state.usedFallback) return;
      state.usedFallback = true;
      state.recovering = false;
      frame.dataset.fallbackReason = reason || 'unknown';
      global.clearInterval(state.recoveryInterval);
      global.clearTimeout(state.recoveryTimer);
      global.clearTimeout(state.noPlayTimer);
      global.clearTimeout(state.bufferTimer);
      loadVideo(state.fallbackVideoId);
      state.recoveryTimer = global.setTimeout(beginPrimaryRecovery, config.fallbackHoldMs);
    }

    function applyFeed(feed) {
      const nextPrimary = feed.primaryVideoId || null;
      const nextFallback = feed.fallbackVideoId || state.fallbackVideoId;
      const primaryChanged = nextPrimary && nextPrimary !== state.primaryVideoId;
      const fallbackChanged = nextFallback !== state.fallbackVideoId;

      state.primaryVideoId = nextPrimary;
      state.fallbackVideoId = nextFallback;
      frame.dataset.primaryVideoId = nextPrimary || '';
      frame.dataset.fallbackVideoId = nextFallback || '';
      frame.dataset.feedStatus = feed.status || 'unknown';

      if (nextPrimary && primaryChanged && !state.usedFallback) {
        state.usedFallback = false;
        state.recovering = false;
        delete frame.dataset.fallbackReason;
        clearTimers();
        loadVideo(nextPrimary);
        armNoPlayTimer();
      } else if (!nextPrimary && fallbackChanged) {
        switchToFallback('no-primary-feed');
      }
    }

    async function fetchFeed() {
      const headers = config.feedAccept ? { Accept: config.feedAccept } : undefined;
      const response = await fetch(cacheBust(config.feedUrl), {
        cache: 'no-store',
        headers
      });
      if (!response.ok) throw new Error(`feed-http-${response.status}`);

      const feed = normaliseFeed(await response.json());
      if (!feed) throw new Error('feed-invalid');
      return feed;
    }

    async function refreshFeed() {
      if (state.refreshPromise) return state.refreshPromise;
      state.refreshPromise = (async () => {
        try {
          applyFeed(await fetchFeed());
        } catch (_) {
          return false;
        } finally {
          state.refreshPromise = null;
        }
        return true;
      })();
      return state.refreshPromise;
    }

    function createPlayer() {
      if (!global.YT || !YT.Player || state.player) return;

      state.player = new YT.Player(frame, {
        events: {
          onReady() {
            armNoPlayTimer();
            refreshFeed();
          },
          onStateChange(event) {
            if (event.data === YT.PlayerState.PLAYING) {
              if (!state.recovering && !state.usedFallback) clearTimers();
              return;
            }

            if (event.data === YT.PlayerState.BUFFERING) {
              attemptNativeRecovery();
              armBufferTimer();
              return;
            }

            if ([YT.PlayerState.UNSTARTED, YT.PlayerState.CUED].includes(event.data)) armNoPlayTimer();
            if (event.data === YT.PlayerState.ENDED) switchToFallback('ended');
          },
          onError: () => switchToFallback('youtube-error')
        }
      });
    }

    if (state.primaryVideoId) loadVideo(state.primaryVideoId);
    frame.dataset.fallbackVideoId = state.fallbackVideoId;

    if (global.YT && YT.Player) {
      createPlayer();
    } else {
      pendingPlayerInitializers.push(createPlayer);
    }

    refreshFeed();
    state.refreshTimer = global.setInterval(refreshFeed, config.refreshMs);

    return state;
  }

  function initYouTubeLiveEdge(options) {
    const config = Object.assign({
      frameId: null,
      videoId: null,
      checkMs: 30000,
      maxLagSeconds: 120,
      noProgressMs: 90000,
      seekOffsetSeconds: 3,
      correctionCooldownMs: 15000,
      recoveryGraceMs: 15000,
      hardRecoveryCooldownMs: 120000,
      metadataRetryMs: 3000,
      stateName: '__youtubeLiveEdgeState'
    }, options || {});

    let frame = document.getElementById(config.frameId);
    if (!frame || !config.videoId) return null;

    const state = {
      player: null,
      checkTimer: null,
      verificationTimer: null,
      metadataTimer: null,
      lastCurrentTime: 0,
      lastProgressAt: Date.now(),
      lastCorrectionAt: 0,
      lastHardRecoveryAt: 0,
      correctionCount: 0,
      hardRecoveryCount: 0,
      lastReason: null,
      lastHardRecoveryReason: null,
      lastMetrics: null
    };

    function readMetrics() {
      if (!state.player) return null;
      try {
        const currentTime = Number(state.player.getCurrentTime() || 0);
        const duration = Number(state.player.getDuration() || 0);
        const playerState = Number(state.player.getPlayerState());
        return {
          currentTime,
          duration,
          lagSeconds: duration > 0 ? duration - currentTime : null,
          playerState
        };
      } catch (_) {
        return null;
      }
    }

    function hardRecover(reason) {
      const now = Date.now();
      if (now - state.lastHardRecoveryAt < config.hardRecoveryCooldownMs) return false;

      state.lastHardRecoveryAt = now;
      state.hardRecoveryCount += 1;
      state.lastReason = reason || 'hard-recovery';
      state.lastHardRecoveryReason = state.lastReason;
      global.clearTimeout(state.verificationTimer);
      global.clearTimeout(state.metadataTimer);

      const replacement = frame.cloneNode(false);
      const url = new URL(buildEmbedUrl(config.videoId));
      url.searchParams.set('live_recovery', String(now));
      replacement.src = url.toString();
      replacement.dataset.liveEdgeReason = state.lastReason;
      frame.replaceWith(replacement);
      frame = replacement;
      state.player = null;
      state.lastCurrentTime = 0;
      state.lastProgressAt = now;
      global.setTimeout(createPlayer, 0);
      return true;
    }

    function verifyCorrection(reason) {
      global.clearTimeout(state.verificationTimer);
      state.verificationTimer = global.setTimeout(() => {
        const metrics = readMetrics();
        if (!metrics) {
          hardRecover(`${reason}-unreadable`);
          return;
        }

        const stillBehind = metrics.lagSeconds !== null && metrics.lagSeconds > config.maxLagSeconds;
        const notPlaying = global.YT && metrics.playerState !== YT.PlayerState.PLAYING;
        if (stillBehind || notPlaying) hardRecover(`${reason}-failed`);
      }, config.recoveryGraceMs);
    }

    function seekToLive(reason, force) {
      const now = Date.now();
      if (!state.player) return false;
      if (!force && now - state.lastCorrectionAt < config.correctionCooldownMs) return false;

      const metrics = readMetrics();
      if (!metrics || metrics.duration <= 0) {
        try {
          if (typeof state.player.playVideo === 'function') state.player.playVideo();
        } catch (_) {}
        global.clearTimeout(state.metadataTimer);
        state.metadataTimer = global.setTimeout(
          () => seekToLive(`${reason}-metadata-ready`, true),
          config.metadataRetryMs
        );
        return true;
      }

      try {
        if (typeof state.player.seekTo === 'function') {
          state.player.seekTo(Math.max(0, metrics.duration - config.seekOffsetSeconds), true);
        }
        if (typeof state.player.playVideo === 'function') state.player.playVideo();
      } catch (_) {
        return hardRecover(`${reason}-exception`);
      }

      state.lastCorrectionAt = now;
      state.correctionCount += 1;
      state.lastReason = reason || 'seek-live';
      frame.dataset.liveEdgeReason = state.lastReason;
      verifyCorrection(state.lastReason);
      return true;
    }

    function checkNow() {
      const now = Date.now();
      const metrics = readMetrics();
      state.lastMetrics = metrics;
      if (!metrics) return false;

      if (metrics.currentTime > state.lastCurrentTime + 0.25) {
        state.lastProgressAt = now;
      }
      state.lastCurrentTime = metrics.currentTime;

      if (metrics.lagSeconds !== null && metrics.lagSeconds > config.maxLagSeconds) {
        return seekToLive('behind-live-edge', false);
      }

      if (now - state.lastProgressAt >= config.noProgressMs) {
        return seekToLive('playback-stalled', false);
      }

      if (global.YT && metrics.playerState === YT.PlayerState.ENDED) {
        return hardRecover('stream-ended');
      }
      return false;
    }

    function createPlayer() {
      if (!global.YT || !YT.Player || state.player) return;
      state.player = new YT.Player(frame, {
        events: {
          onReady() {
            state.lastProgressAt = Date.now();
            seekToLive('player-ready', true);
          },
          onStateChange(event) {
            if (event.data === YT.PlayerState.PLAYING) checkNow();
            if (event.data === YT.PlayerState.ENDED) hardRecover('stream-ended');
          },
          onError: () => hardRecover('youtube-error')
        }
      });
    }

    frame.dataset.liveVideoId = config.videoId;
    const initialUrl = buildEmbedUrl(config.videoId);
    if (frame.src !== initialUrl) frame.src = initialUrl;

    const controller = {
      checkNow,
      jumpToLive: () => seekToLive('manual-live-edge', true),
      getState: () => ({
        correctionCount: state.correctionCount,
        hardRecoveryCount: state.hardRecoveryCount,
        lastReason: state.lastReason,
        lastHardRecoveryReason: state.lastHardRecoveryReason,
        metrics: readMetrics()
      })
    };
    global[config.stateName] = controller;

    if (global.YT && YT.Player) {
      createPlayer();
    } else {
      pendingPlayerInitializers.push(createPlayer);
    }
    state.checkTimer = global.setInterval(checkNow, config.checkMs);
    return controller;
  }

  global.initBrisbaneFeed = initBrisbaneFeed;
  global.initYouTubeLiveEdge = initYouTubeLiveEdge;
})(window);
