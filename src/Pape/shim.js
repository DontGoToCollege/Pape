// Injected into every page in a wallpaper window. Gives web wallpapers made for Wallpaper Engine the
// browser API they expect: user properties, audio bands, pause. Pape's own player page handles itself.
(() => {
  if (window.top !== window || location.host === 'app.pape.portable' || window.__pape) return;
  window.__pape = true;
  const wv = window.chrome && window.chrome.webview;
  if (!wv) return;

  const audio = [];
  let last = {}, general = false;
  window.wallpaperRegisterAudioListener = cb => {
    if (typeof cb === 'function') audio.push(cb);
    wv.postMessage({ type: 'audio' });
  };
  // Media integration, file properties: accepted and quiet for now.
  for (const name of ['wallpaperRegisterMediaStatusListener', 'wallpaperRegisterMediaPropertiesListener',
    'wallpaperRegisterMediaThumbnailListener', 'wallpaperRegisterMediaPlaybackListener',
    'wallpaperRegisterMediaTimelineListener', 'wallpaperRequestRandomFileForProperty'])
    if (!window[name]) window[name] = () => {};

  const safe = fn => { try { fn(); } catch (err) { console.error(err); } };

  wv.addEventListener('message', e => {
    const m = e.data, l = window.wallpaperPropertyListener;
    if (m.type === 'audio') {
      for (const cb of audio) safe(() => cb(m.data));
    } else if (m.type === 'props') {
      const p = m.props || {};
      const f = `brightness(${p.brightness ?? 1}) contrast(${p.contrast ?? 1}) saturate(${p.saturation ?? 1}) hue-rotate(${p.hue ?? 0}deg)`;
      document.documentElement.style.filter = f === 'brightness(1) contrast(1) saturate(1) hue-rotate(0deg)' ? '' : f;
      const user = m.user || {}, changed = {};
      for (const [k, v] of Object.entries(user))
        if (JSON.stringify(last[k]) !== JSON.stringify(v)) changed[k] = { value: v };
      last = user;
      if (l && l.applyGeneralProperties && !general) { general = true; safe(() => l.applyGeneralProperties({ fps: 60 })); }
      if (l && l.applyUserProperties && Object.keys(changed).length) safe(() => l.applyUserProperties(changed));
    } else if (m.type === 'paused') {
      if (l && l.setPaused) safe(() => l.setPaused(m.value));
      document.querySelectorAll('video,audio').forEach(v => m.value ? v.pause() : v.play().catch(() => {}));
    }
  });
})();
