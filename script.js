/* ====== VERSJON ======
   - Alt lagres kun i minnet, og kan lastes ned som JSON/CSV
   - Utvidet med ekstra ting som kan måles
==================================== */

/* ====== HJELPEFUNKSJONER ====== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const nowISO = () => new Date().toISOString();

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/* ====== LOGGSTATE ====== */
const log = {
  version: '1.1.0',
  participantId: null,
  uiVersion: 'one_page', // kan du endre til f.eks. 'step_by_step' i den andre varianten
  runNumber: 1, // kan brukes hvis samme deltaker gjør to runder
  pageLoadedAt: null,

  startedAt: null,
  endedAt: null,
  msElapsed: 0,
  timeToFirstInteractionMs: null,

  mouseClicks: 0,
  touchTaps: 0,
  keyPresses: 0,
  backspaces: 0,

  scrollEvents: 0,
  maxScrollY: 0,

  validationErrors: 0,
  failedSubmissions: 0,
  taskSuccess: false, // true når innsending lykkes

  fieldErrorOnce: {},
  fieldStats: {
    // [fieldId]: { focusCount, totalFocusTimeMs, blurCount, corrections }
  },


  events: []
};

(function detectUiVersion() {
  // Let HTML define UI-versjon via data-attributt
  const uiElement = document.querySelector('[data-ui-version]');

  if (uiElement) {
    const detected = uiElement.getAttribute('data-ui-version');
    if (detected) {
      log.uiVersion = detected;
    }
  }
})();

// Hent runNumber fra sessionStorage (standard 1)
(function initRunNumber() {
  const stored = sessionStorage.getItem('runNumber');
  if (stored) {
    const n = Number(stored);
    if (!Number.isNaN(n) && n > 0) {
      log.runNumber = n;
    }
  } else {
    // første gang i denne fanen
    sessionStorage.setItem('runNumber', String(log.runNumber));
  }
})();

let timerStarted = false;
let currentFocusFieldId = null;
const fieldFocusStartTimes = {};

/* ====== FELTSTATS-HJELP ====== */
function ensureFieldStats(fieldId) {
  if (!fieldId) return null;
  if (!log.fieldStats[fieldId]) {
    log.fieldStats[fieldId] = {
      focusCount: 0,
      totalFocusTimeMs: 0,
      blurCount: 0,
      corrections: 0
    };
  }
  return log.fieldStats[fieldId];
}

/* ====== TIMER & EVENTS ====== */
function startTimerIfNeeded() {
  if (!timerStarted) {
    const now = new Date();
    log.startedAt = now.toISOString();
    timerStarted = true;

    // tid til første interaksjon fra sideinnlasting, hvis vi har det
    if (log.pageLoadedAt && log.timeToFirstInteractionMs == null) {
      log.timeToFirstInteractionMs =
        now.getTime() - new Date(log.pageLoadedAt).getTime();
    }
  }
}

function endTimer() {
  if (!log.startedAt) return;
  log.endedAt = nowISO();
  log.msElapsed = new Date(log.endedAt) - new Date(log.startedAt);
}

function recordEvent(type, detail = {}) {
  try {
    log.events.push({ t: Date.now(), type, ...detail });
  } catch {
    log.events.push({ t: Date.now(), type });
  }
}

/* ====== VALIDASJON ====== */
// Hjelper for radiogruppe-validasjon
function isRadioGroupValid(inputEl) {
  const form = inputEl.form || document;
  const group = form.querySelectorAll(
    `input[type="radio"][name="${CSS.escape(inputEl.name)}"]`
  );
  return Array.from(group).some((r) => r.checked);
}

// Hjelper for checkbox-validasjon (minst én hvis required)
function isCheckboxValid(inputEl) {
  if (inputEl.name) {
    const form = inputEl.form || document;
    const group = form.querySelectorAll(
      `input[type="checkbox"][name="${CSS.escape(inputEl.name)}"]`
    );
    if (group.length > 1) return Array.from(group).some((c) => c.checked);
  }
  return inputEl.checked;
}

// HTML pattern er forankret implisitt i spesifikasjonen; speil dette med ^...$
function testPatternFullMatch(inputEl) {
  try {
    const pattern = inputEl.pattern;
    if (!pattern) return true;
    const re = new RegExp(`^(?:${pattern})$`, 'u');
    return re.test((inputEl.value || '').trim());
  } catch {
    return inputEl.checkValidity();
  }
}

function showError(row, show) {
  const err = row?.querySelector?.('.error');
  if (!row || !err) return;
  err.style.display = show ? 'block' : 'none';
  row.classList.toggle('has-error', !!show);
}

