'use strict';
// Hub renderer: dashboard, history, dictionary, snippets, settings.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const ff = window.freeflow;
  const I = window.FFI18N;
  let lang = 'fr';                 // the app's language (Paramètres > Langue et aide)
  const t = (key, vars) => I.t(lang, key, vars);
  const tn = (n, one, many, vars) => I.tn(lang, n, one, many, vars);
  const locale = () => I.LOCALES[lang];
  I.localize('fr');                // keeps the page's French text before anything is drawn
  let state = null;
  let phase = 'idle';
  let hubDictation = false;      // the current dictation targets the "try here" box
  let previewTimer = null;
  let isMac = false;
  let learnWord = null;          // "Dis-le" in progress for this word
  let dictKey = '';              // last rendered dictionary (the list is rebuilt only when it changes)
  let editingHistory = null;     // id of the dictation being corrected
  let insertTarget = null;       // textarea that receives a dictation started from this window

  // ---- navigation
  function navigate(section) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === section));
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `section-${section}`));
    try { localStorage.setItem('ff.section', section); } catch { /* ignore */ }
  }
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.section)));
  ff.on('ff:navigate', navigate);
  try { navigate(localStorage.getItem('ff.section') || 'home'); } catch { navigate('home'); }

  // ---- helpers
  function toast(msg) {
    const t = $('#toast');
    t.textContent = I.t(lang, msg);
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function fmtNum(n) { return new Intl.NumberFormat(locale()).format(n || 0); }
  function relTime(iso) {
    const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return t('à l’instant');
    if (diff < 3600) return t('il y a {n} min', { n: Math.round(diff / 60) });
    if (diff < 86400 && d.toDateString() === new Date().toDateString()) return t('aujourd’hui à {time}', { time: d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) });
    return d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  // ---- render
  function render() {
    if (!state) return;
    const s = state.settings, st = state.stats, eng = state.sidecar || {};
    applyLanguage(I.resolve(s.uiLanguage));
    isMac = state.platform === 'darwin';
    document.body.classList.toggle('mac', isMac);
    const hour = new Date().getHours();
    const name = state.user ? state.user.charAt(0).toUpperCase() + state.user.slice(1) : '';
    $('#greeting').textContent = `${t(hour < 18 && hour >= 5 ? 'Bonjour' : 'Bonsoir')}${name ? (lang === 'zh' ? '，' : lang === 'ar' ? '، ' : ', ') + name : ''}`;
    $('#stat-today').textContent = fmtNum(st.wordsToday);
    $('#stat-total').textContent = fmtNum(st.totalWords);
    $('#stat-wpm').textContent = fmtNum(st.avgWpm);
    $('#stat-count').textContent = fmtNum(st.dictations);
    $('#howto-shortcut').textContent = prettyAcc(s.shortcut);
    const ptt = s.mode === 'ptt';
    $('#howto-mode').textContent = t(ptt ? 'et garde la touche enfoncée : la pastille apparaît en bas de l’écran et écoute.' : ': la pastille apparaît en bas de l’écran et écoute.');
    $('#howto-stop').textContent = t(ptt ? 'Relâche la touche' : 'Appuie à nouveau');
    $('#howto-paste').textContent = s.autoPaste ? t('Collage automatique activé. Le presse-papiers est restauré juste après.') : t('Collage automatique désactivé : le texte est copié dans le presse-papiers, colle-le avec {keys}.', { keys: isMac ? '⌘ V' : 'Ctrl+V' });
    renderPermissions();

    // Engine pill
    const pill = $('#engine-pill');
    pill.className = 'engine ' + (phase === 'listening' ? 'listening' : eng.ready ? 'ready' : eng.error && !eng.loading ? 'error' : '');
    $('#engine-text').textContent = phase === 'listening' ? t('Écoute…') : eng.ready ? t('{device} · {model} · prêt', { device: eng.device === 'cuda' ? 'GPU' : 'CPU', model: eng.model }) : eng.loading ? (state.loadingShort || t('Chargement du modèle…')) : (eng.error ? t('Moteur indisponible') : '…');

    // History
    const hl = $('#history-list'); hl.innerHTML = '';
    if (!state.history.length) hl.appendChild(el(`<div class="empty">${esc(t('Aucune dictée pour le moment. Appuie sur le raccourci et parle.'))}</div>`));
    for (const h of state.history) {
      if (editingHistory === h.id) { hl.appendChild(historyEditor(h)); continue; }
      const node = el(`<div class="item" data-id="${esc(h.id)}">
        <div><div class="text">${esc(h.text)}</div>
          <div class="meta"><span>${esc(relTime(h.ts))}</span><span>${esc(tn(h.words || 0, '{n} mot', '{n} mots'))}</span>${h.latencyMs ? `<span>${(h.latencyMs / 1000).toFixed(1)} s</span>` : ''}${h.app ? `<span>→ ${esc(h.app)}</span>` : ''}${h.language ? `<span>${esc(h.language)}</span>` : ''}${h.edited ? `<span class="tag edited">${esc(t('corrigé'))}</span>` : ''}</div></div>
        <div class="actions"><button class="btn small" data-act="copy">${esc(t('Copier'))}</button><button class="btn small" data-act="fix" title="${esc(t('Corrige le texte : les mots changés pourront aller dans le dictionnaire'))}">${esc(t('Corriger'))}</button><button class="btn small danger" data-act="del">${esc(t('Supprimer'))}</button></div></div>`);
      node.querySelector('[data-act=copy]').addEventListener('click', async () => { await ff.invoke('ff:copy', h.text); toast('Copié'); });
      node.querySelector('[data-act=fix]').addEventListener('click', () => { editingHistory = h.id; render(); });
      node.querySelector('[data-act=del]').addEventListener('click', () => ff.invoke('ff:history', { action: 'delete', id: h.id }));
      hl.appendChild(node);
    }

    // Dictionary (vocabulary): word + what the model hears instead
    renderDictionary();
    refreshPreview();

    // Snippets
    const sl = $('#snippet-list'); sl.innerHTML = '';
    if (!state.snippets.length) sl.appendChild(el(`<div class="empty">${esc(t('Aucun snippet. Exemple : « ma signature » → « Bonne journée et à très vite ! ».'))}</div>`));
    for (const sn of state.snippets) {
      const node = el(`<div class="item"><div><span class="trigger">${esc(sn.trigger)}</span> → <span class="text">${esc(sn.expansion)}</span></div>
        <div class="actions"><button class="btn small danger">${esc(t('Supprimer'))}</button></div></div>`);
      node.querySelector('button').addEventListener('click', () => ff.invoke('ff:snippets', { action: 'remove', id: sn.id }));
      sl.appendChild(node);
    }

    // Settings
    updateShortcutUi();
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === s.mode; });
    const pttInput = document.querySelector('input[name=mode][value=ptt]');
    pttInput.disabled = !state.pttAvailable;
    $('#mode-ptt-label').classList.toggle('disabled', !state.pttAvailable);
    $('#ptt-hint').textContent = t(state.pttAvailable ? 'Garde la touche enfoncée pendant que tu parles ; un appui bref passe en mains libres.'
      : isMac ? 'Indisponible tant que FreeFlow n’est pas autorisé dans Réglages Système → Confidentialité et sécurité → Accessibilité.'
        : 'Indisponible : le module uiohook-napi n’a pas pu être chargé.');
    $('#set-model').value = s.model || 'auto';
    $('#model-hint').textContent = t(isMac
      ? 'Sur Mac, le modèle tourne sur le processeur : Automatique = Rapide. Sur un Mac M2 ou plus récent, essaie Équilibré.'
      : eng.device === 'cuda' ? 'Automatique = large-v3 sur ta carte graphique.' : 'Automatique = small sur le processeur (aucun GPU utilisable détecté).')
      + ' ' + t('Un nouveau modèle se télécharge une seule fois.');
    $('#set-language').value = s.language;
    $('#set-uilang').value = lang;
    $('#set-autopaste').checked = !!s.autoPaste;
    $('#set-login').checked = !!s.launchAtLogin;
    $('#eng-state').textContent = eng.ready ? t('Prêt') : eng.loading ? (eng.phase === 'downloading' ? state.loadingLabel : t('Chargement…')) : t('Erreur');
    $('#eng-device').textContent = eng.device ? (eng.device === 'cuda' ? 'GPU' : 'CPU') : '-';
    $('#eng-model').textContent = eng.model ? `faster-whisper ${eng.model}` : '—';
    $('#eng-compute').textContent = eng.compute_type || '—';
    $('#eng-port').textContent = eng.port ? `127.0.0.1:${eng.port}${eng.external ? t(' (externe)') : ''}` : '—';
    $('#eng-latency').textContent = st.avgLatencyMs ? `${(st.avgLatencyMs / 1000).toFixed(1)} s` : '—';
    $('#eng-error').textContent = eng.error && !eng.ready ? eng.error : '';
    $('#eng-cache').textContent = s.modelCache;
    $('#version').textContent = t('FreeFlow {v} · données : {path}', { v: state.version, path: state.paths.userData });
    const micSel = $('#set-mic');
    micSel.options[0].textContent = t('Micro par défaut');
    if (micSel.querySelector(`option[value="${s.microphoneId}"]`)) micSel.value = s.microphoneId;
    renderTry();
    renderExtra();
  }

  function renderTry() {
    const btn = $('#mic-btn'), status = $('#try-status');
    btn.classList.toggle('listening', phase === 'listening' && hubDictation);
    btn.classList.toggle('busy', (phase === 'transcribing' || phase === 'formatting') && hubDictation);
    const map = { idle: 'Prêt', listening: 'Écoute… clique pour arrêter', transcribing: 'Transcription…', formatting: 'Mise en forme…', done: 'Terminé', error: 'Erreur' };
    status.textContent = hubDictation || phase === 'idle' ? t(map[phase] || 'Prêt') : t('Dictée en cours ({phase})', { phase: t(map[phase] || phase) });
  }

  // Words worth saying aloud (not an e-mail address, a link or a whole sentence).
  function guessable(word) { return /^[^@/\\]{1,40}$/.test(word) && word.split(/\s+/).length <= 4; }
  function wordsToGuess() { return state.dictionary.filter((v) => !(v.sounds || []).length && guessable(v.word)).map((v) => v.word); }

  function renderDictionary() {
    const key = JSON.stringify([state.dictionary, learnWord, lang]);
    $('#dict-count').textContent = tn(state.dictionary.length, '{n} mot@dict', '{n} mots@dict');
    const missing = wordsToGuess().length;
    $('#dict-guess-missing').disabled = !missing || !!state.guessing;
    $('#dict-guess-missing').textContent = !missing ? t('Tous les mots ont une variante') : missing > 1 ? t('Deviner pour les {n} mots sans variante', { n: missing }) : t('Deviner pour le mot sans variante');
    const nb = $('#dict-learn-new');
    nb.classList.toggle('listening', !!learnWord && learnWord === $('#dict-word').value.trim());
    nb.textContent = t(nb.classList.contains('listening') ? 'Arrêter' : 'Dis-le');
    if (key === dictKey) return;
    dictKey = key;
    const dl = $('#dict-list'); dl.innerHTML = '';
    if (!state.dictionary.length) dl.appendChild(el(`<div class="empty">${esc(t('Aucun mot. Ajoute les noms que le modèle écorche, ou importe un fichier.'))}</div>`));
    for (const v of state.dictionary) {
      const sounds = (v.sounds || []).length
        ? v.sounds.map((x) => `<span class="sound">${esc(x)}</span>`).join('')
        : `<span class="sound none">${esc(t('casse uniquement'))}</span>`;
      const on = learnWord === v.word;
      const node = el(`<div class="item vocab-item"><div><div class="word">${esc(v.word)}</div><div class="sounds">${sounds}</div></div>
        <div class="actions"><button class="btn small${on ? ' listening' : ''}" data-act="learn" title="${esc(t('Dis le mot à voix haute (2 ou 3 fois) : FreeFlow note ce que le modèle entend'))}">${esc(t(on ? 'Arrêter' : 'Dis-le'))}</button><button class="btn small" data-act="guess" title="${esc(t('La voix de l’ordinateur dit le mot et le modèle l’écoute'))}">${esc(t('Deviner'))}</button><button class="btn small" data-act="edit">${esc(t('Modifier'))}</button><button class="btn small danger" data-act="del">${esc(t('Supprimer'))}</button></div></div>`);
      node.querySelector('[data-act=learn]').addEventListener('click', () => toggleLearn(v.word));
      node.querySelector('[data-act=guess]').addEventListener('click', () => startGuess([v.word]));
      node.querySelector('[data-act=edit]').addEventListener('click', () => editVocab(v));
      node.querySelector('[data-act=del]').addEventListener('click', () => ff.invoke('ff:dictionary', { action: 'remove', word: v.word }));
      dl.appendChild(node);
    }
  }

  function renderPermissions() {
    const p = state.permissions;
    const card = $('#perm-card');
    card.hidden = !isMac || !p || (p.microphone === 'granted' && p.accessibility);
    if (card.hidden) return;
    const mic = p.microphone === 'granted';
    $('#perm-mic-state').textContent = t(mic ? 'Autorisé' : p.microphone === 'denied' ? 'Refusé' : 'À autoriser');
    $('#perm-mic-state').classList.toggle('ok', mic);
    $('#perm-mic-btn').hidden = mic;
    $('#perm-mic-btn').textContent = t(p.microphone === 'not-determined' ? 'Autoriser' : 'Ouvrir les réglages');
    $('#perm-ax-state').textContent = t(p.accessibility ? 'Autorisé' : 'À activer');
    $('#perm-ax-state').classList.toggle('ok', !!p.accessibility);
    $('#perm-ax-btn').hidden = !!p.accessibility;
  }

  // ---- suggestions: what the model heard ("Dis-le" / "Deviner")
  const sugg = { rows: [], running: false };
  function showSuggest({ title, hint, running, progress }) {
    $('#suggest').hidden = false;
    if (title != null) $('#suggest-title').textContent = title;
    if (hint != null) $('#suggest-hint').textContent = hint;
    sugg.running = !!running;
    $('#suggest-stop').hidden = !running;
    $('#suggest-progress').hidden = progress == null;
    if (progress != null) $('#suggest-bar').style.width = `${Math.round(progress * 100)}%`;
    renderSuggestRows();
  }
  function renderSuggestRows() {
    const list = $('#suggest-list'); list.innerHTML = '';
    let any = false;
    for (const r of sugg.rows) {
      const row = el(`<div class="suggest-row"><div class="word">${esc(r.word)}</div><div class="sugg-chips"></div></div>`);
      const chips = row.querySelector('.sugg-chips');
      if (!r.items.length) chips.appendChild(el(`<span class="none">${esc(t(r.error || 'Rien à ajouter : le modèle l’écrit déjà bien.'))}</span>`));
      r.items.forEach((it) => {
        any = true;
        const c = el(`<label class="sugg${it.on ? '' : ' off'}${it.risky ? ' risky' : ''}"${it.risky ? ` title="${esc(t('Mot de tous les jours : coché, il serait remplacé par « {word} » dans toutes tes dictées.', { word: r.word }))}"` : ''}><input type="checkbox"${it.on ? ' checked' : ''}> ${esc(it.text)}${it.risky ? ` <span class="warn">${esc(t('mot courant'))}</span>` : ''}</label>`);
        c.querySelector('input').addEventListener('change', (e) => { it.on = e.target.checked; c.classList.toggle('off', !it.on); updateSuggestFoot(); });
        chips.appendChild(c);
      });
      list.appendChild(row);
    }
    $('#suggest-foot').hidden = sugg.running || !sugg.rows.length;
    $('#suggest-apply').hidden = !any;
    updateSuggestFoot();
  }
  function updateSuggestFoot() {
    const n = sugg.rows.reduce((k, r) => k + r.items.filter((i) => i.on).length, 0);
    $('#suggest-apply').disabled = !n;
    $('#suggest-apply').textContent = n ? tn(n, 'Ajouter {n} variante', 'Ajouter {n} variantes') : t('Rien de coché');
  }
  function closeSuggest() {
    if (sugg.running) ff.invoke('ff:vocab-guess-cancel');
    sugg.rows = []; sugg.running = false;
    $('#suggest').hidden = true;
  }
  function rowsFrom(results) {
    return results.map((r) => ({ word: r.word, error: r.error, items: (r.suggestions || []).map((x) => ({ ...x, on: !x.risky })) }));
  }
  async function startGuess(words) {
    if (state && !state.sidecar.ready) { toast('Le modèle n’est pas encore prêt.'); return; }
    const res = await ff.invoke('ff:vocab-guess', { words });
    if (!res.ok) { toast(res.error); return; }
    sugg.rows = [];
    showSuggest({ title: words.length > 1 ? t('Deviner ce que le modèle entend') : t('« {word} » : ce que le modèle entend', { word: words[0] }), hint: t('La voix de l’ordinateur dit chaque mot, le modèle l’écoute sans le dictionnaire…'), running: true, progress: 0 });
    $('#suggest').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  ff.on('ff:guess', (p) => {
    if (p.phase === 'progress') showSuggest({ hint: t('Écoute… {done} / {total} ({word})', p), running: true, progress: p.done / Math.max(1, p.total) });
    else if (p.phase === 'done') {
      sugg.rows = rowsFrom(p.results);
      const n = sugg.rows.reduce((k, r) => k + r.items.length, 0);
      showSuggest({ hint: t(n ? 'Coche ce qu’il faut corriger. Les mots courants restent décochés : ils seraient remplacés partout.' : 'Le modèle écrit déjà bien ces mots : rien à ajouter.'), running: false, progress: null });
    } else if (p.phase === 'error') { showSuggest({ hint: t(p.error), running: false, progress: null }); toast(p.error); }
  });
  $('#suggest-stop').addEventListener('click', () => { ff.invoke('ff:vocab-guess-cancel'); $('#suggest-hint').textContent = t('Arrêt…'); });
  $('#suggest-close').addEventListener('click', closeSuggest);
  $('#suggest-apply').addEventListener('click', async () => {
    let n = 0;
    for (const r of sugg.rows) {
      const sounds = r.items.filter((i) => i.on).map((i) => i.text);
      if (!sounds.length) continue;
      await ff.invoke('ff:dictionary', { action: 'add', word: r.word, sounds });
      n += sounds.length;
    }
    closeSuggest();
    toast(tn(n, '{n} variante ajoutée', '{n} variantes ajoutées'));
  });

  // "Dis-le": the next dictation (from this window) teaches what the model hears for the word.
  async function toggleLearn(word) {
    const w = String(word || '').trim();
    if (!w) { toast('Écris d’abord le mot correct.'); $('#dict-word').focus(); return; }
    if (state && !state.sidecar.ready) { toast('Le modèle n’est pas encore prêt.'); return; }
    if (learnWord && phase === 'listening') { await ff.invoke('ff:vocab-learn', {}); return; }
    if (phase !== 'idle') return;
    const res = await ff.invoke('ff:vocab-learn', { word: w });
    if (!res.ok) { toast(res.error || 'Impossible de lancer l’écoute.'); return; }
    learnWord = w;
    toast(t('Dis « {word} » deux ou trois fois, puis clique sur Arrêter', { word: w }));
    render();
  }
  ff.on('ff:learn', (r) => {
    learnWord = null;
    if (r.error && !r.suggestions.length) { toast(r.error); render(); return; }
    sugg.rows = rowsFrom([{ word: r.word, suggestions: r.suggestions }]);
    showSuggest({ title: t('« {word} » : ce que le modèle a entendu', { word: r.word }), hint: r.heard ? t('Il a écrit : « {text} »', { text: r.heard }) : '', running: false, progress: null });
    $('#suggest').scrollIntoView({ behavior: 'smooth', block: 'center' });
    render();
  });
  $('#dict-learn-new').addEventListener('click', () => toggleLearn($('#dict-word').value));
  $('#dict-guess-missing').addEventListener('click', () => startGuess(wordsToGuess()));

  // ---- import: file, pasted list, Wispr Flow -> preview -> apply
  const imp = { input: null, preview: null };
  function importStep(step) {
    $('#import-source').hidden = step !== 'source';
    $('#import-preview').hidden = step !== 'preview';
    $('#import-foot').hidden = step !== 'preview';
  }
  function openImport() {
    $('#import-wispr').hidden = !state.wispr;
    $('#import-guess').checked = true;
    importStep('source');
    $('#import-modal').hidden = false;
  }
  function closeImport() {
    $('#import-modal').hidden = true;
    imp.input = null; imp.preview = null;
    $('#import-file').value = '';
  }
  async function parseImport(input, direction) {
    const res = await ff.invoke('ff:vocab-parse', { ...input, direction });
    if (!res.ok) { toast(res.error); return; }
    imp.input = input;
    showImportPreview(res);
  }
  async function readFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('Fichier trop lourd (20 Mo au plus).'); return; }
    await parseImport({ data: await file.arrayBuffer(), name: file.name });
  }
  function showImportPreview(res) {
    imp.preview = res;
    const c = res.counts;
    const pills = [];
    if (c.new) pills.push(`<span class="pill new">${esc(tn(c.new, '{n} nouveau mot', '{n} nouveaux mots', { n: fmtNum(c.new) }))}</span>`);
    if (c.merge) pills.push(`<span class="pill merge">${esc(tn(c.merge, '{n} mot complété', '{n} mots complétés', { n: fmtNum(c.merge) }))}</span>`);
    if (c.same) pills.push(`<span class="pill">${esc(t('{n} déjà à jour', { n: fmtNum(c.same) }))}</span>`);
    if (res.snippets && res.snippets.length) pills.push(`<span class="pill merge">${esc(tn(res.snippets.length, '{n} snippet', '{n} snippets'))}</span>`);
    if (!pills.length) pills.push(`<span class="pill">${esc(t('Aucun mot trouvé'))}</span>`);
    $('#import-summary').innerHTML = pills.join('');
    $('#import-format').textContent = t('Lu comme : {format}', { format: t(res.format) }) + (res.swappable ? t(res.direction === 'heard-first' ? ' · mot correct en 2ᵉ colonne' : ' · mot correct en 1ʳᵉ colonne') : '') + (res.source && res.source !== 'Wispr Flow' ? ` · ${res.source}` : '');
    $('#import-swap').hidden = !res.swappable;
    const rows = $('#import-rows'); rows.innerHTML = '';
    const tags = { new: t('Nouveau'), merge: t('Complété'), same: t('Déjà là') };
    for (const e of res.entries.slice(0, 300)) {
      const fresh = new Set(e.newSounds);
      const sounds = e.sounds.length ? e.sounds.map((x) => `<span class="sound${e.status === 'merge' && !fresh.has(x) ? ' old' : ''}">${esc(x)}</span>`).join('') : `<span class="sound none">${esc(t('à deviner'))}</span>`;
      rows.appendChild(el(`<div class="preview-row"><div class="word">${esc(e.word)}</div><div class="sounds">${sounds}</div><span class="tag ${e.status}">${tags[e.status]}</span></div>`));
    }
    if (res.entries.length > 300) rows.appendChild(el(`<div class="preview-more">${esc(t('… et {n} autres mots', { n: fmtNum(res.entries.length - 300) }))}</div>`));
    if (!res.entries.length) rows.appendChild(el(`<div class="preview-more">${esc(t('Aucun mot dans ce fichier. Vérifie qu’il y a un mot par ligne.'))}</div>`));
    const box = $('#import-skipped-box');
    box.hidden = !res.skippedCount;
    $('#import-skipped-title').textContent = tn(res.skippedCount, '{n} ligne ignorée', '{n} lignes ignorées');
    $('#import-skipped').innerHTML = res.skipped.map((s) => `<li>${esc(t('Ligne {line} : {text} ({reason})', { line: s.line, text: s.text, reason: t(s.reason) }))}</li>`).join('');
    const toGuess = res.entries.filter((e) => e.status === 'new' && !e.sounds.length && guessable(e.word)).length;
    $('#import-guess-row').hidden = !toGuess;
    $('#import-guess-n').textContent = fmtNum(toGuess);
    const n = c.new + c.merge + ((res.snippets && res.snippets.length) || 0);
    $('#import-apply').disabled = !n;
    const words = c.new + c.merge;
    $('#import-apply').textContent = !n ? t('Rien de nouveau') : words ? tn(words, 'Importer {n} mot', 'Importer {n} mots', { n: fmtNum(words) }) : t('Importer les snippets');
    importStep('preview');
  }
  $('#dict-import-open').addEventListener('click', openImport);
  $('#import-close').addEventListener('click', closeImport);
  $('#import-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'import-modal') closeImport(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#import-modal').hidden) closeImport(); });
  $('#import-file').addEventListener('change', (e) => readFile(e.target.files[0]));
  // A file dropped anywhere else must not make the window navigate to it.
  for (const t of ['dragover', 'drop']) window.addEventListener(t, (e) => e.preventDefault());
  const drop = $('#import-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
  $('#section-dictionary').addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { openImport(); readFile(e.dataTransfer.files[0]); } });
  $('#import-paste-read').addEventListener('click', () => {
    const text = $('#import-paste').value;
    if (!text.trim()) { toast('Colle d’abord ta liste.'); $('#import-paste').focus(); return; }
    parseImport({ data: text, name: '' });
  });
  async function saveTemplate() { if (await ff.invoke('ff:vocab-template')) toast('Modèle Excel enregistré : remplis-le, puis clique sur Importer mon fichier'); }
  async function saveExample() { if (await ff.invoke('ff:vocab-example')) toast('Exemple enregistré : ouvre-le pour voir comment remplir les colonnes'); }
  $('#import-template').addEventListener('click', saveTemplate);
  $('#import-example').addEventListener('click', saveExample);
  $('#excel-template').addEventListener('click', saveTemplate);
  $('#excel-example').addEventListener('click', saveExample);
  $('#excel-import').addEventListener('click', openImport);
  $('#import-ai').addEventListener('click', async () => { await ff.invoke('ff:vocab-ai-prompt'); toast('Prompt copié : colle-le dans ChatGPT ou Claude, puis colle sa réponse ici'); });
  $('#import-wispr').addEventListener('click', async () => {
    const res = await ff.invoke('ff:vocab-wispr');
    if (!res.ok) { toast(res.error); return; }
    imp.input = null;
    showImportPreview(res);
  });
  $('#import-swap').addEventListener('click', () => {
    if (imp.input && imp.preview) parseImport(imp.input, imp.preview.direction === 'heard-first' ? 'word-first' : 'heard-first');
  });
  $('#import-back').addEventListener('click', () => importStep('source'));
  $('#import-apply').addEventListener('click', async () => {
    const p = imp.preview;
    if (!p) return;
    const entries = p.entries.filter((e) => e.status !== 'same').map((e) => ({ word: e.word, sounds: e.sounds }));
    const res = await ff.invoke('ff:vocab-apply', { entries, snippets: p.snippets || [] });
    const guess = !$('#import-guess-row').hidden && $('#import-guess').checked
      ? p.entries.filter((e) => e.status === 'new' && !e.sounds.length && guessable(e.word)).map((e) => e.word) : [];
    closeImport();
    $('#import-paste').value = '';
    const parts = [];
    if (res.added) parts.push(tn(res.added, '{n} mot ajouté', '{n} mots ajoutés'));
    if (res.merged) parts.push(tn(res.merged, '{n} complété', '{n} complétés'));
    if (res.snippets) parts.push(tn(res.snippets, '{n} snippet', '{n} snippets'));
    toast(parts.join(lang === 'zh' ? '，' : lang === 'ar' ? '، ' : ', ') || 'Rien de nouveau');
    if (guess.length) startGuess(guess);
  });
  $('#dict-export').addEventListener('click', async () => { if (await ff.invoke('ff:vocab-export')) toast('Dictionnaire exporté'); });

  // ---- microphones
  async function loadMics() {
    try {
      // Ask once so device labels are populated, then release the stream.
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch { /* labels may stay empty */ }
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const sel = $('#set-mic');
      const current = state ? state.settings.microphoneId : 'default';
      sel.innerHTML = `<option value="default">${esc(t('Micro par défaut'))}</option>`;
      for (const d of devs) {
        if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || t('Micro {n}', { n: sel.options.length });
        sel.appendChild(o);
      }
      if (sel.querySelector(`option[value="${current}"]`)) sel.value = current;
    } catch { /* ignore */ }
  }

  // ---- events
  $('#mic-btn').addEventListener('click', async () => {
    if (phase === 'idle') { hubDictation = true; $('#try-area').focus(); }
    await ff.invoke('ff:dictation-toggle', { toHub: true });
  });
  $('#history-clear').addEventListener('click', () => { if (state && state.history.length && confirm(t('Effacer tout l’historique ?'))) ff.invoke('ff:history', { action: 'clear' }); });
  // ---- dictionary form (add / edit) + live test
  function resetVocabForm() {
    const f = $('#dict-form');
    delete f.dataset.editing;
    f.classList.remove('editing');
    $('#dict-word').value = ''; $('#dict-sounds').value = '';
    $('#dict-submit').textContent = t('Ajouter');
    $('#dict-edit-cancel').hidden = true;
  }
  function editVocab(v) {
    const f = $('#dict-form');
    f.dataset.editing = v.word;
    f.classList.add('editing');
    $('#dict-word').value = v.word;
    $('#dict-sounds').value = (v.sounds || []).join(', ');
    $('#dict-submit').textContent = t('Enregistrer@save');
    $('#dict-edit-cancel').hidden = false;
    $('#dict-sounds').focus();
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('#dict-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = $('#dict-word').value.trim();
    if (!word) { $('#dict-word').focus(); return; }
    const editing = $('#dict-form').dataset.editing;
    await ff.invoke('ff:dictionary', { action: editing ? 'update' : 'add', word, sounds: $('#dict-sounds').value, previous: editing });
    toast(editing ? 'Mot mis à jour' : 'Mot ajouté');
    resetVocabForm();
  });
  $('#dict-edit-cancel').addEventListener('click', resetVocabForm);
  $('#dict-restore').addEventListener('click', async () => { await ff.invoke('ff:dictionary', { action: 'restore-defaults' }); toast('Mots par défaut ajoutés'); });
  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const text = $('#dict-test').value;
      const out = $('#dict-test-out');
      if (!text.trim()) { out.textContent = t('Le résultat corrigé s’affiche ici.'); out.classList.add('muted'); return; }
      out.classList.remove('muted');
      out.textContent = await ff.invoke('ff:format-preview', text);
    }, 120);
  }
  $('#dict-test').addEventListener('input', refreshPreview);
  $('#snippet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const trig = $('#snippet-trigger'), exp = $('#snippet-expansion');
    if (trig.value.trim()) { await ff.invoke('ff:snippets', { action: 'add', trigger: trig.value, expansion: exp.value }); trig.value = ''; exp.value = ''; }
  });
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => ff.invoke('ff:set-settings', { mode: r.value })));
  $('#set-language').addEventListener('change', (e) => ff.invoke('ff:set-settings', { language: e.target.value }));
  $('#set-uilang').addEventListener('change', (e) => ff.invoke('ff:set-settings', { uiLanguage: e.target.value }));
  $('#set-mic').addEventListener('change', (e) => ff.invoke('ff:set-settings', { microphoneId: e.target.value }));
  $('#set-autopaste').addEventListener('change', (e) => ff.invoke('ff:set-settings', { autoPaste: e.target.checked }));
  $('#set-login').addEventListener('change', (e) => ff.invoke('ff:set-settings', { launchAtLogin: e.target.checked }));
  $('#set-model').addEventListener('change', (e) => { ff.invoke('ff:set-settings', { model: e.target.value }); toast('Changement de modèle : le moteur redémarre'); });
  $('#perm-mic-btn').addEventListener('click', () => ff.invoke('ff:mac-permission', 'microphone'));
  $('#perm-ax-btn').addEventListener('click', () => ff.invoke('ff:mac-permission', 'accessibility'));
  $('#open-logs').addEventListener('click', () => ff.invoke('ff:open-logs'));
  $('#open-data').addEventListener('click', () => ff.invoke('ff:open-path', state.paths.userData));

  // Shortcut recorder: "Enregistrer" starts listening (the active shortcut is
  // suspended so the keys reach this window), every new chord replaces the
  // previous one, "Arrêter" stops listening, "Confirmer" saves. Modifier-only
  // chords such as Ctrl+Win are allowed (handled by the low-level hook).
  const CODE_MAP = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`', CapsLock: 'Capslock' };
  function codeToKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
    return CODE_MAP[code] || null;
  }
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
  const MOD_CODES = { ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Super', MetaRight: 'Super', OSLeft: 'Super', OSRight: 'Super' };
  const MOD_FLAG = { Ctrl: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Super: 'metaKey' };
  const KEY_LABEL = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj', Super: 'Win', Space: 'Espace', Enter: 'Entrée', Backspace: 'Retour@key', Delete: 'Suppr', Insert: 'Inser', Up: '↑', Down: '↓', Left: '←', Right: '→', Capslock: 'Verr. Maj' };
  // On a Mac, Electron's "Super" is Command and "Alt" is Option.
  const KEY_LABEL_MAC = { ...KEY_LABEL, Ctrl: '⌃ Ctrl', Alt: '⌥ Option', Shift: '⇧ Maj', Super: '⌘ Cmd', Backspace: '⌫' };
  function keyLabel(k) { const l = (isMac ? KEY_LABEL_MAC : KEY_LABEL)[k]; return l ? t(l) : k; }
  function prettyAcc(acc) { return String(acc || '').split('+').filter(Boolean).map(keyLabel).join(' + '); }
  function accFrom(mods, key) { return [...MOD_ORDER.filter((m) => mods.has(m)), ...(key ? [key] : [])].join('+'); }

  // One recorder per shortcut: "shortcut" (dictation, modifier-only chords allowed)
  // and "pshortcut" (the bar's panel, a normal key needed).
  function makeRecorder({ prefix, settingKey, which, okKey, modifierOnly }) {
    const el = (id) => $(`#${prefix}-${id}`);
    const sc = { recording: false, held: new Set(), mods: new Set(), key: null, pending: null, error: null };
    function localCheck(acc) {
      const parts = String(acc || '').split('+').filter(Boolean);
      const mods = parts.filter((p) => MOD_ORDER.includes(p));
      const key = parts.find((p) => !MOD_ORDER.includes(p));
      if (!parts.length) return t('Appuie sur au moins une combinaison.');
      if (!key) {
        if (!modifierOnly) return t('Ajoute une touche normale (ex. H) à tes touches de modification.');
        return mods.length >= 2 ? null : t('Avec seulement des touches de modification, il en faut au moins deux (ex. {ex}).', { ex: isMac ? '⌃ Ctrl + ⌥ Option' : 'Ctrl + Win' });
      }
      if (!mods.length && !/^F\d{1,2}$/.test(key)) return t(isMac ? 'Ajoute ⌃ Ctrl, ⌥ Option, ⇧ Maj ou ⌘ Cmd (ou utilise une touche F1 à F12).' : 'Ajoute Ctrl, Alt, Maj ou Win (ou utilise une touche F1 à F12).');
      return null;
    }
    function renderKeys(acc, cls, placeholder) {
      const box = el('keys');
      box.className = 'shortcut-keys' + (cls ? ' ' + cls : '');
      if (!acc) { box.innerHTML = `<span class="placeholder">${esc(placeholder || '—')}</span>`; return; }
      box.innerHTML = acc.split('+').map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`).join('<span class="plus">+</span>');
    }
    function update() {
      if (!state) return;
      const current = state.settings[settingKey];
      const ok = state[okKey];
      const pending = sc.pending && sc.pending !== current ? sc.pending : null;
      const problem = pending ? localCheck(pending) : null;
      let hint;
      if (sc.recording) {
        renderKeys(sc.pending, 'recording', t('Appuie sur tes touches…'));
        hint = problem || t('Appuie sur la combinaison voulue (tu peux recommencer). Clique sur Arrêter quand c’est bon, puis sur Confirmer.');
      } else if (pending) {
        renderKeys(pending, problem || sc.error ? 'bad' : 'pending');
        hint = sc.error || problem || t('Nouveau raccourci prêt : clique sur Confirmer pour l’utiliser.');
      } else {
        renderKeys(current, ok ? '' : 'bad');
        hint = sc.error || t(ok ? 'Raccourci actif. Clique sur Enregistrer pour en choisir un autre.' : 'Ce raccourci ne fonctionne pas (déjà pris par une autre application ?). Enregistres-en un autre.');
      }
      el('hint').textContent = hint;
      el('hint').classList.toggle('bad', !!(sc.error || (problem && !sc.recording)));
      const rb = el('record');
      rb.innerHTML = sc.recording ? `<span class="rec-dot"></span>${esc(t('Arrêter'))}` : esc(t('Enregistrer'));
      rb.classList.toggle('recording', sc.recording);
      el('confirm').disabled = !pending || !!problem;
      el('cancel').hidden = !(sc.recording || pending);
    }
    async function setRecording(on) {
      if (on) recorders.forEach((r) => { if (r !== api && r.sc.recording) r.setRecording(false); });
      sc.recording = on; sc.held.clear(); sc.error = null;
      if (on) { sc.pending = null; sc.mods = new Set(); sc.key = null; }
      update();
      try { await ff.invoke('ff:shortcut-suspend', on); } catch { /* ignore */ }
    }
    el('record').addEventListener('click', () => setRecording(!sc.recording));
    el('cancel').addEventListener('click', async () => { sc.pending = null; sc.error = null; if (sc.recording) await setRecording(false); update(); });
    el('confirm').addEventListener('click', async () => {
      const acc = sc.pending;
      if (!acc) return;
      if (sc.recording) await setRecording(false);
      const test = await ff.invoke('ff:shortcut-test', acc, which);
      if (!test.ok) { sc.error = test.error ? t(test.error) : t('« {keys} » est indisponible.', { keys: prettyAcc(acc) }); update(); return; }
      await ff.invoke('ff:set-settings', { [settingKey]: acc });
      sc.pending = null; sc.error = null;
      toast(t('Raccourci : {keys}', { keys: prettyAcc(acc) }));
      update();
    });
    function keydown(e) {
      // Forget modifiers the OS released without telling us (e.g. Win opening the Start menu).
      for (const c of [...sc.held]) { const m = MOD_CODES[c]; if (m && c !== e.code && !e[MOD_FLAG[m]]) sc.held.delete(c); }
      if (!sc.held.size) { sc.mods = new Set(); sc.key = null; }    // a new chord replaces the previous one
      sc.held.add(e.code);
      const mod = MOD_CODES[e.code];
      if (mod) sc.mods.add(mod);
      else {
        const k = codeToKey(e.code);
        if (!k) { sc.error = t('La touche « {key} » n’est pas prise en charge.', { key: e.key }); update(); return; }
        sc.key = k;
      }
      sc.error = null;
      sc.pending = accFrom(sc.mods, sc.key);
      update();
    }
    const api = { sc, update, setRecording, keydown };
    return api;
  }
  const recorders = [];
  recorders.push(makeRecorder({ prefix: 'shortcut', settingKey: 'shortcut', which: 'main', okKey: 'shortcutOk', modifierOnly: true }));
  recorders.push(makeRecorder({ prefix: 'pshortcut', settingKey: 'panelShortcut', which: 'panel', okKey: 'panelShortcutOk', modifierOnly: false }));
  function updateShortcutUi() { recorders.forEach((r) => r.update()); }
  const activeRecorder = () => recorders.find((r) => r.sc.recording);
  window.addEventListener('keydown', (e) => {
    const r = activeRecorder();
    if (!r) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) r.keydown(e);
  }, true);
  window.addEventListener('keyup', (e) => {
    const r = activeRecorder();
    if (!r) return;
    e.preventDefault(); e.stopPropagation();
    r.sc.held.delete(e.code);
  }, true);
  window.addEventListener('blur', () => { recorders.forEach((r) => r.sc.held.clear()); });

  // ---- IPC from main
  ff.on('ff:state', (s) => { state = s; phase = s.phase || phase; render(); });
  ff.on('ff:dictation', (p) => {
    phase = p.phase;
    if (phase === 'idle' || phase === 'error') { if (phase === 'idle') hubDictation = false; if (learnWord && phase === 'idle') learnWord = null; }
    if (phase === 'error' && p.message) toast(p.message);
    render();
  });
  ff.on('ff:insert', (text) => {
    const ta = insertTarget && document.body.contains(insertTarget) ? insertTarget : $('#try-area');
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start), after = ta.value.slice(end);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + sep + text + after;
    const pos = (before + sep + text).length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    ta.dispatchEvent(new Event('input'));          // a note saves itself
  });

  // ---- settings added in 1.2: the bar, learning from corrections
  $('#set-showbar').addEventListener('change', (e) => ff.invoke('ff:set-settings', { showBar: e.target.checked }));
  $('#set-learn').addEventListener('change', (e) => ff.invoke('ff:set-settings', { learnCorrections: e.target.checked }));

  function renderExtra() {
    const s = state.settings;
    $('#set-showbar').checked = !!s.showBar;
    $('#set-learn').checked = !!s.learnCorrections;
    $('#set-learn-row').hidden = !state.canLearn;
    $('#nav-rec').hidden = !state.meetingRec.recording;
    renderLearned();
    renderNotes();
    renderMeetings();
  }

  // ---- History: correct a dictation (the changed words can go to the dictionary)
  function historyEditor(h) {
    const node = el(`<div class="item"><div><textarea class="edit-area">${esc(h.text)}</textarea>
      <div class="edit-tools"><button class="btn small primary" data-act="save">${esc(t('Enregistrer@save'))}</button><button class="btn small ghost" data-act="cancel">${esc(t('Annuler'))}</button></div>
      <div class="learned-inline" hidden></div></div><div></div></div>`);
    const ta = node.querySelector('textarea');
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    node.querySelector('[data-act=cancel]').addEventListener('click', () => { editingHistory = null; render(); });
    node.querySelector('[data-act=save]').addEventListener('click', async () => {
      const res = await ff.invoke('ff:history', { action: 'edit', id: h.id, text: ta.value });
      editingHistory = null;
      const found = (res && res.suggestions) || [];
      // Only the casing changed ("openai" -> "OpenAI"): the word itself fixes it.
      const casing = found.filter((x) => !x.sounds.length);
      for (const x of casing) await ff.invoke('ff:dictionary', { action: 'add', word: x.word, sounds: [] });
      const variants = found.filter((x) => x.sounds.length);
      if (variants.length) {
        sugg.rows = variants.map((x) => ({ word: x.word, items: x.sounds.map((t) => ({ text: t, risky: false, on: true })) }));
        navigate('dictionary');
        showSuggest({ title: t('Ajouter tes corrections au dictionnaire ?'), hint: t('Tu as remplacé ces mots dans ta dictée. Coche ce que FreeFlow doit corriger tout seul la prochaine fois.'), running: false, progress: null });
      } else toast(casing.length ? t('Dictée corrigée · {words} ajouté au dictionnaire', { words: casing.map((x) => x.word).join(', ') }) : 'Dictée corrigée');
      render();
    });
    return node;
  }

  // ---- Words learned from the corrections made after a paste
  function renderLearned() {
    const list = state.learned || [];
    $('#learned-card').hidden = !list.length;
    const box = $('#learned-list');
    const key = JSON.stringify([list, lang]);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = '';
    for (const l of list) {
      const row = el(`<div class="learned-row"><div class="spacer"><span class="lw">${esc(l.word)}</span> <span class="lh">${esc(l.sounds.length ? t('au lieu de « {words} »', { words: l.sounds.join(', ') }) : t('avec cette écriture'))}</span></div>
        <button class="btn small primary">${esc(t('Ajouter'))}</button><button class="btn small ghost">${esc(t('Ignorer'))}</button></div>`);
      const [add, skip] = row.querySelectorAll('button');
      add.addEventListener('click', async () => { await ff.invoke('ff:learned', { action: 'accept', word: l.word, sounds: l.sounds }); toast(t('« {word} » ajouté au dictionnaire', { word: l.word })); });
      skip.addEventListener('click', () => ff.invoke('ff:learned', { action: 'dismiss', word: l.word }));
      box.appendChild(row);
    }
  }

  // ---- Notes ------------------------------------------------------------------
  const note = { id: null, saveTimer: null, query: '' };
  function renderNotes() {
    const list = $('#notes-list');
    const q = note.query.trim().toLowerCase();
    const items = state.notes.filter((n) => !q || (n.title + ' ' + n.preview).toLowerCase().includes(q));
    const key = JSON.stringify([items.map((n) => [n.id, n.updatedAt]), note.id, lang]);
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    list.innerHTML = items.length ? '' : `<div class="empty">${esc(t(q ? 'Aucune note ne correspond.' : 'Aucune note. Clique sur « Nouvelle note », puis sur le micro.'))}</div>`;
    for (const n of items) {
      const title = n.title === 'Note sans titre' ? t(n.title) : n.title;
      const b = el(`<button class="note-item${n.id === note.id ? ' active' : ''}"><div class="nt">${esc(title)}</div><div class="np">${esc(n.preview.split('\n').slice(1).join(' ') || '')}</div><div class="nd">${esc(relTime(n.updatedAt))}${n.meetingId ? esc(t(' · réunion')) : ''}</div></button>`);
      b.addEventListener('click', () => openNote(n.id));
      list.appendChild(b);
    }
    if (note.id && !state.notes.some((n) => n.id === note.id)) closeNote();
  }
  async function openNote(id) {
    await flushNote();
    const n = await ff.invoke('ff:notes', { action: 'get', id });
    if (!n) return;
    note.id = n.id;
    $('#note-empty').hidden = true;
    $('#note-body').hidden = false;
    $('#note-text').value = n.text;
    $('#note-status').textContent = t('Enregistré');
    $('#notes-list').dataset.key = '';
    renderNotes();
  }
  function closeNote() {
    note.id = null;
    $('#note-empty').hidden = false;
    $('#note-body').hidden = true;
  }
  async function flushNote() {
    if (!note.saveTimer) return;
    clearTimeout(note.saveTimer); note.saveTimer = null;
    await ff.invoke('ff:notes', { action: 'save', id: note.id, text: $('#note-text').value });
    $('#note-status').textContent = t('Enregistré');
  }
  async function newNote(dictate) {
    navigate('notes');
    const n = await ff.invoke('ff:notes', { action: 'new', text: '' });
    await openNote(n.id);
    $('#note-text').focus();
    if (dictate) dictateInto($('#note-text'));
  }
  async function dictateInto(textarea) {
    insertTarget = textarea;
    hubDictation = true;
    await ff.invoke('ff:dictation-toggle', { toHub: true });
  }
  $('#note-new').addEventListener('click', () => newNote(false));
  $('#note-search').addEventListener('input', (e) => { note.query = e.target.value; renderNotes(); });
  $('#note-text').addEventListener('input', () => {
    if (!note.id) return;
    $('#note-status').textContent = t('Modification…');
    clearTimeout(note.saveTimer);
    note.saveTimer = setTimeout(flushNote, 600);
  });
  $('#note-mic').addEventListener('click', () => {
    if (phase === 'listening') { ff.invoke('ff:dictation-toggle', {}); return; }
    $('#note-text').focus();
    dictateInto($('#note-text'));
  });
  $('#note-copy').addEventListener('click', async () => { await flushNote(); await ff.invoke('ff:notes', { action: 'copy', id: note.id }); toast('Note copiée'); });
  $('#note-export').addEventListener('click', async () => { await flushNote(); if (await ff.invoke('ff:notes', { action: 'export', id: note.id })) toast('Note exportée'); });
  $('#note-delete').addEventListener('click', async () => {
    if (!note.id || !confirm(t('Supprimer cette note ?'))) return;
    clearTimeout(note.saveTimer); note.saveTimer = null;
    await ff.invoke('ff:notes', { action: 'delete', id: note.id });
    closeNote();
  });
  $('#try-area').addEventListener('focus', () => { insertTarget = $('#try-area'); });
  $('#mic-btn').addEventListener('click', () => { insertTarget = $('#try-area'); }, true);

  // ---- Meetings: recorded here (this page keeps running when the window is closed)
  const mt = { rec: null, view: null, audioUrl: null };
  function clock(sec) {
    const t = Math.max(0, Math.floor(sec || 0)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s2 = t % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s2)}` : `${two(m)}:${two(s2)}`;
  }

  async function startMeeting() {
    if (mt.rec) return;
    const s = state.settings;
    let mic = null, sys = null;
    try {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      if (s.microphoneId && s.microphoneId !== 'default') audio.deviceId = { exact: s.microphoneId };
      mic = await navigator.mediaDevices.getUserMedia({ audio }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch (e) {
      toast('Micro indisponible : la réunion ne peut pas démarrer.');
      return;
    }
    try {
      // The computer's sound (Zoom, Meet, Teams…): a "screen share" whose video is dropped at once.
      sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      sys.getVideoTracks().forEach((t) => t.stop());
      if (!sys.getAudioTracks().length) sys = null;
    } catch { sys = null; }
    const tracks = ['mic', ...(sys ? ['computer'] : [])];
    const res = await ff.invoke('ff:meeting-begin', { name: $('#meeting-name').value, tracks });
    if (!res.ok) { toast(res.error); [mic, sys].forEach((st) => st && st.getTracks().forEach((t) => t.stop())); return; }
    const ctx = new AudioContext();
    const rec = { id: res.id, ctx, streams: [mic, sys].filter(Boolean), recorders: [], meters: [], pending: Promise.resolve(), paused: false, raf: 0 };
    const add = (stream, track, meterEl) => {
      const r = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 });
      r.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        rec.pending = rec.pending.then(async () => ff.send('ff:meeting-chunk', { id: rec.id, track, data: await e.data.arrayBuffer() }));
      };
      rec.recorders.push(r);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      rec.meters.push({ an, el: meterEl, buf: new Float32Array(an.fftSize) });
    };
    add(mic, 'mic', $('#meter-mic'));
    if (sys) add(sys, 'computer', $('#meter-sys'));
    rec.recorders.forEach((r) => r.start(1000));
    const tick = () => {
      for (const m of rec.meters) {
        m.an.getFloatTimeDomainData(m.buf);
        let sum = 0; for (let i = 0; i < m.buf.length; i += 2) sum += m.buf[i] * m.buf[i];
        m.el.style.width = `${Math.min(100, Math.pow(Math.sqrt(sum / (m.buf.length / 2)) * 5, 0.7) * 100)}%`;
      }
      rec.raf = requestAnimationFrame(tick);
    };
    tick();
    mt.rec = rec;
    $('#meeting-hint').textContent = t(sys ? 'Enregistrement en cours : ton micro (« Moi ») et le son de l’ordinateur (« Eux »).'
      : 'Enregistrement du micro seulement : le son de l’ordinateur n’a pas pu être capté sur cet appareil.');
    renderMeetings();
  }

  async function stopMeeting(cancel) {
    const rec = mt.rec;
    if (!rec) return;
    mt.rec = null;
    cancelAnimationFrame(rec.raf);
    await Promise.all(rec.recorders.map((r) => new Promise((resolve) => {
      if (r.state === 'inactive') return resolve();
      r.addEventListener('stop', resolve, { once: true });
      r.stop();
    })));
    rec.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    try { await rec.ctx.close(); } catch { /* ignore */ }
    await rec.pending;                                      // every chunk is on the disk
    document.querySelectorAll('.meter-bar i').forEach((i) => { i.style.width = '0'; });
    await ff.invoke('ff:meeting-end', { id: rec.id, cancel: !!cancel });
    $('#meeting-name').value = '';
    $('#meeting-hint').textContent = t(cancel ? 'Enregistrement annulé.' : 'Réunion arrêtée : la transcription se fait sur ton ordinateur, tu peux continuer à travailler.');
    if (!cancel) openMeeting(rec.id);
    renderMeetings();
  }

  async function pauseMeeting(paused) {
    const rec = mt.rec;
    if (!rec) return;
    rec.paused = paused;
    rec.recorders.forEach((r) => (paused ? r.pause() : r.resume()));
    await ff.invoke('ff:meeting-pause', { paused });
    renderMeetings();
  }

  // The recording clock ticks here (the state only arrives when something changes).
  setInterval(() => {
    const r = state && state.meetingRec;
    if (!r || !r.recording) return;
    const ms = (r.paused ? r.pausedAt : Date.now()) - r.startedAt - r.pausedMs;
    $('#meeting-clock').textContent = clock(ms / 1000);
  }, 500);

  // Started from the bar or the tray: main runs this with a user gesture (needed by getDisplayMedia).
  window.__ffMeeting = { start: () => startMeeting(), stop: () => stopMeeting(false) };
  ff.on('ff:meeting-cmd', ({ cmd }) => {
    if (cmd === 'stop') stopMeeting(false);
    if (cmd === 'pause') pauseMeeting(true);
    if (cmd === 'resume') pauseMeeting(false);
  });
  $('#meeting-start').addEventListener('click', startMeeting);
  $('#meeting-stop').addEventListener('click', () => stopMeeting(false));
  $('#meeting-cancel').addEventListener('click', () => { if (confirm(t('Arrêter sans garder cet enregistrement ?'))) stopMeeting(true); });
  $('#meeting-pause').addEventListener('click', () => pauseMeeting(!(mt.rec && mt.rec.paused)));
  $('#meeting-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    toast('Import en cours…');
    const res = await ff.invoke('ff:meeting', { action: 'import', data: await f.arrayBuffer(), fileName: f.name });
    if (!res || !res.ok) { toast((res && res.error) || 'Import impossible.'); return; }
    openMeeting(res.id);
  });

  function renderMeetings() {
    const r = state.meetingRec;
    const recording = !!r.recording;
    $('#meeting-rec').classList.toggle('recording', recording);
    $('#meeting-start').hidden = recording;
    $('#meeting-running').hidden = !recording;
    $('#meeting-cancel').hidden = !recording;
    $('#meeting-pause').textContent = t(r.paused ? 'Reprendre' : 'Pause');
    $('#meeting-clock').textContent = clock((r.elapsedMs || 0) / 1000);
    const list = $('#meetings-list');
    const key = JSON.stringify([state.meetings.map((m) => [m.id, m.status, m.progress, m.name, m.durationSec]), mt.view, lang]);
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.innerHTML = state.meetings.length ? '' : `<div class="empty">${esc(t('Aucune réunion pour le moment.'))}</div>`;
      const status = { recording: 'en cours d’enregistrement', transcribing: 'transcription…', done: '', error: 'erreur', interrupted: 'interrompue' };
      for (const m of state.meetings) {
        const date = new Date(m.createdAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const b = el(`<button class="meeting-item${m.id === mt.view ? ' active' : ''}"><div class="mt">${esc(m.name)}</div>
          <div class="mm">${esc(date)}${m.durationSec ? ' · ' + clock(m.durationSec) : ''}${status[m.status] ? ' · ' + esc(t(status[m.status])) : ''}</div>
          ${m.status === 'transcribing' ? `<div class="progress"><span style="width:${Math.round((m.progress || 0) * 100)}%"></span></div>` : ''}
          ${m.preview ? `<div class="mp">${esc(m.preview)}</div>` : ''}</button>`);
        b.addEventListener('click', () => openMeeting(m.id));
        list.appendChild(b);
      }
    }
    // the open meeting changed state (transcription finished…): refresh its view
    const open = state.meetings.find((m) => m.id === mt.view);
    if (open && mt.viewStatus !== open.status) openMeeting(open.id);
    else if (open && open.status === 'transcribing') {
      const p = document.querySelector('#meeting-view .mv-status');
      if (p) p.textContent = t('Transcription en cours… {pct} % (tu peux continuer à dicter pendant ce temps).', { pct: Math.round((open.progress || 0) * 100) });
    }
  }

  async function openMeeting(id) {
    mt.view = id;
    const m = await ff.invoke('ff:meeting', { action: 'get', id });
    const v = $('#meeting-view');
    if (!m) { v.innerHTML = `<div class="note-empty">${esc(t('Réunion introuvable.'))}</div>`; return; }
    mt.viewStatus = m.status;
    if (mt.audioUrl) { URL.revokeObjectURL(mt.audioUrl); mt.audioUrl = null; }
    const date = new Date(m.createdAt).toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    v.innerHTML = '';
    const head = el(`<div><div class="mv-head"><input type="text" value="${esc(m.name)}" title="${esc(t('Renommer'))}"></div>
      <div class="mv-meta">${esc(date)}${m.durationSec ? ' · ' + clock(m.durationSec) : ''}${m.words ? ' · ' + esc(tn(m.words, '{n} mot', '{n} mots')) : ''}</div>
      <div class="mv-tools"></div></div>`);
    v.appendChild(head);
    const name = head.querySelector('input');
    name.addEventListener('change', () => ff.invoke('ff:meeting', { action: 'rename', id, name: name.value }));
    const tools = head.querySelector('.mv-tools');
    const tool = (label, fn, cls = '') => { const b = el(`<button class="btn small ${cls}">${esc(t(label))}</button>`); b.addEventListener('click', fn); tools.appendChild(b); };
    if (m.status === 'done') {
      tool('Copier', async () => { await ff.invoke('ff:meeting', { action: 'copy', id }); toast('Transcription copiée'); });
      tool('Exporter', async () => { if (await ff.invoke('ff:meeting', { action: 'export', id })) toast('Réunion exportée'); });
      tool('Envoyer dans les notes', async () => { const n = await ff.invoke('ff:meeting', { action: 'to-note', id }); if (n) { navigate('notes'); openNote(n.id); } });
    }
    if (m.status === 'error' || m.status === 'interrupted') tool('Transcrire à nouveau', () => ff.invoke('ff:meeting', { action: 'retry', id }), 'primary');
    tool('Ouvrir le dossier', () => ff.invoke('ff:meeting', { action: 'folder', id }));
    tool('Supprimer', async () => { if (confirm(t('Supprimer cette réunion et son audio ?'))) { await ff.invoke('ff:meeting', { action: 'delete', id }); mt.view = null; v.innerHTML = `<div class="note-empty">${esc(t('Réunion supprimée.'))}</div>`; } }, 'danger');
    if (m.status !== 'done') {
      const msg = m.status === 'recording' ? t('Enregistrement en cours…')
        : m.status === 'transcribing' ? t('Transcription en cours… {pct} % (tu peux continuer à dicter pendant ce temps).', { pct: Math.round((m.progress || 0) * 100) })
          : t(m.error || 'Cette réunion n’a pas pu être transcrite.');
      v.appendChild(el(`<div class="mv-status${m.status === 'error' || m.status === 'interrupted' ? ' bad' : ''}">${esc(msg)}</div>`));
      renderMeetings();
      return;
    }
    const audio = await ff.invoke('ff:meeting', { action: 'audio', id });
    let player = null;
    if (audio) {
      mt.audioUrl = URL.createObjectURL(new Blob([audio.data], { type: audio.type }));
      player = el(`<audio class="mv-player" controls preload="metadata" src="${mt.audioUrl}"></audio>`);
      v.appendChild(player);
    }
    const lines = el('<div class="mv-lines"></div>');
    if (!m.lines.length) lines.appendChild(el(`<div class="mv-status">${esc(t('Personne n’a parlé pendant cet enregistrement.'))}</div>`));
    for (const l of m.lines) {
      const row = el(`<div class="mv-line ${esc(l.track)}" title="${esc(t('Écouter à partir d’ici'))}"><span class="lt">${clock(l.start)}</span><span class="ls">${esc(t(l.speaker))}</span><span>${esc(l.text)}</span></div>`);
      row.addEventListener('click', () => { if (player) { player.currentTime = l.start; player.play(); } });
      lines.appendChild(row);
    }
    v.appendChild(lines);
    if (player) {
      player.addEventListener('timeupdate', () => {
        const t = player.currentTime;
        lines.querySelectorAll('.mv-line').forEach((row, i) => row.classList.toggle('playing', t >= m.lines[i].start && t < m.lines[i].end + 0.5));
      });
    }
    renderMeetings();
  }

  // ---- First-launch tutorial (skippable, shown once; "Revoir le tutoriel" in Paramètres)
  const tour = { step: 0, shown: false };
  const TOUR_STEPS = 5;
  function tourRender() {
    document.querySelectorAll('.tour-slide').forEach((s) => { s.hidden = Number(s.dataset.step) !== tour.step; });
    $('#tour-dots').innerHTML = Array.from({ length: TOUR_STEPS }, (_, i) => `<i class="${i === tour.step ? 'on' : ''}"></i>`).join('');
    $('#tour-prev').disabled = tour.step === 0;
    $('#tour-next').textContent = t(tour.step === TOUR_STEPS - 1 ? 'C’est parti' : 'Suivant');
    document.querySelectorAll('#tour-langs [data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
    const acc = state ? state.settings.shortcut : 'Ctrl+Alt+Space';
    $('#tour-keys').innerHTML = acc.split('+').map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`).join('<span class="plus">+</span>');
    if (state) $('#tour-panel-key').textContent = prettyAcc(state.settings.panelShortcut);
  }
  function openTour() {
    tour.step = 0; tour.shown = true;
    $('#tour-login').checked = !!(state && state.settings.launchAtLogin);
    tourRender();
    $('#tour').hidden = false;
  }
  async function closeTour() {
    $('#tour').hidden = true;
    await ff.invoke('ff:set-settings', { onboarded: true });
  }
  $('#tour-skip').addEventListener('click', closeTour);
  $('#tour-prev').addEventListener('click', () => { if (tour.step > 0) { tour.step -= 1; tourRender(); } });
  $('#tour-next').addEventListener('click', async () => {
    if (tour.step < TOUR_STEPS - 1) { tour.step += 1; tourRender(); return; }
    const login = $('#tour-login').checked;
    if (state && login !== !!state.settings.launchAtLogin) await ff.invoke('ff:set-settings', { launchAtLogin: login });
    await closeTour();
    navigate('home');
    toast(t('Essaie maintenant : {keys}, puis parle', { keys: prettyAcc(state.settings.shortcut) }));
  });
  // The language picked here is the app's and the dictation's (both can be changed in Paramètres).
  $('#tour-langs').innerHTML = I.LANGS.map((l) => `<button type="button" class="lang-btn" data-lang="${l}" lang="${l}">${esc(I.NAMES[l])}</button>`).join('');
  $('#tour-langs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    await ff.invoke('ff:set-settings', { uiLanguage: b.dataset.lang, language: b.dataset.lang });
  });
  window.addEventListener('keydown', (e) => {
    if ($('#tour').hidden || e.target.closest('#tour-langs')) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') $('#tour-next').click();
    else if (e.key === 'ArrowLeft') $('#tour-prev').click();
    else if (e.key === 'Escape') closeTour();
  });
  $('#tour-again').addEventListener('click', openTour);
  ff.on('ff:state', (s) => { if (s.showTour && !tour.shown) openTour(); });

  // ---- Language: the static page is translated by FFI18N, the lists are redrawn
  function applyLanguage(next) {
    if (next === lang && document.documentElement.dataset.lang === lang) return;
    lang = next;
    I.localize(lang);
    document.documentElement.dataset.lang = lang;
    dictKey = '';
    if (!$('#tour').hidden) tourRender();
    if (!$('#guide').hidden) guideRender();
    if (mt.view && $('#section-meetings').classList.contains('active')) setTimeout(() => openMeeting(mt.view), 0);
    refreshPreview();
  }
  $('#set-uilang').innerHTML = I.LANGS.map((l) => `<option value="${l}" lang="${l}">${esc(I.NAMES[l])}</option>`).join('');

  // ---- The Excel file, step by step (Dictionnaire, the import window and Paramètres)
  // Slides 1, 3 and 4 are screenshots of FreeFlow (renderer/hub/guide/<lang>-<n>.png,
  // made by --guide-shots); slide 2 draws the spreadsheet, slide 5 what changes.
  const guide = { step: 0 };
  const GUIDE_STEPS = 5;
  function excelMock() {
    const ex = I.EXAMPLES[lang];
    const rows = [...ex.slice(0, 4), ex[ex.length - 1]];
    return `<div class="xl" dir="ltr">
      <div class="xl-top"><span class="xl-logo">X</span><span class="xl-file">${esc(t('freeflow-dictionnaire-modele.xlsx'))}</span><span class="xl-win"><i></i><i></i><i></i></span></div>
      <div class="xl-fx"><span class="ref">A2</span><b>fx</b><span>${esc(rows[0][0])}</span></div>
      <div class="xl-grid">
        <div class="xl-row head"><span class="n"></span><span class="a">A</span><span class="b">B</span></div>
        <div class="xl-row"><span class="n">1</span><span class="hd">${esc(t('Mot correct'))}</span><span class="hd">${esc(t('Ce que le modèle entend (séparé par des virgules)'))}</span></div>
        ${rows.map(([w, h], i) => `<div class="xl-row"><span class="n">${i + 2}</span><span class="${i === 0 ? 'sel' : ''}">${esc(w)}</span><span class="${h ? '' : 'empty'}">${esc(h || t('(vide : FreeFlow devinera)'))}</span></div>`).join('')}
      </div>
      <div class="xl-tabs"><span class="on">${esc(t('Mes mots'))}</span><span>${esc(t('Mode d’emploi'))}</span><span class="plus">+</span></div>
    </div>
    <div class="xl-notes"><span class="badge a">${esc(t('A : le mot correct'))}</span><span class="badge b">${esc(t('B : ce que la dictée écrit'))}</span></div>`;
  }
  function guideRender() {
    document.querySelectorAll('.guide-slide').forEach((s) => { s.hidden = Number(s.dataset.step) !== guide.step; });
    $('#guide-dots').innerHTML = Array.from({ length: GUIDE_STEPS }, (_, i) => `<i class="${i === guide.step ? 'on' : ''}"></i>`).join('');
    $('#guide-prev').disabled = guide.step === 0;
    $('#guide-next').textContent = t(guide.step === GUIDE_STEPS - 1 ? 'Terminé' : 'Suivant');
    document.querySelectorAll('#guide img[data-shot]').forEach((img) => {
      const src = `guide/${lang}-${img.dataset.shot}.png`;
      if (img.getAttribute('src') === src) return;
      img.onerror = () => { img.onerror = null; img.src = `guide/fr-${img.dataset.shot}.png`; };
      img.src = src;
    });
    $('#guide-xl').innerHTML = excelMock();
    $('#guide-before').textContent = t('j’automatise tout avec n huit n et x field');
    $('#guide-after').textContent = t('J’automatise tout avec n8n et Higgsfield');
  }
  function openGuide() {
    guide.step = 0;
    guideRender();
    $('#guide').hidden = false;
  }
  function closeGuide() { $('#guide').hidden = true; }
  $('#guide-close').addEventListener('click', closeGuide);
  $('#guide').addEventListener('mousedown', (e) => { if (e.target.id === 'guide') closeGuide(); });
  $('#guide-prev').addEventListener('click', () => { if (guide.step > 0) { guide.step -= 1; guideRender(); } });
  $('#guide-next').addEventListener('click', () => {
    if (guide.step < GUIDE_STEPS - 1) { guide.step += 1; guideRender(); } else closeGuide();
  });
  window.addEventListener('keydown', (e) => {
    if ($('#guide').hidden) return;
    if (e.key === 'ArrowRight') $('#guide-next').click();
    else if (e.key === 'ArrowLeft') $('#guide-prev').click();
    else if (e.key === 'Escape') closeGuide();
  });
  document.querySelectorAll('[data-open-guide]').forEach((b) => b.addEventListener('click', openGuide));

  // ---- init
  ff.invoke('ff:get-state').then((s) => { state = s; phase = s.phase; render(); loadMics(); if (s.showTour && !tour.shown) openTour(); });
  ff.send('ff:hub-ready');
})();
