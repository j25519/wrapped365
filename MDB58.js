/* MDB58 — Turbo Music Discovery Engine.
 * Wrapped 365 integration, phase 1: consent UI and import lifecycle only.
 * No network requests, data export, recommendation model or persistent consent yet.
 * Future matching, contributions and API access belong in MDB58, not app.js.
 */
(() => {
  'use strict';

  const ENGINE_NAME = 'MDB58';
  let activeImport = null;
  let lastSuccessfulImportOptIn = false;
  let lastDialogTrigger = null;

  function optInInput() {
    return document.getElementById('mdb58-contribute');
  }

  function isOptedIn() {
    return optInInput()?.checked === true;
  }

  // Take a snapshot at the moment the user selects/drops their file.
  // This prevents changing a checkbox mid-import from changing its consent.
  function beginImport() {
    const session = Object.freeze({ optedIn: isOptedIn() });
    activeImport = session;
    return session;
  }

  function completeImport(session) {
    if (!session || session !== activeImport) return;
    lastSuccessfulImportOptIn = session.optedIn;
    activeImport = null;
    // Consent is per import; do not carry the checked box into the next upload.
    if (optInInput()) optInInput().checked = false;
    // Intentionally no persistence, upload, telemetry or report contents here.
    // A future MDB58 implementation can build its own minimal metadata payload
    // once the user has consented and the backend contract is agreed.
    window.dispatchEvent(new CustomEvent('mdb58:import-complete', {
      detail: { optedIn: lastSuccessfulImportOptIn, contributionAvailable: false }
    }));
  }

  function cancelImport(session) {
    if (session !== activeImport) return;
    activeImport = null;
    if (optInInput()) optInInput().checked = false;
  }

  // Recommendation gating hook for the future MDB58 UI.
  // Only meaningful for the most recent successful import in this page session.
  function mayRequestRecommendations() {
    return lastSuccessfulImportOptIn;
  }

  function mountUI() {
    const dropzone = document.getElementById('dropzone');
    if (!dropzone || document.getElementById('mdb58-optin')) return;

    const optIn = document.createElement('section');
    optIn.id = 'mdb58-optin';
    optIn.className = 'mdb58-optin';
    optIn.setAttribute('aria-label', 'MDB58 music discovery contribution');
    optIn.innerHTML = `
      <div class="mdb58-optin-main">
        <div class="mdb58-check-row">
          <label class="mdb58-label" for="mdb58-contribute">
            <input id="mdb58-contribute" type="checkbox" autocomplete="off">
            <span>Contribute my anonymised music library to <strong>MDB58</strong></span>
          </label>
          <button class="mdb58-help" id="mdb58-help" type="button"
                  aria-label="What is MDB58 and what data would be shared?"
                  aria-haspopup="dialog" aria-controls="mdb58-dialog">?</button>
        </div>
        <p>Help build community powered music recommendations. Completely optional.</p>
      </div>
      <span class="mdb58-preview">Preview · No data sent yet</span>`;
    dropzone.insertAdjacentElement('afterend', optIn);

    const dialog = document.createElement('dialog');
    dialog.id = 'mdb58-dialog';
    dialog.setAttribute('aria-labelledby', 'mdb58-dialog-title');
    dialog.setAttribute('aria-describedby', 'mdb58-dialog-description');
    dialog.innerHTML = `
      <div class="dialog-body">
        <button type="button" class="dialog-close" id="mdb58-dialog-close" aria-label="Close">×</button>
        <div class="kicker">COMMUNITY-POWERED DISCOVERY</div>
        <h2 id="mdb58-dialog-title">Meet MDB58</h2>
        <div id="mdb58-dialog-description">
          <p><strong>MDB58 (Turbo Music Discovery Engine)</strong> is our planned free, open-source music discovery engine, built to bring Spotify style recommendations to personal music libraries, including Wrapped 365.</p>
          <p><strong>What we'd store:</strong> Only anonymised music library metadata — artists, albums, tracks, and aggregated music preferences. No usernames, emails, account details, or original listening-history files.</p>
          <p><strong>Where it's stored:</strong> On infrastructure operated by the MDB58 project, not a third party analytics provider.</p>
          <p><strong>Entirely your choice:</strong> Without opting in, every other Wrapped 365 feature still works locally. MDB58 recommendations will be for contributors only, because the engine relies on shared libraries.</p>
          <p class="mdb58-dialog-note">Data sharing isn't active yet. Ticking the box currently sends nothing.</p>
        </div>
        <button id="mdb58-dialog-ok" type="button" class="btn btn-primary">Got it</button>
      </div>`;
    document.body.append(dialog);

    const help = document.getElementById('mdb58-help');
    function closeDialog() {
      dialog.close();
    }
    help.addEventListener('click', () => {
      lastDialogTrigger = help;
      dialog.showModal();
    });
    document.getElementById('mdb58-dialog-close').addEventListener('click', closeDialog);
    document.getElementById('mdb58-dialog-ok').addEventListener('click', closeDialog);
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('close', () => lastDialogTrigger?.focus());
  }

  const MDB58 = Object.freeze({
    name: ENGINE_NAME,
    fullName: 'Turbo Music Discovery Engine',
    phase: 'ui-only',
    isOptedIn,
    beginImport,
    completeImport,
    cancelImport,
    mayRequestRecommendations
  });
  window.MDB58 = MDB58;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountUI, { once: true });
  } else {
    mountUI();
  }
})();