function validateField(inputEl) {
  if (!inputEl) return true;
  const type = (inputEl.type || '').toLowerCase();

  // required
  if (inputEl.hasAttribute('required')) {
    if (type === 'radio') {
      if (!isRadioGroupValid(inputEl)) return false;
    } else if (type === 'checkbox') {
      if (!isCheckboxValid(inputEl)) return false;
    } else if (inputEl.tagName === 'SELECT') {
      const val = inputEl.value;
      if (!val || !String(val).trim()) return false;
    } else if (inputEl.multiple && inputEl.tagName === 'SELECT') {
      if (!(inputEl.selectedOptions?.length)) return false;
    } else {
      if (!inputEl.value || !inputEl.value.trim()) return false;
    }
  }

  // innebygd e-postvalidering
  if (type === 'email' && inputEl.value) {
    if (!inputEl.checkValidity()) return false;
  }

  // pattern (full match)
  if (inputEl.pattern && inputEl.value) {
    if (!testPatternFullMatch(inputEl)) return false;
  }

  return true;
}

/* ====== FOKUS/BLUR-HÅNDTERING ====== */
function handleFocusIn(e) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const row = target.closest?.('[data-field]');
  if (!row) return;

  const id = target.id || target.name || 'unknown';
  currentFocusFieldId = id;

  const stats = ensureFieldStats(id);
  if (stats) {
    stats.focusCount += 1;
  }

  fieldFocusStartTimes[id] = Date.now();
  recordEvent('focus', { field: id });
}

function handleBlur(e) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest?.('[data-field]');
  if (!row) return;

  const id = target.id || target.name || 'unknown';

  // Beregn tid brukt i feltet siden siste fokus
  const start = fieldFocusStartTimes[id];
  if (typeof start === 'number') {
    const delta = Date.now() - start;
    const stats = ensureFieldStats(id);
    if (stats) {
      stats.totalFocusTimeMs += delta;
      stats.blurCount += 1;
    }
    fieldFocusStartTimes[id] = undefined;
  }

  const ok = validateField(target);
  if (!ok) {
    showError(row, true);
    if (!log.fieldErrorOnce[id]) {
      log.fieldErrorOnce[id] = true;
      log.validationErrors += 1;
      recordEvent('validation_error', { field: id });
    }
  } else {
    showError(row, false);
    recordEvent('field_valid', { field: id });
  }
}

/* ====== INTERAKSJONSTELLERE ====== */
window.addEventListener(
  'pointerdown',
  (e) => {
    startTimerIfNeeded();
    if (e.pointerType === 'mouse') log.mouseClicks += 1;
    else if (e.pointerType === 'touch' || e.pointerType === 'pen') log.touchTaps += 1;
    recordEvent('pointer', { pointerType: e.pointerType || 'unknown' });
  },
  { capture: true }
);

window.addEventListener(
  'keydown',
  (e) => {
    startTimerIfNeeded();
    log.keyPresses += 1;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      log.backspaces += 1;
      recordEvent('correction_key', { key: e.key });

      // logg korreksjoner per felt
      if (currentFocusFieldId) {
        const stats = ensureFieldStats(currentFocusFieldId);
        if (stats) {
          stats.corrections += 1;
        }
      }
    } else {
      recordEvent('key', { key: e.key });
    }
  },
  { capture: true }
);

/* ====== SCROLL-LOGGING (mobilrelevant) ====== */
window.addEventListener(
  'scroll',
  () => {
    startTimerIfNeeded();
    log.scrollEvents += 1;
    log.maxScrollY = Math.max(log.maxScrollY, window.scrollY || 0);
    recordEvent('scroll', { y: window.scrollY || 0 });
  },
  { passive: true }
);

