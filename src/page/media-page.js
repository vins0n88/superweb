// Media helpers (page side), appended to the agent page script: list the page's
// audio/video, toggle playback, and open picture-in-picture.
(function installMedia() {
  const sw = window.__superweb;
  if (!sw || sw.mediaList) return;

  const mediaEls = () => [...document.querySelectorAll('video, audio')];
  const srcOf = (el) => el.currentSrc || el.src || el.querySelector('source[src]')?.src || '';

  /** Playable sources found on the page. blob:/MediaSource streams cannot be moved elsewhere, so they are only reported. */
  function mediaList() {
    return mediaEls().map((el, i) => {
      const src = srcOf(el);
      return {
        index: i,
        kind: el.tagName === 'VIDEO' ? 'video' : 'audio',
        src: /^https?:/i.test(src) ? src : '',
        streaming: /^blob:/i.test(src),
        title: (el.getAttribute('title') || el.getAttribute('aria-label') || document.title || '').slice(0, 120),
        playing: !el.paused,
        duration: Number.isFinite(el.duration) ? Math.round(el.duration) : null,
      };
    });
  }

  function mediaToggle(index = 0) {
    const el = mediaEls()[index];
    if (!el) throw new Error('這個頁面沒有影音');
    if (el.paused) el.play(); else el.pause();
    return !el.paused;
  }

  async function mediaPip(index) {
    const videos = mediaEls().filter((el) => el.tagName === 'VIDEO');
    const el = index != null ? mediaEls()[index] : videos.find((v) => !v.paused) || videos[0];
    if (!el || el.tagName !== 'VIDEO') throw new Error('這個頁面沒有影片');
    if (document.pictureInPictureElement === el) {
      await document.exitPictureInPicture();
      return false;
    }
    await el.requestPictureInPicture();
    return true;
  }

  Object.assign(sw, { mediaList, mediaToggle, mediaPip });
})();
