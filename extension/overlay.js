/**
 * @file overlay.js
 * Runs inside a page of an "OpenCode" tab group. Draws the coloured frame, the
 * "OpenCode is controlling this tab" pill with its Stop button, the moving cursor, and, when a
 * site is not approved yet, a bar saying so.
 *
 * What this overlay may do is deliberately small, because it lives inside the web page: the
 * page's own scripts cannot read its closed shadow root or click its buttons (they only react
 * to real clicks, event.isTrusted), but the page CAN hide it, cover it, or draw something
 * misleading where it sits. So the buttons here only ever make things safer or hand over to
 * the extension's own page:
 *   - Stop      switches browser control off;
 *   - Deny      refuses the site that is being asked about;
 *   - Review    opens the extension's approval page in a new tab, where the site can be allowed.
 * A site can never be allowed from inside a page.
 *
 * Project: opencode-browser-control
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
(() => {
  if (window.top !== window) return;
  if (window.__ocOverlayLoaded) return; // already set up on this page; the message listener below is live
  window.__ocOverlayLoaded = true;
  // After the extension is reloaded, the overlay drawn by the old copy is still in the page but
  // its buttons are dead. Remove it so only this live one is shown.
  document.querySelectorAll('oc-control-overlay').forEach(el => el.remove());

  const host = document.createElement('oc-control-overlay');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      /* ------------------------------------------------------------------------------------
       * Theme: every colour of the overlay is set here. Change these to restyle it.
       *   --oc-accent       frame, cursor, click ring and the "Review" button
       *   --oc-accent-hover the "Review" button under the mouse
       *   --oc-accent-soft  the dot in the pill
       *   --oc-tint         faint wash over the whole page while it is controlled
       *   --oc-glow         soft inner glow of the frame
       *   --oc-bar          background of the pill and the question bar
       *   --oc-bar-text     text on the pill and on the buttons
       *   --oc-danger       Stop and Deny buttons; --oc-danger-hover under the mouse
       * ---------------------------------------------------------------------------------- */
      :host{
        --oc-accent:#2563eb; --oc-accent-hover:#1d4ed8; --oc-accent-soft:#93c5fd;
        --oc-tint:rgba(37,99,235,.05); --oc-glow:rgba(37,99,235,.4);
        --oc-bar:rgba(24,24,27,.94); --oc-bar-text:#fff;
        --oc-danger:#dc2626; --oc-danger-hover:#b91c1c;
      }
      *{box-sizing:border-box}
      .tint{position:fixed;inset:0;background:var(--oc-tint);box-shadow:inset 0 0 0 3px var(--oc-accent),inset 0 0 38px 6px var(--oc-glow);animation:pulse 2.4s ease-in-out infinite}
      @keyframes pulse{50%{box-shadow:inset 0 0 0 3px var(--oc-accent),inset 0 0 22px 2px var(--oc-glow)}}
      .bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;max-width:calc(100vw - 32px);
        background:var(--oc-bar);color:var(--oc-bar-text);font:500 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)}
      .bar.ask{border-radius:14px;flex-wrap:wrap;justify-content:center;padding:12px 14px}
      .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--oc-accent-soft);animation:blink 1.2s ease-in-out infinite}
      @keyframes blink{50%{opacity:.25}}
      button{all:unset;pointer-events:auto;cursor:pointer;padding:6px 11px;border-radius:999px;color:var(--oc-bar-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap}
      .stop,.deny{background:var(--oc-danger)}.stop:hover,.deny:hover{background:var(--oc-danger-hover)}
      .review{background:var(--oc-accent)}.review:hover{background:var(--oc-accent-hover)}
      .cur{position:fixed;left:0;top:0;width:22px;height:22px;margin:-2px 0 0 -2px;transition:transform .25s ease-out;display:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45))}
      .cur path{fill:var(--oc-accent);stroke:var(--oc-bar-text)}
      .ring{position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid var(--oc-accent);opacity:0}
      .ring.go{animation:ring .45s ease-out}
      @keyframes ring{from{opacity:.9;scale:.3}to{opacity:0;scale:1.4}}
      @media (prefers-reduced-motion:reduce){.tint,.dot{animation:none}.cur{transition:none}}
    </style>
    <div class="tint"></div><div class="ring"></div>
    <svg class="cur" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.6 1.7L8.6 19z" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <div class="bar"></div>`;
  const bar = root.querySelector('.bar'), cur = root.querySelector('.cur'), ring = root.querySelector('.ring');

  /**
   * Adds a button that only reacts to a real click by the person at the computer.
   * @param {string} label - button text
   * @param {string} cls - CSS class: "stop", "review" or "deny"
   * @param {object} message - what to send to the background worker
   * @param {Function} [after] - run after sending
   */
  const button = (label, cls, message, after) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = label;
    b.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      if (!e.isTrusted) return; // a script on the page tried to press it
      // After the extension was reloaded or updated, this copy of the overlay can no longer reach
      // it. A dead Stop button is worse than none, so the overlay removes itself.
      if (!chrome.runtime || !chrome.runtime.id) { host.remove(); return; }
      chrome.runtime.sendMessage(message);
      if (after) after();
    }, true);
    bar.appendChild(b);
  };

  /** Shows the normal pill: "OpenCode is controlling this tab" and Stop. */
  const showControlling = () => {
    bar.className = 'bar';
    bar.innerHTML = '<span class="dot"></span><span>OpenCode is controlling this tab</span>';
    button('✕ Stop', 'stop', { type: 'oc-stop' }, () => { bar.innerHTML = '<span>Stopped. Switch browser control back on in the OpenCode panel to continue.</span>'; });
  };

  /**
   * Shows that a site is waiting for the user's answer. Allowing is not offered here: "Review"
   * opens the extension's own approval page (see the note at the top of this file). Neither
   * message names the site; the background worker knows which site it asked about on this tab.
   * @param {string} site - host name being asked about (shown only)
   */
  const showAsk = site => {
    bar.className = 'bar ask';
    bar.innerHTML = '';
    const q = document.createElement('span');
    q.textContent = `OpenCode is waiting for your answer: may it read and act on ${site}?`;
    bar.appendChild(q);
    button('Review…', 'review', { type: 'oc-review' });
    button('Deny', 'deny', { type: 'oc-approve', choice: 'deny' }, () => { bar.innerHTML = '<span>Denied. OpenCode cannot use that site.</span>'; });
  };

  /**
   * Moves the drawn cursor, with a ring when it is a click.
   * @param {{x:number,y:number,click:boolean}} c - viewport position
   */
  const moveCursor = c => {
    cur.style.display = 'block';
    cur.style.transform = `translate(${c.x}px,${c.y}px)`;
    ring.style.transform = `translate(${c.x}px,${c.y}px)`;
    if (c.click) { ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go'); }
  };

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'oc-overlay-hide') { host.remove(); return; } // browser control was switched off
    if (msg.type !== 'oc-overlay') return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    // askHost: show the question. clearAsk: the question was answered, back to the normal pill.
    if (msg.askHost) showAsk(msg.askHost); else if (msg.clearAsk || !bar.classList.contains('ask')) showControlling();
    if (msg.cursor) moveCursor(msg.cursor);
  });
  showControlling(); // prepared, but only put on the page when the background worker says so (oc-overlay)
})();