/* ====== STATUSVISNING (lokal) ====== */
function setServerStatus(text, level = 'info') {
  const el = $('#serverStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('info', 'ok', 'warn', 'error');
  el.classList.add('status', level);
}

/* ====== RESULTATVISNING & EKSPORT ====== */
function renderResults() {
  const exportArea = $('#exportArea');
  if (exportArea) exportArea.style.display = 'block';


  const secs = (log.msElapsed / 1000).toFixed(2);
  $('#timeTaken') && ($('#timeTaken').textContent = secs);
  $('#mouseClicks') && ($('#mouseClicks').textContent = String(log.mouseClicks));
  $('#touchTaps') && ($('#touchTaps').textContent = String(log.touchTaps));
  $('#keyPresses') && ($('#keyPresses').textContent = String(log.keyPresses));
  $('#backspaces') && ($('#backspaces').textContent = String(log.backspaces));
  $('#validationErrors') &&
    ($('#validationErrors').textContent = String(log.validationErrors));
  $('#failedSubmissions') &&
    ($('#failedSubmissions').textContent = String(log.failedSubmissions));

  const dlJson = $('#downloadJson');
  const dlCsv = $('#downloadCsv');

  if (dlJson) {
    dlJson.onclick = () => {
      downloadFile('log.json', JSON.stringify(log, null, 2), 'application/json');
    };
  }
  if (dlCsv) {
    dlCsv.onclick = () => {
      const rows = [
        [
          'participantId',
          'uiVersion',
          'runNumber',
          'pageLoadedAt',
          'startedAt',
          'endedAt',
          'msElapsed',
          'timeToFirstInteractionMs',
          'mouseClicks',
          'touchTaps',
          'keyPresses',
          'backspaces',
          'scrollEvents',
          'maxScrollY',
          'validationErrors',
          'failedSubmissions',
          'taskSuccess'
        ],
        [
          log.participantId ?? '',
          log.uiVersion ?? '',
          log.runNumber ?? '',
          log.pageLoadedAt ?? '',
          log.startedAt ?? '',
          log.endedAt ?? '',
          log.msElapsed,
          log.timeToFirstInteractionMs ?? '',
          log.mouseClicks,
          log.touchTaps,
          log.keyPresses,
          log.backspaces,
          log.scrollEvents,
          log.maxScrollY,
          log.validationErrors,
          log.failedSubmissions,
          log.taskSuccess ? 1 : 0
        ]
      ];
      downloadFile(
        'log.csv',
        rows.map((r) => r.map(escapeCsv).join(',')).join('\n'),
        'text/csv'
      );
    };
  }
}

/* ====== DOM-KLAR OPPKOBLING ====== */
document.addEventListener('DOMContentLoaded', () => {
  const form = $('#testForm');
  const resetBtn = $('#resetBtn');
  const participantInput = $('#participantId');

  log.pageLoadedAt = nowISO();

  if (!form) {
    console.warn('Fant ikke #testForm i DOM-en. Sjekk at ID stemmer.');
    return;
  }

  // Fokus-logging per felt
  form.addEventListener('focusin', handleFocusIn, { capture: true });

  // Valideringshendelser (blur)
  form.addEventListener('focusout', handleBlur);

  // Innsending (kun lokal logging + eksport)
  form.addEventListener('submit', (e) => {
    startTimerIfNeeded();

    const fields = form.querySelectorAll('input, select, textarea');
    let allValid = true;
    fields.forEach((el) => {
      const row = el.closest?.('[data-field]');
      if (!row) return;
      const ok = validateField(el);
      showError(row, !ok);
      if (!ok) {
        const id = el.id || el.name || 'unknown';
        if (!log.fieldErrorOnce[id]) {
          log.fieldErrorOnce[id] = true;
          log.validationErrors += 1;
          recordEvent('validation_error_submit', { field: id });
        }
        allValid = false;
      }
    });

    if (!allValid) {
      e.preventDefault();
      log.failedSubmissions += 1;
      recordEvent('submit_blocked', {});
      setServerStatus('Skjemaet har feil – rett opp feltene og prøv igjen.', 'warn');
      return;
    }

    e.preventDefault(); // ingen navigasjon – kun lokal logging
    endTimer();
    log.participantId = (participantInput?.value || '').trim() || null;
    log.taskSuccess = true;
    recordEvent('submit_success', {});

    setServerStatus('Data er klar – last ned med knappene under.', 'ok');
    renderResults();

    const nextUi =
        log.uiVersion === 'one_page' ? 'step_by_step' : 'one_page';
    sessionStorage.setItem('nextUiVersion', nextUi);

    const currentRun = Number(sessionStorage.getItem('runNumber') || '1');
    const nextRun = currentRun + 1;
    sessionStorage.setItem('runNumber', String(nextRun));

    const backBtn = document.getElementById('backToStartBtn');
    if (backBtn) {
        backBtn.style.display = 'inline-block';
        backBtn.onclick = () => {
        window.location.href = 'index.html'; // endre filnavn ved behov
        };
    }
  });

  // Reset (ny runde)
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      form.reset();
      $$('#testForm [data-field]').forEach((row) => showError(row, false));

      // Nullstill logg, men øk runNumber hvis du vil telle runder
      const prevRunNumber = log.runNumber || 1;

      Object.assign(log, {
        version: log.version,
        participantId: null,
        uiVersion: log.uiVersion,
        runNumber: prevRunNumber + 1,
        pageLoadedAt: nowISO(),

        startedAt: null,
        endedAt: null,
        msElapsed: 0,
        timeToFirstInteractionMs: null,

        mouseClicks: 0,
        touchTaps: 0,
        keyPresses: 0,
        backspaces: 0,

        scrollEvents: 0,
        maxScrollY: 0,

        validationErrors: 0,
        failedSubmissions: 0,
        taskSuccess: false,

        fieldErrorOnce: {},
        fieldStats: {},
        events: []
      });

      timerStarted = false;
      currentFocusFieldId = null;
      for (const k of Object.keys(fieldFocusStartTimes)) {
        delete fieldFocusStartTimes[k];
      }

      const exportArea = $('#exportArea');
      if (exportArea) exportArea.style.display = 'none';
      setServerStatus('');
    });
  }
});
