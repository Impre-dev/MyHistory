// ==UserScript==
// @name           MyHistory — accès
// @version        1.0.0
// @description    Historique en page pleine : hotkey Ctrl+Shift+H, icône de tab, exécutant des suppressions Places
// @author         Impre
// @include        main
// ==/UserScript==

(function () {
  'use strict';

  const PAGE_URL = 'chrome://sine/content/MyHistory/history.html';
  const ICON = 'chrome://sine/content/MyHistory/resources/MyHistory.png';

  /** Ouvre (ou focus) la page historique — pattern MyHub openHub */
  function openHistory() {
    for (const win of Services.wm.getEnumerator('navigator:browser')) {
      for (const tab of win.gBrowser.tabs) {
        if (tab.linkedBrowser.currentURI.spec === PAGE_URL) {
          win.gBrowser.selectedTab = tab;
          win.focus();
          return;
        }
      }
    }
    gBrowser.addTab(PAGE_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  }

  /** Neutralise le key natif Ctrl+Shift+H (Library) et pose le nôtre.
   *  Le keyset est stable au chargement — event-driven pur XUL, zéro polling. */
  function installHotkey() {
    const neutralized = [];
    for (const k of document.querySelectorAll('#mainKeyset key')) {
      const mods = (k.getAttribute('modifiers') || '').split(/\s+/);
      const key = (k.getAttribute('key') || '').toUpperCase();
      const keycode = k.getAttribute('keycode') || '';
      if (mods.includes('accel') && mods.includes('shift') && (key === 'H' || keycode === 'VK_H')) {
        k.setAttribute('disabled', 'true');
        neutralized.push(k.id || k.getAttribute('command') || 'anon');
      }
    }
    const key = document.createXULElement('key');
    key.id = 'myHistory-open-key';
    key.setAttribute('modifiers', 'accel shift');
    key.setAttribute('key', 'H');
    key.setAttribute('oncommand', 'void 0;');
    key.addEventListener('command', openHistory);
    document.getElementById('mainKeyset').appendChild(key);
    console.log('[MyHistory] hotkey Ctrl+Shift+H actif' + (neutralized.length ? ' (natif neutralisé : ' + neutralized.join(', ') + ')' : ''));
  }

  /** Favicon de la tab bar — les <link rel=icon> relatifs sont ignorés sur chrome://
   *  → override event-driven de tab.image quand un tab affiche MyHistory */
  function patchTabIcon() {
    const applyIcon = (tab) => {
      if (tab?.linkedBrowser?.currentURI?.spec === PAGE_URL) tab.image = ICON;
    };
    gBrowser.tabContainer.addEventListener('TabAttrModified', (e) => applyIcon(e.target));
    gBrowser.tabContainer.addEventListener('TabSelect', (e) => applyIcon(e.target));
  }

  /** Exécutant des écritures Places — la PAGE ne JAMAIS écrire dans Places
   *  (instances ESM séparées entre page et browser, voir bug MyHub 2026-08-18).
   *  Flow event-driven : page → Services.obs 'myhistory-delete' → ici (vraie
   *  instance PlacesUtils) → PlacesUtils.history.remove() → 'myhistory-deleted'
   *  → la page retire les cartes du DOM. */
  function installDeleteExecutor() {
    const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
    Services.obs.addObserver(
      {
        observe(_subject, _topic, data) {
          let urls = [];
          try {
            urls = JSON.parse(data || '[]');
          } catch (e) {
            console.warn('[MyHistory] payload delete invalide :', e);
            return;
          }
          if (!Array.isArray(urls) || urls.length === 0) return;
          PlacesUtils.history
            .remove(urls)
            .then(() => {
              Services.obs.notifyObservers(null, 'myhistory-deleted', JSON.stringify(urls));
              console.log('[MyHistory] ' + urls.length + ' URL(s) supprimée(s)');
            })
            .catch((e) => console.error('[MyHistory] suppression échouée :', e));
        },
      },
      'myhistory-delete',
    );
  }

  function init() {
    if (window.__myHistoryPatched) return;
    if (!window.gBrowser || !document.getElementById('mainKeyset')) {
      setTimeout(init, 500);
      return;
    }
    window.__myHistoryPatched = true;

    installHotkey();
    patchTabIcon();
    installDeleteExecutor();
    window.openMyHistory = openHistory;
    console.log('[MyHistory] initialisé — window.openMyHistory() dispo');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
