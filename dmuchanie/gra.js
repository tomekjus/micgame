/* Dmuchnij i wygraj - prototyp Instant Win sterowanego mikrofonem.
 *
 * Parametry URL (do testów):
 *   ?motyw=owoce|balony    motyw startowy
 *   ?szansa=0.3            prawdopodobieństwo wygranej (0-1)
 *   ?wynik=wygrana|przegrana  wymuszony wynik
 *   ?czulosc=1             mnożnik czułości mikrofonu (np. 0.5 - mniej czuły, 2 - bardziej)
 *   ?czas=3                ile sekund pełnego dmuchania ładuje energię do końca
 *   ?debug=1               podgląd poziomów mikrofonu
 */
(() => {
  'use strict';

  const P = new URLSearchParams(location.search);
  const cfg = {
    motyw: P.get('motyw') === 'balony' ? 'balony' : 'owoce',
    szansa: clamp(parseFloat(P.get('szansa') ?? '0.3'), 0, 1),
    wynik: P.get('wynik'),
    czulosc: Math.max(0.1, parseFloat(P.get('czulosc') ?? '1') || 1),
    czas: Math.max(0.5, parseFloat(P.get('czas') ?? '3') || 3),
    debug: P.has('debug'),
  };

  const $ = (id) => document.getElementById(id);
  const canvas = $('scena');
  const ctx = canvas.getContext('2d');

  // ---------- Stan ----------
  let W = 0, H = 0, DPR = 1;
  let stan = 'start';          // start | kalibracja | gra | final | wynik
  let elementy = [];
  let wybrany = 0;             // indeks elementu, który spadnie / odleci
  let lecacy = null;           // oderwany element w finale
  let czastki = [];            // konfetti, odłamki balonu
  let smugi = [];              // smugi wiatru
  let chmury = [];
  let energia = 0;
  let sila = 0;                // wygładzona siła dmuchania 0..1
  let przytrzymany = false;
  let czasGry = 0;
  let czasFinalu = 0;
  let wygrana = false;

  // ---------- Mikrofon ----------
  let audioCtx = null, analyser = null, bufor = null, strumien = null;
  let rms = 0, poziomCiszy = 0.01;
  let probkiCiszy = [];
  let czasKalibracji = 0;
  const CZAS_KALIBRACJI = 1.5;

  async function wlaczMikrofon() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Mikrofon wymaga połączenia HTTPS.');
    }
    // AudioContext tworzymy w obsłudze kliknięcia, inaczej iOS go nie uruchomi
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    strumien = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const zrodlo = audioCtx.createMediaStreamSource(strumien);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    bufor = new Float32Array(analyser.fftSize);
    // Wyciszone połączenie z wyjściem - niektóre przeglądarki inaczej nie przetwarzają grafu
    const cisza = audioCtx.createGain();
    cisza.gain.value = 0;
    zrodlo.connect(analyser);
    analyser.connect(cisza);
    cisza.connect(audioCtx.destination);
  }

  function odczytajMikrofon() {
    if (!analyser) { rms = 0; return; }
    analyser.getFloatTimeDomainData(bufor);
    let suma = 0;
    for (let i = 0; i < bufor.length; i++) suma += bufor[i] * bufor[i];
    rms = Math.sqrt(suma / bufor.length);
  }

  function silaZMikrofonu() {
    if (!analyser) return 0;
    const prog = poziomCiszy * 2.5 + 0.004;
    const zakres = 0.12 / cfg.czulosc;
    return clamp((rms - prog) / zakres, 0, 1);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioCtx?.state === 'suspended') audioCtx.resume();
  });

  // ---------- Układ sceny ----------
  const OWOCE = [
    { typ: 'jablko', kolor: ['#ff8a80', '#e53935', '#8e1b16'] },
    { typ: 'pomarancza', kolor: ['#ffd180', '#fb8c00', '#a85a00'] },
    { typ: 'gruszka', kolor: ['#f4ff81', '#c0ca33', '#6b7a12'] },
    { typ: 'sliwka', kolor: ['#d1a3ff', '#7b1fa2', '#3d0d55'] },
    { typ: 'cytryna', kolor: ['#ffff8d', '#fdd835', '#a68f00'] },
  ];
  const BALONY = [
    ['#ff8a80', '#e53935', '#8e1b16'],
    ['#ffe57f', '#ffb300', '#a06d00'],
    ['#82b1ff', '#2962ff', '#0d2b80'],
    ['#b9f6ca', '#00c853', '#006b2c'],
    ['#ff80ab', '#f50057', '#8a0031'],
  ];

  function wysokoscGalezi(x) {
    const t = (x - W / 2) / (W / 2);
    return H * 0.1 + H * 0.04 * (1 - t * t);
  }

  function zbudujScene() {
    const n = 5;
    const r = Math.min(W * 0.075, H * 0.045, 40);
    elementy = [];
    if (cfg.motyw === 'owoce') {
      const dlugosci = [0.2, 0.3, 0.16, 0.26, 0.22];
      for (let i = 0; i < n; i++) {
        const ax = W * (0.14 + 0.72 * i / (n - 1));
        elementy.push({
          ax, ay: wysokoscGalezi(ax),
          dir: 1, Lpx: H * dlugosci[i], Lm: dlugosci[i] * 2,
          r: r * (OWOCE[i].typ === 'sliwka' ? 0.85 : 1),
          off: 0, theta0: 0,
          theta: (Math.random() - 0.5) * 0.1, omega: 0,
          G: 9.8, wiatr: 34,
          f: 0.8 + Math.random() * 0.6, faza: Math.random() * 6.28,
          ...OWOCE[i],
        });
        elementy[i].off = elementy[i].r;
      }
    } else {
      const ax = W / 2, ay = H * 0.72;
      const dlugosci = [0.32, 0.42, 0.48, 0.4, 0.3];
      const katy = [-0.5, -0.24, 0, 0.24, 0.5];
      for (let i = 0; i < n; i++) {
        const rb = r * 1.25;
        elementy.push({
          ax, ay, dir: -1,
          Lpx: H * dlugosci[i], Lm: dlugosci[i] * 2,
          r: rb, off: rb * 1.15, theta0: katy[i],
          theta: katy[i], omega: 0,
          G: 4.5, wiatr: 14,
          f: 0.7 + Math.random() * 0.5, faza: Math.random() * 6.28,
          typ: 'balon', kolor: BALONY[i],
        });
      }
    }
    if (!chmury.length) {
      for (let i = 0; i < 4; i++) {
        chmury.push({ x: Math.random(), y: 0.05 + Math.random() * 0.35, s: 0.6 + Math.random() * 0.8, v: 0.004 + Math.random() * 0.008 });
      }
    }
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    if (stan !== 'final' && stan !== 'wynik') zbudujScene();
  }
  window.addEventListener('resize', resize);

  // ---------- Fizyka ----------
  function pozycja(e) {
    const ux = Math.sin(e.theta), uy = e.dir * Math.cos(e.theta);
    const d = e.Lpx + e.off;
    return { x: e.ax + ux * d, y: e.ay + uy * d, ux, uy, ex: e.ax + ux * e.Lpx, ey: e.ay + uy * e.Lpx };
  }

  function krokWahadla(e, dt, t, s) {
    // Porywisty wiatr: średnio w prawo, ale z wahaniami, żeby elementy się bujały
    const porywy = 0.55 + 0.75 * Math.sin(t * 2.4 * e.f + e.faza) + 0.35 * Math.sin(t * 5.3 * e.f + e.faza * 2);
    const bryza = 0.04 * Math.sin(t * 0.9 + e.faza);
    let a = -(e.G / e.Lm) * Math.sin(e.theta - e.theta0)
            - 1.1 * e.omega
            + e.wiatr * (s * porywy + bryza) * Math.cos(e.theta);
    // Wybrany element drży, gdy energia jest blisko końca
    if (stan === 'gra' && e === elementy[wybrany] && energia > 0.7) {
      a += (Math.random() - 0.5) * 120 * (energia - 0.7);
    }
    e.omega += a * dt;
    e.theta += e.omega * dt;
    const max = e.dir > 0 ? 2.2 : 1.35;
    if (e.theta > max) { e.theta = max; e.omega *= -0.3; }
    if (e.theta < -max) { e.theta = -max; e.omega *= -0.3; }
  }

  function oderwij(e) {
    const p = pozycja(e);
    const d = e.Lpx + e.off;
    lecacy = {
      e, x: p.x, y: p.y,
      vx: d * e.omega * Math.cos(e.theta),
      vy: -e.dir * d * e.omega * Math.sin(e.theta),
      rot: Math.atan2(p.uy, p.ux) - e.dir * Math.PI / 2,
      vrot: e.omega * 0.8,
      odbicia: 0, spoczynek: 0,
    };
  }

  function krokLecacego(dt) {
    const L = lecacy;
    if (!L || L.koniec) return;
    const e = L.e;
    if (e.typ === 'balon') {
      L.vy -= 700 * dt;
      L.vx *= Math.pow(0.4, dt);
      L.vx += Math.sin(czasFinalu * 3) * 60 * dt;
      L.vrot += (-L.rot * 3 - L.vrot * 1.5) * dt;
      if (L.y < H * 0.3) { pekniecie(L.x, L.y, e.kolor); L.koniec = true; pokazWynikZa(0.45); }
    } else {
      L.vy += 2200 * dt;
      const ziemia = H * 0.86;
      if (L.y + e.r >= ziemia) {
        L.y = ziemia - e.r;
        if (Math.abs(L.vy) < 120 || L.odbicia >= 2) {
          L.vy = 0; L.vx *= Math.pow(0.02, dt); L.vrot = L.vx / e.r;
          L.spoczynek += dt;
          if (L.spoczynek > 0.4) { L.koniec = true; pokazWynikZa(0.1); }
        } else {
          L.vy = -L.vy * 0.38; L.vx *= 0.6; L.vrot = L.vx / e.r; L.odbicia++;
          if (navigator.vibrate) navigator.vibrate(30);
        }
      }
    }
    L.x += L.vx * dt;
    L.y += L.vy * dt;
    L.rot += L.vrot * dt;
    L.x = clamp(L.x, e.r, W - e.r);
  }

  // ---------- Cząstki ----------
  function pekniecie(x, y, kolor) {
    if (navigator.vibrate) navigator.vibrate([40, 30, 60]);
    for (let i = 0; i < 26; i++) {
      const k = Math.random() * Math.PI * 2, v = 200 + Math.random() * 500;
      czastki.push({ x, y, vx: Math.cos(k) * v, vy: Math.sin(k) * v, g: 900, zycie: 0.9, max: 0.9,
        kolor: kolor[1], w: 6 + Math.random() * 10, h: 4 + Math.random() * 6, rot: k, vrot: (Math.random() - 0.5) * 20 });
    }
  }

  function konfetti() {
    const kolory = ['#ff5a3c', '#ffd23c', '#3c9dff', '#6cd36c', '#ff80ab', '#b388ff'];
    for (let i = 0; i < 140; i++) {
      czastki.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.4,
        vx: (Math.random() - 0.5) * 120, vy: 150 + Math.random() * 250, g: 60, zycie: 4, max: 4,
        kolor: kolory[i % kolory.length], w: 6 + Math.random() * 6, h: 10 + Math.random() * 8,
        rot: Math.random() * 6, vrot: (Math.random() - 0.5) * 12 });
    }
  }

  function krokCzastek(dt, s) {
    for (const c of czastki) {
      c.vy += c.g * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vrot * dt; c.zycie -= dt;
    }
    czastki = czastki.filter((c) => c.zycie > 0 && c.y < H + 40);

    if (s > 0.08 && Math.random() < s * 1.6) {
      smugi.push({ x: -80, y: H * (0.08 + Math.random() * 0.7), v: 500 + 900 * s, l: 40 + 120 * s, a: 0.25 + 0.45 * s });
    }
    for (const m of smugi) m.x += m.v * dt;
    smugi = smugi.filter((m) => m.x - m.l < W);
    for (const c of chmury) { c.x += c.v * dt * (1 + s * 8); if (c.x > 1.3) c.x = -0.3; }
  }

  // ---------- Rysowanie ----------
  function rysujTlo() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#6ec0ee');
    g.addColorStop(1, '#d6f1fd');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255, 236, 140, .9)';
    ctx.beginPath(); ctx.arc(W * 0.85, H * 0.08, Math.min(W, H) * 0.07, 0, 7); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.85)';
    for (const c of chmury) {
      const x = c.x * W, y = c.y * H, s = c.s * Math.min(W, 500) * 0.12;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, 7); ctx.arc(x + s * 0.9, y + s * 0.2, s * 0.75, 0, 7); ctx.arc(x - s * 0.9, y + s * 0.25, s * 0.65, 0, 7);
      ctx.fill();
    }

    // trawa
    const z = H * 0.86;
    ctx.fillStyle = '#7cc957';
    ctx.beginPath(); ctx.moveTo(0, z);
    for (let x = 0; x <= W; x += 20) ctx.quadraticCurveTo(x + 10, z - 8, x + 20, z);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
    ctx.fillStyle = '#5fae3e'; ctx.fillRect(0, z + 14, W, H);

    for (const m of smugi) {
      ctx.strokeStyle = `rgba(255,255,255,${m.a})`;
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x - m.l, m.y); ctx.lineTo(m.x, m.y); ctx.stroke();
    }
  }

  function rysujGalaz(t) {
    const kolysanie = sila * 4 * Math.sin(t * 7);
    ctx.strokeStyle = '#6b4423'; ctx.lineCap = 'round';
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(-20, wysokoscGalezi(-20) - 10);
    for (let x = 0; x <= W + 20; x += 10) ctx.lineTo(x, wysokoscGalezi(x) + kolysanie * (x / W));
    ctx.stroke();
    ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 5;
    ctx.beginPath();
    for (let x = 0; x <= W + 20; x += 10) ctx.lineTo(x, wysokoscGalezi(x) - 3 + kolysanie * (x / W));
    ctx.stroke();
    for (let i = 0; i < 9; i++) {
      const x = W * (0.05 + i * 0.115), y = wysokoscGalezi(x);
      lisc(x, y - 6, 14, -0.8 + (i % 2) * 1.6 + Math.sin(t * 6 + i) * sila * 0.4);
    }
  }

  function lisc(x, y, s, kat) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(kat);
    ctx.fillStyle = '#4caf50';
    ctx.beginPath(); ctx.ellipse(s * 0.9, 0, s, s * 0.45, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 1.8, 0); ctx.stroke();
    ctx.restore();
  }

  function gradient(r, kolor) {
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.15);
    g.addColorStop(0, kolor[0]); g.addColorStop(0.5, kolor[1]); g.addColorStop(1, kolor[2]);
    return g;
  }

  function rysujOwoc(e, x, y, rot) {
    const r = e.r;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = gradient(r, e.kolor);
    ctx.beginPath();
    if (e.typ === 'gruszka') {
      ctx.arc(0, -r * 0.35, r * 0.62, 0, 7);
      ctx.moveTo(r, r * 0.25);
      ctx.arc(0, r * 0.25, r * 0.92, 0, 7);
    } else if (e.typ === 'cytryna') {
      ctx.ellipse(0, 0, r * 0.82, r * 1.08, 0, 0, 7);
    } else if (e.typ === 'sliwka') {
      ctx.ellipse(0, 0, r * 0.85, r, 0, 0, 7);
    } else if (e.typ === 'jablko') {
      ctx.moveTo(0, -r * 0.75);
      ctx.bezierCurveTo(r * 0.7, -r * 1.2, r * 1.25, -r * 0.3, r * 0.9, r * 0.45);
      ctx.bezierCurveTo(r * 0.65, r * 1.05, r * 0.2, r * 1.0, 0, r * 0.9);
      ctx.bezierCurveTo(-r * 0.2, r * 1.0, -r * 0.65, r * 1.05, -r * 0.9, r * 0.45);
      ctx.bezierCurveTo(-r * 1.25, -r * 0.3, -r * 0.7, -r * 1.2, 0, -r * 0.75);
    } else {
      ctx.arc(0, 0, r, 0, 7);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.ellipse(-r * 0.35, -r * 0.35, r * 0.22, r * 0.14, -0.6, 0, 7); ctx.fill();
    // ogonek i listek
    ctx.strokeStyle = '#5d3a1a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -r * 0.8); ctx.lineTo(r * 0.05, -r * 1.05); ctx.stroke();
    lisc(r * 0.05, -r * 1.0, r * 0.32, -0.5);
    ctx.restore();
  }

  function rysujBalon(e, x, y, rot) {
    const r = e.r;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = e.kolor[2];
    ctx.beginPath();
    ctx.moveTo(0, r * 0.98); ctx.lineTo(-r * 0.12, r * 1.15); ctx.lineTo(r * 0.12, r * 1.15); ctx.fill();
    ctx.fillStyle = gradient(r, e.kolor);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.bezierCurveTo(r * 1.15, -r, r * 1.0, r * 0.55, 0, r);
    ctx.bezierCurveTo(-r * 1.0, r * 0.55, -r * 1.15, -r, 0, -r);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.beginPath(); ctx.ellipse(-r * 0.32, -r * 0.4, r * 0.16, r * 0.28, 0.4, 0, 7); ctx.fill();
    ctx.restore();
  }

  function rysujElementy(t) {
    const balony = cfg.motyw === 'balony';
    if (!balony) rysujGalaz(t);

    for (let i = 0; i < elementy.length; i++) {
      const e = elementy[i];
      if (lecacy && lecacy.e === e) continue;
      const p = pozycja(e);
      // sznurek / szypułka z lekkim wygięciem zależnym od prędkości
      const mx = (e.ax + p.ex) / 2 - p.uy * e.omega * 6 * e.dir;
      const my = (e.ay + p.ey) / 2 + p.ux * e.omega * 6 * e.dir;
      ctx.strokeStyle = balony ? 'rgba(80,80,80,.8)' : '#6b4f2a';
      ctx.lineWidth = balony ? 1.4 : 2.5;
      ctx.beginPath(); ctx.moveTo(e.ax, e.ay); ctx.quadraticCurveTo(mx, my, p.ex, p.ey); ctx.stroke();
      const rot = Math.atan2(p.uy, p.ux) - e.dir * Math.PI / 2;
      if (balony) rysujBalon(e, p.x, p.y, rot); else rysujOwoc(e, p.x, p.y, rot);
    }

    if (balony) {
      // obciążnik, do którego przywiązane są balony
      const e = elementy[0], s = 16;
      ctx.fillStyle = '#ff5a3c';
      ctx.fillRect(e.ax - s, e.ay, s * 2, s * 1.6);
      ctx.fillStyle = '#ffd23c';
      ctx.fillRect(e.ax - 3, e.ay, 6, s * 1.6);
      ctx.fillRect(e.ax - s, e.ay + s * 0.5, s * 2, 5);
    }

    if (lecacy && !lecacy.koniec) {
      const L = lecacy;
      if (balony) {
        ctx.strokeStyle = 'rgba(80,80,80,.8)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(L.x - Math.sin(L.rot) * L.e.r * 1.15, L.y + Math.cos(L.rot) * L.e.r * 1.15);
        ctx.lineTo(L.x - Math.sin(L.rot) * L.e.r * 3, L.y + Math.cos(L.rot) * L.e.r * 3.2); ctx.stroke();
        rysujBalon(L.e, L.x, L.y, L.rot);
      } else {
        rysujOwoc(L.e, L.x, L.y, L.rot);
      }
    }
  }

  function rysujCzastki() {
    for (const c of czastki) {
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.globalAlpha = clamp(c.zycie / Math.min(c.max, 0.5), 0, 1);
      ctx.fillStyle = c.kolor;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Pętla ----------
  const silaPasek = $('silaPasek'), energiaPasek = $('energiaPasek'), podpowiedz = $('podpowiedz');
  let ostatni = performance.now(), t = 0, fps = 60;

  function petla(teraz) {
    const dt = Math.min(0.05, (teraz - ostatni) / 1000);
    ostatni = teraz; t += dt;
    fps += (1 / Math.max(dt, 0.001) - fps) * 0.05;

    odczytajMikrofon();

    if (stan === 'kalibracja') {
      probkiCiszy.push(rms);
      czasKalibracji += dt;
      $('kalibracjaPasek').style.width = `${clamp(czasKalibracji / CZAS_KALIBRACJI, 0, 1) * 100}%`;
      if (czasKalibracji >= CZAS_KALIBRACJI) zakonczKalibracje();
    }

    let surowa = 0;
    if (stan === 'gra') surowa = Math.max(silaZMikrofonu(), przytrzymany ? 0.85 : 0);
    // szybki narost, wolniejsze wygaszanie
    sila += (surowa - sila) * Math.min(1, dt * (surowa > sila ? 18 : 4));

    if (stan === 'gra') {
      czasGry += dt;
      if (sila > 0.06) energia += sila * dt / cfg.czas;
      else energia -= 0.06 * dt;
      energia = clamp(energia, 0, 1);
      silaPasek.style.width = `${sila * 100}%`;
      energiaPasek.style.width = `${energia * 100}%`;
      podpowiedz.textContent = energia > 0.7 ? 'Jeszcze trochę!' : sila > 0.5 ? 'Mocniej, mocniej!' : sila > 0.1 ? 'Dobrze, tak trzymaj!' : 'Dmuchaj w mikrofon!';
      if (energia >= 1) final();
    }
    if (stan === 'final') { czasFinalu += dt; krokLecacego(dt); }

    const kroki = 3, sdt = dt / kroki;
    for (let k = 0; k < kroki; k++) for (const e of elementy) krokWahadla(e, sdt, t, stan === 'final' ? sila * 0.5 : sila);
    krokCzastek(dt, sila);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    rysujTlo();
    rysujElementy(t);
    rysujCzastki();

    if (cfg.debug) {
      $('debug').textContent =
        `rms   ${rms.toFixed(4)}\ncisza ${poziomCiszy.toFixed(4)}\nsila  ${sila.toFixed(2)}\nenerg ${energia.toFixed(2)}\nfps   ${fps.toFixed(0)}\nctx   ${audioCtx?.state ?? '-'}`;
    }
    requestAnimationFrame(petla);
  }

  // ---------- Przebieg gry ----------
  function pokaz(id) {
    for (const x of ['start', 'kalibracja', 'wynik']) $(x).classList.toggle('ukryty', x !== id);
  }

  function zakonczKalibracje() {
    const posortowane = probkiCiszy.slice().sort((a, b) => a - b);
    poziomCiszy = Math.max(0.002, posortowane[Math.floor(posortowane.length * 0.8)] || 0.01);
    nowaGra();
  }

  function nowaGra() {
    lecacy = null; czastki = []; energia = 0; sila = 0; czasGry = 0; czasFinalu = 0;
    zbudujScene();
    wybrany = Math.floor(Math.random() * elementy.length);
    stan = 'gra';
    pokaz(null);
    $('hud').classList.remove('ukryty');
  }

  function final() {
    stan = 'final';
    przytrzymany = false;
    $('przytrzymaj').classList.remove('wcisniety');
    $('hud').classList.add('ukryty');
    wygrana = cfg.wynik === 'wygrana' ? true : cfg.wynik === 'przegrana' ? false : Math.random() < cfg.szansa;
    if (navigator.vibrate) navigator.vibrate(50);
    oderwij(elementy[wybrany]);
  }

  function pokazWynikZa(s) {
    setTimeout(() => {
      stan = 'wynik';
      if (wygrana) {
        konfetti();
        $('wynikIkona').textContent = '🎉';
        $('wynikTytul').textContent = 'Wygrałeś!';
        $('wynikOpis').textContent = 'Gratulacje! Twój kod nagrody:';
        $('wynikKod').textContent = kod();
      } else {
        $('wynikIkona').textContent = cfg.motyw === 'balony' ? '🎈' : '🍃';
        $('wynikTytul').textContent = 'Tym razem nic';
        $('wynikOpis').textContent = 'Niestety nie udało się. Spróbuj ponownie!';
        $('wynikKod').textContent = '';
      }
      pokaz('wynik');
    }, s * 1000);
  }

  function kod() {
    const znaki = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 8; i++) s += (i === 4 ? '-' : '') + znaki[Math.floor(Math.random() * znaki.length)];
    return s;
  }

  // ---------- Interfejs ----------
  document.querySelectorAll('.motyw').forEach((b) => {
    b.classList.toggle('aktywny', b.dataset.motyw === cfg.motyw);
    b.addEventListener('click', () => {
      cfg.motyw = b.dataset.motyw;
      document.querySelectorAll('.motyw').forEach((x) => x.classList.toggle('aktywny', x === b));
      zbudujScene();
    });
  });

  $('graj').addEventListener('click', async () => {
    $('blad').textContent = '';
    try {
      if (!analyser) await wlaczMikrofon();
      probkiCiszy = []; czasKalibracji = 0;
      stan = 'kalibracja';
      pokaz('kalibracja');
    } catch (err) {
      console.warn(err);
      // Bez mikrofonu: gra działa na przycisku "przytrzymaj"
      analyser = null;
      nowaGra();
      podpowiedz.textContent = 'Brak dostępu do mikrofonu';
      $('przytrzymaj').textContent = 'Przytrzymaj tutaj, żeby dmuchać';
    }
  });

  $('jeszczeRaz').addEventListener('click', () => {
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    nowaGra();
  });

  const btn = $('przytrzymaj');
  const wcisnij = (v) => (e) => { e.preventDefault(); przytrzymany = v; btn.classList.toggle('wcisniety', v); };
  btn.addEventListener('pointerdown', wcisnij(true));
  btn.addEventListener('pointerup', wcisnij(false));
  btn.addEventListener('pointerleave', wcisnij(false));
  btn.addEventListener('pointercancel', wcisnij(false));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  function clamp(v, a, b) { return Math.min(b, Math.max(a, Number.isFinite(v) ? v : a)); }

  if (cfg.debug) $('debug').classList.remove('ukryty');
  resize();
  requestAnimationFrame(petla);
})();
