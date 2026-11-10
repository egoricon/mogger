(() => {
  'use strict';

  // Прокси на Cloudflare Worker: кладёт фото в uploads/ репозитория. Токенов на фронте нет.
  const WORKER_URL = 'https://mog-scanner.egor-urbanovich.workers.dev';
  // При локальной разработке фото никуда не отправляются.
  const LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const TIERS = window.MOG_TIERS.map((t) => {
    const [idx, aura] = t.score.split(' • ');
    return { ...t, idx: parseFloat(idx), aura };
  });

  const CRIT = [
    { k: 'Jawline', n: 'Челюсть и гониальный угол', t: ['Прикладываем транспортир к челюсти', 'Замер гониального угла', 'Считаем, сколько воздуха режет подбородок'] },
    { k: 'Hunter Eyes', n: 'Взгляд и наклон канта', t: ['Замер наклона канта', 'Проверка взгляда охотника', 'Ищем лишнее верхнее веко'] },
    { k: 'Скулы', n: 'Проекция скуловой кости', t: ['Замер проекции скул', 'Проверяем, удержит ли скула чашку эспрессо', 'Ищем впалые щёки'] },
    { k: 'Симметрия', n: 'Золотое сечение лица', t: ['Сверка левой и правой половины', 'Накладываем золотое сечение', 'Делим лицо на трети'] },
    { k: 'Мьюинг', n: 'Стрик языка на нёбе', t: ['Проверка стрика мьюинга', 'Ищем язык на нёбе', 'Считаем дни без дыхания ртом'] },
    { k: 'Rizz', n: 'Невербальный ризз', t: ['Замер невербального ризза', 'Ловим харизму по Bluetooth', 'Оценка приподнятой брови'] },
    { k: 'Аура', n: 'Суммарное поле ауры', t: ['Замер квантового поля ауры', 'Сверка с базой гигачадов', 'Считаем очки ауры'] },
  ];

  const SCAN_STEPS = [
    'Калибровка биометрической сетки',
    'Замер наклона канта',
    'Расчёт гониального угла челюсти',
    'Проверка стрика мьюинга',
    'Детекция взгляда охотника',
    'Замер проекции скул',
    'Анализ поля ризза и ауры',
    'Сверка с базой гигачадов и сигм',
  ];

  let busy = false;
  let fast = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));

  // ── звук ──
  let muted = false;
  try { muted = localStorage.getItem('mog_muted') === '1'; } catch {}
  let ac;
  function tone(f, d, type = 'square', v = 0.04, to) {
    if (muted) return;
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + d);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + d);
    } catch {}
  }
  const sfx = {
    tick: () => tone(880 + Math.random() * 300, 0.03, 'square', 0.015),
    step: () => tone(520, 0.06, 'square', 0.03),
    win: () => { tone(660, 0.09, 'triangle', 0.07); setTimeout(() => tone(990, 0.16, 'triangle', 0.07), 90); },
    slam: () => tone(160, 0.35, 'sawtooth', 0.12, 40),
    boom: () => { tone(110, 0.9, 'sine', 0.5, 28); tone(70, 0.5, 'sawtooth', 0.18, 30); },
  };
  const soundBtn = $('#soundBtn');
  function paintSound() {
    soundBtn.textContent = muted ? 'Звук: выкл' : 'Звук: вкл';
    soundBtn.setAttribute('aria-pressed', String(!muted));
  }
  soundBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('mog_muted', muted ? '1' : '0'); } catch {}
    paintSound();
    sfx.step();
  });
  paintSound();

  // ── мелочи UI ──
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3200);
  }

  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function count(el, to, dur, dec = 0) {
    return new Promise((res) => {
      const t0 = performance.now();
      let lastTick = 0;
      (function step() {
        const t = performance.now();
        const p = fast ? 1 : Math.min(1, (t - t0) / dur);
        el.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(dec);
        if (p >= 1) { el.textContent = to.toFixed(dec); return res(); }
        if (t - lastTick > 70) { lastTick = t; sfx.tick(); }
        setTimeout(step, 16);
      })();
    });
  }

  // ── фото: сжатие, отпечаток, профиль ──
  function readImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
      img.src = url;
    });
  }

  async function loadPhoto(file) {
    const src = await readImage(file);
    const k = Math.min(1, 1080 / src.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(src.width * k);
    canvas.height = Math.round(src.height * k);
    canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);

    // Отпечаток по уменьшенной копии: одно и то же фото всегда даёт один и тот же результат.
    const s = document.createElement('canvas');
    s.width = s.height = 24;
    const sx = s.getContext('2d', { willReadFrequently: true });
    sx.drawImage(src, 0, 0, 24, 24);
    const d = sx.getImageData(0, 0, 24, 24).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4) {
      for (let j = 0; j < 3; j++) { h ^= d[i + j] >> 3; h = Math.imul(h, 16777619); }
    }
    return { canvas, dataUrl: canvas.toDataURL('image/jpeg', 0.84), hash: h >>> 0, name: file.name || 'photo.jpg', sent: false };
  }

  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function profile(hash) {
    const rnd = mulberry32(hash);
    const tier = TIERS[Math.floor(rnd() * TIERS.length)];
    const stats = CRIT.map(() => clamp(Math.round(tier.idx + (rnd() - 0.5) * 34), 1, 100));
    return { tier, stats };
  }

  function tierColor(idx) {
    return idx >= 80 ? 'var(--lime)' : idx >= 50 ? 'var(--ice)' : idx >= 25 ? 'var(--amber)' : 'var(--red)';
  }
  const HEX = { 'var(--lime)': '#c8ff2e', 'var(--ice)': '#5ee6ff', 'var(--amber)': '#ffb020', 'var(--red)': '#ff2440' };

  function upload(photo, tag) {
    if (LOCAL || photo.sent) return;
    photo.sent = true;
    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: photo.dataUrl.split(',')[1], filename: `${tag}_${photo.name}` }),
    }).catch(() => {});
  }

  // ── слот для фото ──
  function makeSlot(el, onPhoto) {
    el.innerHTML = `
      <input type="file" accept="image/*" hidden>
      <div class="slot-empty">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 16V6h10M32 6h10v10M42 32v10H32M16 42H6V32"/><circle cx="24" cy="21" r="6"/><path d="M13 37c2-6 6-8 11-8s9 2 11 8"/></svg>
        <b></b><i></i>
      </div>
      <img alt="">
      <div class="fx"><div class="fx-grid"></div><div class="fx-laser"></div></div>
      <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
      <div class="tag">Моггер</div>
      <div class="stamp">MOGGED</div>`;
    $('b', el).textContent = el.dataset.label;
    $('i', el).textContent = el.dataset.hint;
    const input = $('input', el);
    const img = $('img', el);
    const slot = {
      el, input, photo: null,
      set(photo) {
        slot.photo = photo;
        img.src = photo ? photo.dataUrl : '';
        el.classList.toggle('has', !!photo);
      },
      lock(on) { input.disabled = on; el.classList.toggle('locked', on); },
    };
    async function take(file) {
      if (!file || busy) return;
      if (!file.type.startsWith('image/')) return toast('Это не картинка. Нужен JPG, PNG или WEBP.');
      try {
        const photo = await loadPhoto(file);
        slot.set(photo);
        onPhoto(photo);
      } catch {
        toast('Не получилось прочитать фото. Попробуй JPG или PNG.');
      }
    }
    input.addEventListener('change', () => { take(input.files[0]); input.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); take(e.dataTransfer.files[0]); });
    return slot;
  }

  // ── режимы ──
  const views = { scan: $('#scanView'), battle: $('#battleView') };
  function setMode(mode) {
    if (busy) return;
    document.body.dataset.mode = mode;
    for (const [k, v] of Object.entries(views)) v.hidden = k !== mode;
    $$('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    window.scrollTo({ top: 0 });
  }
  $$('.modes button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); sfx.step(); }));

  // ═════════════ СКАНЕР ═════════════
  const scanSlot = makeSlot($('#scanSlot'), runScan);
  const scanHud = $('#scanHud');
  const scanResult = $('#scanResult');
  let scanProfile = null;

  async function runScan(photo) {
    busy = true;
    fast = false;
    scanSlot.lock(true);
    scanResult.hidden = true;
    scanHud.hidden = false;
    scanSlot.el.classList.add('scanning');
    upload(photo, 'scan');
    sfx.slam();

    for (let i = 0; i < SCAN_STEPS.length; i++) {
      const pct = Math.round(((i + 1) / SCAN_STEPS.length) * 100);
      $('#scanTele').textContent = SCAN_STEPS[i] + '…';
      $('#scanPct').textContent = pct + '%';
      $('#scanBar').style.width = pct + '%';
      sfx.step();
      await sleep(440);
    }

    scanSlot.el.classList.remove('scanning');
    scanHud.hidden = true;
    $('#scanBar').style.width = '0';
    scanSlot.lock(false);
    busy = false;
    scanProfile = profile(photo.hash);
    renderScan(scanProfile);
  }

  function renderScan({ tier, stats }) {
    scanResult.style.setProperty('--c', tierColor(tier.idx));
    $('#resBadge').textContent = tier.badge;
    $('#resTitle').textContent = tier.title;
    $('#resAura').textContent = tier.aura;
    $('#resDesc').textContent = tier.description;
    $('#resTips').replaceChildren(...tier.recommendations.map((r) => Object.assign(document.createElement('li'), { textContent: r })));

    const bars = $('#resBars');
    bars.replaceChildren(...CRIT.map((c, i) => {
      const row = document.createElement('div');
      row.innerHTML = `<div class="bar-top"><span></span><b></b></div><div class="bar-track"><i></i></div>`;
      $('span', row).textContent = `${c.k} · ${c.n}`;
      $('b', row).textContent = stats[i];
      return row;
    }));

    scanResult.hidden = false;
    replay(scanResult, 'result');
    setTimeout(() => $$('.bar-track i', bars).forEach((b, i) => {
      b.style.transitionDelay = i * 70 + 'ms';
      b.style.width = stats[i] + '%';
    }), 60);
    tier.idx >= 50 ? sfx.win() : sfx.slam();
    count($('#resIdx'), tier.idx, 900, tier.idx % 1 ? (String(tier.idx).split('.')[1] || '').length : 0);
    scanResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#rescanBtn').addEventListener('click', () => scanSlot.input.click());
  $('#toBattleBtn').addEventListener('click', () => {
    if (!scanSlot.photo) return;
    resetBattle();
    F[0].slot.set(scanSlot.photo);
    setMode('battle');
    refreshFight();
    toast('Фото уже в углу бойца 1. Добавь соперника.');
  });
  $('#shareScanBtn').addEventListener('click', () => scanSlot.photo && scanProfile && shareCard(drawScanCard));

  // ═════════════ AURA BATTLE ═════════════
  const arena = $('#arena');
  const roundBox = $('#round');
  const fightBtn = $('#fightBtn');
  const skipBtn = $('#skipBtn');
  const finalBox = $('#final');
  const logBox = $('#log');
  const pips = $('#pips');
  let battle = null; // итог последнего баттла — для карточки

  const F = $$('.fighter').map((el, i) => ({
    el,
    slot: makeSlot($('.slot', el), () => { resetBattle(); refreshFight(); sfx.step(); }),
    nameEl: $('.fname', el),
    val: $('.fval', el),
    tierEl: $('.ftier', el),
    get name() { return this.nameEl.value.trim() || `Боец ${i + 1}`; },
  }));

  function refreshFight() {
    fightBtn.disabled = !(F[0].slot.photo && F[1].slot.photo);
  }

  function resetBattle() {
    battle = null;
    arena.classList.remove('live', 'shake');
    for (const f of F) {
      f.el.classList.remove('active', 'wait', 'won', 'lost');
      f.slot.el.classList.remove('mogged', 'champ', 'scanning');
      f.val.textContent = '—';
      f.tierEl.hidden = true;
    }
    roundBox.hidden = finalBox.hidden = logBox.hidden = skipBtn.hidden = true;
    fightBtn.hidden = false;
  }

  function setRound(num, name, sub) {
    $('#rNum').textContent = num;
    $('#rName').textContent = name;
    $('#rSub').textContent = sub;
    replay($('#rName'), 'in');
  }

  async function fight() {
    const photos = F.map((f) => f.slot.photo);
    if (!photos[0] || !photos[1] || busy) return;
    if (photos[0].hash === photos[1].hash) return toast('Это одно и то же фото. Сам себя не замоггаешь.');

    busy = true;
    fast = false;
    resetBattle();
    const P = photos.map((p) => profile(p.hash));
    const names = F.map((f) => f.name);
    const wins = [0, 0];
    photos.forEach((p) => upload(p, 'battle'));
    F.forEach((f) => { f.slot.lock(true); f.nameEl.disabled = true; });

    pips.replaceChildren(...CRIT.map(() => document.createElement('i')));
    $('#rScore').textContent = '0 : 0';
    $('#logRows').replaceChildren();
    $('#logN0').textContent = names[0];
    $('#logN1').textContent = names[1];
    fightBtn.hidden = true;
    skipBtn.hidden = roundBox.hidden = false;

    // интро
    arena.classList.add('live');
    setRound('Подготовка', `${names[0]} vs ${names[1]}`, 'Синхронизация аур. Бойцы, держите язык на нёбе.');
    F.forEach((f) => f.slot.el.classList.add('scanning'));
    sfx.slam();
    roundBox.scrollIntoView({ behavior: 'smooth', block: 'end' });
    await sleep(1700);
    F.forEach((f) => f.slot.el.classList.remove('scanning'));

    // раунды: бойцы сканируются по очереди
    for (let r = 0; r < CRIT.length; r++) {
      const c = CRIT[r];
      const v = [P[0].stats[r], P[1].stats[r]];
      if (v[0] === v[1]) {
        const up = photos[0].hash > photos[1].hash ? 0 : 1;
        v[up] < 100 ? v[up]++ : v[1 - up]--;
      }
      F.forEach((f) => { f.val.textContent = '—'; });
      setRound(`Раунд ${r + 1}/${CRIT.length}`, c.k, c.n);
      sfx.slam();
      await sleep(500);

      for (const s of r % 2 ? [1, 0] : [0, 1]) {
        F[s].el.classList.add('active');
        F[1 - s].el.classList.add('wait');
        F[s].slot.el.classList.add('scanning');
        $('#rSub').textContent = `${names[s]}: ${pick(c.t).toLowerCase()}…`;
        await sleep(150);
        await count(F[s].val, v[s], 650);
        F[s].el.classList.remove('active');
        F[1 - s].el.classList.remove('wait');
        F[s].slot.el.classList.remove('scanning');
        await sleep(120);
      }

      const w = v[0] > v[1] ? 0 : 1;
      const gap = Math.abs(v[0] - v[1]);
      wins[w]++;
      F[w].el.classList.add('won');
      F[1 - w].el.classList.add('lost');
      pips.children[r].dataset.w = w;
      $('#rScore').textContent = `${wins[0]} : ${wins[1]}`;
      $('#rSub').textContent = gap >= 30 ? `Разгром. ${names[w]} забирает раунд без шансов.`
        : gap <= 3 ? `На тоненького: раунд за ${names[w]}.`
          : pick([`Раунд за ${names[w]}.`, `${names[w]} забирает раунд.`, `Очко уходит в угол ${names[w]}.`]);
      sfx.win();

      const row = document.createElement('div');
      row.className = 'log-row';
      row.innerHTML = '<span></span><span></span><span></span>';
      row.children[0].textContent = c.k;
      row.children[1].textContent = v[0];
      row.children[2].textContent = v[1];
      row.children[w + 1].className = 'w' + w;
      $('#logRows').append(row);
      logBox.hidden = false;

      await sleep(900);
      F.forEach((f) => f.el.classList.remove('won', 'lost'));
    }

    // финал
    F.forEach((f) => { f.val.textContent = '—'; f.slot.el.classList.add('scanning'); });
    setRound('Финал', 'Подсчёт ауры', 'Сканер выносит вердикт…');
    for (let i = 0; i < 12 && !fast; i++) { sfx.tick(); await sleep(110); }
    F.forEach((f) => f.slot.el.classList.remove('scanning'));

    const W = wins[0] > wins[1] ? 0 : 1;
    const L = 1 - W;
    fast = false;
    F[L].slot.el.classList.add('mogged');
    F[W].slot.el.classList.add('champ');
    replay(arena, 'shake');
    replay($('#flash'), 'on');
    sfx.boom();
    F.forEach((f, i) => { f.val.textContent = wins[i]; });
    F[W].el.classList.add('won');
    F[L].el.classList.add('lost');
    setRound('Финал', `${names[L]} — mogged`, `Счёт по раундам ${wins[W]}:${wins[L]} в пользу ${names[W]}.`);
    await sleep(900);

    F.forEach((f, i) => {
      const t = P[i].tier;
      f.tierEl.innerHTML = '<span class="badge"></span><b></b><i></i>';
      f.tierEl.style.setProperty('--c', i === W ? 'var(--lime)' : 'var(--red)');
      f.tierEl.children[0].textContent = t.badge;
      f.tierEl.children[1].textContent = t.title;
      f.tierEl.children[2].textContent = t.aura;
      f.tierEl.hidden = false;
    });

    const w = names[W], l = names[L];
    const head = $('#fHead');
    head.replaceChildren(`${w} `, Object.assign(document.createElement('mark'), { textContent: 'моггает' }), ` ${l} — ${wins[W]}:${wins[L]}`);
    $('#fRoast').textContent = wins[L] === 0 ? `Семь из семи. ${l} теперь официально фон для ${w} на общих фото.`
      : wins[W] - wins[L] === 1 ? `Разница в один раунд. ${l} требует реванш, другое освещение и зум 2x.`
        : pick([
          `${l} уходит в зимнюю арку. Возвращайся через 60 дней мьюинга, воды и сна.`,
          `Аура ${l} списана в ноль. Со стороны ${w} — ни одного лишнего движения челюстью.`,
          `${l}, сканер советует не вставать рядом с ${w} на общих фото. Фрейм-моггинг гарантирован.`,
        ]);

    battle = { photos, names, wins, W, L };
    skipBtn.hidden = true;
    finalBox.hidden = false;
    F.forEach((f) => { f.slot.lock(false); f.nameEl.disabled = false; });
    busy = false;
    finalBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  fightBtn.addEventListener('click', fight);
  skipBtn.addEventListener('click', () => { fast = true; });
  $('#rematchBtn').addEventListener('click', () => {
    resetBattle();
    F.forEach((f) => { f.slot.set(null); f.nameEl.value = ''; });
    refreshFight();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#shareBattleBtn').addEventListener('click', () => battle && shareCard(drawBattleCard));

  // ═════════════ КАРТОЧКИ ДЛЯ ШЕРИНГА ═════════════
  const CW = 1080, CH = 1350;
  const SITE = 'egoricon.github.io/mogger';

  function cover(x, src, dx, dy, dw, dh) {
    const k = Math.max(dw / src.width, dh / src.height);
    const sw = dw / k, sh = dh / k;
    x.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, dx, dy, dw, dh);
  }

  function wrap(x, text, cx, y, maxW, lh, maxLines = 3) {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      const probe = line ? line + ' ' + word : word;
      if (x.measureText(probe).width > maxW && line) { lines.push(line); line = word; } else line = probe;
    }
    lines.push(line);
    lines.slice(0, maxLines).forEach((l, i) => x.fillText(l, cx, y + i * lh, maxW));
    return y + Math.min(lines.length, maxLines) * lh;
  }

  function drawScanCard(x) {
    const { tier } = scanProfile;
    const c = HEX[tierColor(tier.idx)];
    cover(x, scanSlot.photo.canvas, 0, 0, CW, 780);
    const g = x.createLinearGradient(0, 480, 0, 780);
    g.addColorStop(0, 'rgba(10,10,11,0)');
    g.addColorStop(1, '#0a0a0b');
    x.fillStyle = g;
    x.fillRect(0, 480, CW, 300);

    x.textBaseline = 'alphabetic';
    x.font = '700 30px "JetBrains Mono"';
    const bw = Math.min(x.measureText(tier.badge.toUpperCase()).width, CW - 160) + 36;
    x.fillStyle = c;
    x.fillRect(60, 770, bw, 58);
    x.fillStyle = '#0a0a0b';
    x.fillText(tier.badge.toUpperCase(), 78, 810, CW - 160);

    x.fillStyle = '#f3f2ec';
    x.font = '900 52px Unbounded';
    const y = wrap(x, tier.title, 60, 912, CW - 120, 64);

    x.fillStyle = c;
    x.font = '900 150px Unbounded';
    x.fillText(String(tier.idx), 60, y + 130, CW - 320);
    const iw = Math.min(x.measureText(String(tier.idx)).width, CW - 320);
    x.fillStyle = '#908f99';
    x.font = '500 34px "JetBrains Mono"';
    x.fillText('/ 100', 60 + iw + 22, y + 130);
    x.fillStyle = c;
    x.font = '700 34px "JetBrains Mono"';
    x.fillText(tier.aura, 60, y + 190, CW - 120);
  }

  function drawBattleCard(x) {
    const { photos, names, wins, W, L } = battle;
    const pw = 480, ph = 600, py = 170, px = [50, 550];
    x.textAlign = 'center';
    x.fillStyle = '#f3f2ec';
    x.font = '900 60px Unbounded';
    x.fillText('AURA BATTLE', CW / 2, 110);

    photos.forEach((p, i) => {
      x.save();
      if (i === L) x.filter = 'grayscale(1)';
      cover(x, p.canvas, px[i], py, pw, ph);
      x.restore();
      if (i === L) {
        x.fillStyle = 'rgba(10,10,11,.5)';
        x.fillRect(px[i], py, pw, ph);
        x.fillStyle = 'rgba(255,36,64,.22)';
        x.fillRect(px[i], py, pw, ph);
      }
      x.lineWidth = 6;
      x.strokeStyle = i === W ? '#c8ff2e' : '#ff2440';
      x.strokeRect(px[i], py, pw, ph);
      x.fillStyle = i === W ? '#c8ff2e' : '#908f99';
      x.font = '500 36px Unbounded';
      x.fillText(names[i].toUpperCase(), px[i] + pw / 2, py + ph + 62, pw);
    });

    // штамп на проигравшем
    x.save();
    x.translate(px[L] + pw / 2, py + ph / 2);
    x.rotate(-0.24);
    x.font = '900 84px Unbounded';
    const sw = x.measureText('MOGGED').width + 56;
    x.fillStyle = 'rgba(10,10,11,.45)';
    x.fillRect(-sw / 2, -70, sw, 136);
    x.strokeStyle = '#ff2440';
    x.lineWidth = 9;
    x.strokeRect(-sw / 2, -70, sw, 136);
    x.fillStyle = '#ff2440';
    x.fillText('MOGGED', 0, 30);
    x.restore();

    // плашка победителя
    x.font = '900 30px Unbounded';
    const tw = x.measureText('МОГГЕР').width + 40;
    x.fillStyle = '#c8ff2e';
    x.fillRect(px[W] + pw / 2 - tw / 2, py - 2, tw, 54);
    x.fillStyle = '#0a0a0b';
    x.fillText('МОГГЕР', px[W] + pw / 2, py + 37);

    x.fillStyle = '#f3f2ec';
    x.font = '900 170px Unbounded';
    x.fillText(`${wins[0]} : ${wins[1]}`, CW / 2, 1040);
    x.font = '900 46px Unbounded';
    wrap(x, `${names[W]} моггает ${names[L]}`.toUpperCase(), CW / 2, 1140, CW - 120, 58, 2);
    x.textAlign = 'left';
  }

  async function shareCard(draw) {
    try {
      await Promise.all(['900 50px Unbounded', '500 50px Unbounded', '700 30px "JetBrains Mono"', '500 30px "JetBrains Mono"']
        .map((f) => document.fonts.load(f, 'Aя'))).catch(() => {});
      const canvas = document.createElement('canvas');
      canvas.width = CW;
      canvas.height = CH;
      const x = canvas.getContext('2d');
      x.fillStyle = '#0a0a0b';
      x.fillRect(0, 0, CW, CH);
      draw(x);
      x.textAlign = 'left';
      x.fillStyle = '#908f99';
      x.font = '500 26px "JetBrains Mono"';
      x.fillText(SITE, 60, CH - 44);
      x.textAlign = 'right';
      x.fillStyle = '#c8ff2e';
      x.font = '900 28px Unbounded';
      x.fillText('MOGGER', CW - 60, CH - 44);

      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const file = new File([blob], 'mogger.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ files: [file] }).catch(() => {});
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mogger.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      toast('Не получилось собрать карточку.');
    }
  }

})();
