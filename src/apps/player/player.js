// Player page: playlist playback with shuffle/repeat/speed, plus controls for the
// media on the last web page you viewed.
const app = window.superwebApp;
const $ = (id) => document.getElementById(id);
const video = $('video');
let items = [];
let current = -1;
let shuffle = false;
let repeat = 'off'; // off | all | one
const REPEAT_LABEL = { off: '重複：關閉', all: '重複：全部', one: '重複：單曲' };

function show(err) {
  const box = $('now-meta');
  box.textContent = err;
  box.className = 'small error';
}

function renderList() {
  $('count').textContent = items.length ? `${items.length} 項` : '';
  const ul = $('playlist');
  if (!items.length) {
    ul.innerHTML = '<li class="empty">按「＋ 加入檔案」加入電腦裡的音樂或影片，或貼上影音網址。</li>';
    return;
  }
  ul.replaceChildren(...items.map((it, i) => {
    const li = document.createElement('li');
    if (i === current) li.className = 'current';
    const kind = Object.assign(document.createElement('span'), { className: 'kind', textContent: it.kind === 'audio' ? '♪' : '▶' });
    const title = Object.assign(document.createElement('span'), { className: `grow${it.missing ? ' muted' : ''}`, textContent: it.missing ? `${it.title}（找不到檔案）` : it.title });
    title.title = it.path || it.url;
    const btn = (label, tip, fn) => {
      const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: label, title: tip, type: 'button' });
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    li.append(kind, title,
      btn('↑', '上移', async () => setItems(await app.call('move', it.id, -1))),
      btn('↓', '下移', async () => setItems(await app.call('move', it.id, 1))),
      btn('×', '從清單移除', async () => setItems(await app.call('remove', it.id))));
    li.addEventListener('dblclick', () => play(i));
    li.addEventListener('click', () => play(i));
    return li;
  }));
}

function setItems(list) {
  const playingId = items[current]?.id;
  items = list;
  current = items.findIndex((x) => x.id === playingId);
  renderList();
}

function play(i) {
  const it = items[i];
  if (!it || it.missing || !it.src) return;
  current = i;
  video.src = it.src;
  video.playbackRate = Number($('rate').value);
  $('art').hidden = it.kind !== 'audio';
  document.querySelector('.stage').classList.toggle('audio', it.kind === 'audio');
  $('now-title').textContent = it.title;
  $('now-meta').textContent = it.kind === 'audio' ? '音樂' : '影片';
  $('now-meta').className = 'muted small';
  document.title = `▶ ${it.title}`;
  video.play().catch((err) => show(`無法播放：${err.message}`));
  renderList();
}

function step(dir) {
  if (!items.length) return;
  if (shuffle && items.length > 1) {
    let n;
    do n = Math.floor(Math.random() * items.length); while (n === current);
    return play(n);
  }
  const n = current + dir;
  if (n >= 0 && n < items.length) play(n);
  else if (repeat === 'all') play((n + items.length) % items.length);
}

video.addEventListener('ended', () => (repeat === 'one' ? play(current) : step(1)));
video.addEventListener('error', () => show('這個檔案無法播放（格式不支援或網址失效）'));
video.addEventListener('play', () => { $('play').textContent = '⏸'; });
video.addEventListener('pause', () => { $('play').textContent = '▶'; });

$('play').addEventListener('click', () => {
  if (current < 0) return play(0);
  if (video.paused) video.play(); else video.pause();
});
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('shuffle').addEventListener('click', (e) => { shuffle = !shuffle; e.currentTarget.classList.toggle('on', shuffle); });
$('repeat').addEventListener('click', (e) => {
  repeat = { off: 'all', all: 'one', one: 'off' }[repeat];
  e.currentTarget.title = REPEAT_LABEL[repeat];
  e.currentTarget.textContent = repeat === 'one' ? '🔂' : '🔁';
  e.currentTarget.classList.toggle('on', repeat !== 'off');
});
$('rate').addEventListener('change', () => { video.playbackRate = Number($('rate').value); });
$('pip').addEventListener('click', () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch((err) => show(err.message)));
$('pick').addEventListener('click', async () => setItems(await app.call('pick')));
$('clear').addEventListener('click', async () => setItems(await app.call('clear')));
$('url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    setItems(await app.call('addUrl', $('url').value.trim()));
    $('url').value = '';
  } catch (err) {
    show(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
  if (e.key === 'n' || e.key === 'N') step(1);
  if (e.key === 'p' || e.key === 'P') step(-1);
  if (e.key === 'ArrowRight') video.currentTime += 10;
  if (e.key === 'ArrowLeft') video.currentTime -= 10;
});

// ---- Media on the last web page ----
async function scan() {
  const ul = $('page-media');
  try {
    const { title, media } = await app.call('pageMedia');
    $('page-title').textContent = title ? `· ${title}` : '';
    if (!media.length) {
      ul.innerHTML = '<li class="empty">這個網頁沒有找到影音。</li>';
      return;
    }
    ul.replaceChildren(...media.map((m) => {
      const li = document.createElement('li');
      const label = Object.assign(document.createElement('span'), { className: 'grow', textContent: `${m.kind === 'video' ? '▶ 影片' : '♪ 音樂'}${m.playing ? '（播放中）' : ''} ${m.title}` });
      const btn = (text, fn, disabled = false) => {
        const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: text, type: 'button', disabled });
        b.addEventListener('click', async () => {
          try { await fn(); await scan(); } catch (err) { show(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
        });
        return b;
      };
      li.append(label,
        btn(m.playing ? '暫停' : '播放', () => app.call('pageToggle', m.index)),
        btn('子母畫面', () => app.call('pagePip', m.index), m.kind !== 'video'),
        btn('加入清單', async () => setItems(await app.call('addUrl', m.src, m.title, m.kind)), !m.src));
      return li;
    }));
  } catch (err) {
    ul.innerHTML = '';
    ul.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
  }
}
$('scan').addEventListener('click', scan);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });

setItems(await app.call('list'));
scan();
