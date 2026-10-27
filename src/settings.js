import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast, openPwModal, installDelegation, dismissSplash } from "./ui.js";
import { ic } from "./icons.js";
import { init, t, lang, localeTag, stripErr } from "./i18n.js";
import { name as brandName, repo, mark as brandMark } from "./brand.js";
import { claimSnapshot, clearClaimRecords } from "./claim-monitor.js";

const $app = document.getElementById("app");
let state = null, autostart = false, busy = false, appVer = "";
const drafts = { path: "", proxy: "" }, dirty = { path: false, proxy: false };
let pathError = "", proxyError = "", proxyCheck = null, proxyCheckSequence = 0;
let updateCheck = null, checkingUpdate = false, openAfterRender = null;
const expanded = new Map();

async function refresh() {
  state = await invoke("get_state");
  autostart = await invoke("autostart_status").catch(() => false);
  if (state?.language) init(state.language);
  if (!dirty.path) drafts.path = state.zcode_path || "";
  if (!dirty.proxy) drafts.proxy = state.auth_proxy_url || "";
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { toast(stripErr(e), "err"); }
  finally { busy = false; }
}

async function persistPath(value) {
  const submittedDraft = drafts.path;
  pathError = "";
  try {
    await invoke("set_zcode_path", { path: value });
    // A later edit made while the command was running remains a draft.
    if (drafts.path === submittedDraft) dirty.path = false;
    toast(value ? t("s.pathUpdated") : t("s.pathAuto"));
    await refresh();
  } catch (e) {
    pathError = String(e) === "path_missing" ? "s.pathMissing" : "s.pathInvalid";
  }
  render();
}

const actions = {
  async refresh() { await refresh(); render(); },
  async openGitHub() { await invoke("open_external", { url: repo }); },
  async setLang(l) {
    if (l === lang()) return;
    await guard(async () => { await invoke("set_language", { lang: l }); await refresh(); render(); });
  },
  async toggleAutostart() {
    await guard(async () => {
      autostart = await invoke("autostart_set", { enable: !autostart });
      toast(autostart ? t("s.autostartOnToast") : t("s.autostartOffToast")); render();
    });
  },
  async toggleBehavior(key) {
    await guard(async () => {
      const args = key === "auto" ? { autoClaim: !state.auto_claim }
        : key === "launch" ? { launchAfterSwitch: !state.launch_after_switch }
        : key === "tray" ? { closeToTray: !state.close_to_tray } : { hotSwitch: !state.hot_switch };
      await invoke("set_behavior", args);
      await refresh(); render(); toast(t("s.savedToast"));
    });
  },
  async setClaimInterval(value) {
    const minutes = Number(value);
    if (![2, 5, 10].includes(minutes)) return;
    await guard(async () => {
      await invoke("set_behavior", { autoClaimIntervalMinutes: minutes });
      await refresh(); render(); toast(t("s.savedToast"));
    });
  },
  clearHistory() { clearClaimRecords(); },
  async exportAll() {
    await guard(async () => {
      const p = await invoke("export_all_pick_path");
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "exportAll", path: p.path, count: p.count, onDone: () => actions.refresh() });
    });
  },
  async importFiles() {
    await guard(async () => {
      const p = await invoke("import_pick_files");
      if (!p.picked) return;
      const sealed = p.sealed || [], preErrors = p.errors || [];
      if (sealed.length) {
        openPwModal({ mode: "import", files: sealed, preErrors, onDone: rep => actions.finishImport(rep) }); return;
      }
      actions.finishImport({ added: [], skipped: [], errors: preErrors });
    });
  },
  finishImport(report) {
    if (report.added.length === 0 && report.skipped.length === 0) {
      toast(t("s.importNone"), "err", report.errors.join(t("common.listSep")) || undefined);
    } else {
      const parts = [];
      if (report.added.length) parts.push(t("s.importAdded", { count: report.added.length, names: report.added.join(t("common.listSep")) }));
      if (report.skipped.length) parts.push(t("s.importSkipped", { count: report.skipped.length }));
      if (report.errors.length) parts.push(t("s.importFailed", { count: report.errors.length }));
      toast(parts[0], report.errors.length ? "err" : "ok", parts.slice(1).join(t("common.listSep")));
    }
    refresh().then(render);
  },
  async browsePath() {
    await guard(async () => {
      const r = await invoke("pick_zcode_path");
      if (r.picked) { drafts.path = r.path; dirty.path = true; await persistPath(r.path); }
    });
  },
  async savePath() { await guard(() => persistPath(drafts.path.trim())); },
  async autoPath() { await guard(() => persistPath("")); },
  async toggleAuthProxy() {
    if (!state.auth_proxy_on && !state.auth_proxy_url?.trim()) {
      openAfterRender = "proxy-editor"; proxyError = "s.proxyRequired"; render(); return;
    }
    await guard(async () => {
      // Toggling uses the saved address; unrelated changes never save a draft.
      await invoke("set_auth_proxy", { on: !state.auth_proxy_on, url: state.auth_proxy_url || null });
      await refresh();
      if (state.auth_proxy_on) openAfterRender = "proxy-editor";
      render(); toast(state.auth_proxy_on ? t("s.proxyOnToast") : t("s.proxyOffToast"));
    });
  },
  async saveProxy() {
    const value = drafts.proxy.trim();
    await guard(async () => {
      proxyError = "";
      try {
        await invoke("set_auth_proxy", { on: state.auth_proxy_on, url: value });
        if (drafts.proxy.trim() === value) dirty.proxy = false;
        await refresh(); toast(t("s.proxySaved"));
      } catch { proxyError = "s.proxyInvalid"; }
      render();
    });
  },
  async testProxy() {
    if (proxyCheck?.status === "testing") return;
    const sequence = ++proxyCheckSequence;
    const value = drafts.proxy.trim();
    proxyError = ""; proxyCheck = { status: "testing" }; render();
    try {
      const result = await invoke("test_auth_proxy", { url: value });
      if (sequence !== proxyCheckSequence) return;
      proxyCheck = { status: result.reachable ? "reachable" : "unreachable", ms: result.elapsedMs };
    } catch {
      if (sequence !== proxyCheckSequence) return;
      proxyCheck = { status: "invalid" };
    }
    render();
  },
  async checkUpdate() {
    if (checkingUpdate) return;
    checkingUpdate = true; updateCheck = null; render();
    try { updateCheck = await invoke("check_updates"); }
    catch { updateCheck = { status: "error" }; }
    finally { checkingUpdate = false; render(); }
  },
  async openRelease() {
    const url = updateCheck?.releaseUrl;
    if (/^https:\/\/github\.com\/immortalbeating\/zcode-shift\/releases\/tag\/v\d+\.\d+\.\d+$/.test(url || "")) {
      await invoke("open_external", { url });
    }
  },
};

const detail = (id, summary, body) => `<details class="settings-detail" data-note="${id}">
  <summary>${esc(summary)}</summary><p>${esc(body)}</p></details>`;
const toggle = (on, action, label, desc, note = "") => `<div class="tog-row">
  <div class="tog-info"><div class="tog-label">${esc(label)}</div><div class="tog-desc">${esc(desc)}</div>${note}</div>
  <button class="toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" click="${action}"><span class="knob"></span></button></div>`;
const duration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)} s` : "—";

function historyHtml() {
  const records = claimSnapshot().records;
  if (!records.length) return `<p class="settings-copy">${t("s.historyEmpty")}</p>`;
  const statuses = { success: "s.historySuccess", failed: "s.historyFailed", timeout: "s.historyTimeout", interactive: "s.historyInteractive" };
  return `<div class="claim-history">${records.map(record => {
    const name = state.accounts.find(account => account.id === record.accountId)?.name || t("s.historyUnknownAccount");
    const date = new Date(record.at).toLocaleString(localeTag(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    return `<div class="claim-history-item"><div class="history-head"><span class="history-name" title="${esc(name)}">${esc(name)}</span>
      <span class="history-result ${record.status === 'success' ? 'success' : ''}">${esc(t(statuses[record.status]))}</span></div>
      <div class="history-plan">${esc(record.planName || t("s.historyDiscovery"))}</div>
      <div class="history-meta"><time>${esc(date)}</time><span>${esc(t("s.historyElapsed", { time: duration(record.elapsedMs) }))}</span></div>
      ${record.discoveryMs != null || record.submitMs != null ? `<div class="history-meta">${esc(t("s.historyStages", { discovery: duration(record.discoveryMs), submit: duration(record.submitMs) }))}</div>` : ""}</div>`;
  }).join("")}</div><button class="btn-ghost history-clear" click="actions.clearHistory()">${t("s.historyClear")}</button>`;
}

function updateText() {
  if (checkingUpdate) return t("s.updateChecking");
  const result = updateCheck;
  if (!result) return "";
  if (result.status === "available") return t("s.updateAvailable", { version: result.latestVersion });
  if (result.status === "current") return t("s.updateCurrent");
  if (result.status === "unpublished") return t("s.updateUnpublished");
  return t("s.updateError");
}
function proxyText() {
  if (!proxyCheck) return "";
  if (proxyCheck.status === "testing") return t("s.proxyTesting");
  if (proxyCheck.status === "reachable") return t("s.proxyReachable", { ms: proxyCheck.ms });
  if (proxyCheck.status === "unreachable") return t("s.proxyUnreachable");
  return t("s.proxyInvalid");
}

function render() {
  if (!state) { $app.innerHTML = `<div class="loading">LOADING</div>`; return; }
  const s = state, scrollTop = $app.scrollTop;
  const active = document.activeElement;
  const focus = active?.matches(".settings input") ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollLeft } : null;
  for (const el of $app.querySelectorAll("details")) expanded.set(el.dataset.note, el.open);
  if (openAfterRender) { expanded.set(openAfterRender, true); openAfterRender = null; }
  document.title = `${brandName} ${t("s.title")}`;
  $app.innerHTML = `
    <header class="topbar settings-header"><div class="brand">${brandMark}<h1>${t("s.title")}</h1></div>
      <div class="settings-version"><span class="wordmark">${brandName}</span>${appVer ? `<span>v${esc(appVer)}</span>` : ""}</div></header>
    <main class="settings open">
      <section class="settings-group" aria-labelledby="general-heading" data-group="general">
        <h2 id="general-heading">${t("s.generalLabel")}</h2>
        <div class="tog-row"><div class="tog-info"><div class="tog-label">${t("s.langLabel")}</div></div>
          <div class="lang-seg" role="radiogroup" aria-label="${t("s.langLabel")}">
            <button class="lang-opt${lang() === 'zh' ? ' on' : ''}" role="radio" aria-checked="${lang() === 'zh'}" click="actions.setLang('zh')">${t("s.langZh")}</button>
            <button class="lang-opt${lang() === 'en' ? ' on' : ''}" role="radio" aria-checked="${lang() === 'en'}" click="actions.setLang('en')">${t("s.langEn")}</button></div></div>
        ${toggle(autostart, "actions.toggleAutostart()", t("s.autostart"), t("s.autostartDesc"))}
        ${toggle(s.close_to_tray, "actions.toggleBehavior('tray')", t("s.closeTray"), t("s.closeTrayDesc"))}
      </section>
      <section class="settings-group" aria-labelledby="claim-heading" data-group="claim">
        <h2 id="claim-heading">${t("s.claimLabel")}</h2>
        ${toggle(s.auto_claim, "actions.toggleBehavior('auto')", t("btn.autoClaim"), t("s.claimSummary"))}
        <div class="settings-inline"><label for="claim-interval">${t("s.claimInterval")}</label>
          <select id="claim-interval">${[2, 5, 10].map(minutes => `<option value="${minutes}" ${minutes === (s.auto_claim_interval_minutes || 5) ? 'selected' : ''}>${esc(t("s.claimMinutes", { minutes }))}</option>`).join("")}</select></div>
        <details class="settings-detail" data-note="history"><summary>${t("s.historyLabel")}</summary>
          <div id="claim-history-content">${historyHtml()}</div></details>
      </section>
      <section class="settings-group" aria-labelledby="switch-heading" data-group="switch">
        <h2 id="switch-heading">${t("s.behaviorLabel")}</h2>
        ${toggle(s.launch_after_switch, "actions.toggleBehavior('launch')", t("s.launchAfter"), t("s.launchAfterDesc"))}
        <details class="settings-editor" data-note="path"><summary>${t("s.pathLabel")}<span class="settings-value">${s.zcode_path_custom ? t("s.pathCustom") : t("s.pathDetected")}</span></summary>
          <div class="settings-field"><label for="zcode-path">${t("s.pathLabel")}</label>
            <input id="zcode-path" class="zcode-path" type="text" value="${esc(drafts.path)}" placeholder="C:\\Program Files\\ZCode\\ZCode.exe" aria-describedby="path-hint" aria-invalid="${!!pathError}" keydown="onPathKey(event)">
            <p id="path-hint" class="field-hint">${t("s.pathHint")}${dirty.path ? ` · ${t("s.unsaved")}` : ""}</p>
            ${pathError ? `<p class="field-error" role="alert">${esc(t(pathError))}</p>` : ""}
            <div class="settings-field-actions path-actions"><button class="btn-ghost" click="actions.browsePath()">${t("s.browse")}</button>
              <button class="btn-ghost" click="actions.savePath()" aria-label="${t("s.savePath")}">${t("common.save")}</button>
              <button class="btn-ghost" click="actions.autoPath()">${t("s.pathRestore")}</button></div></div>
        </details>
        <p class="settings-path${s.zcode_path_ok ? '' : ' field-error'}" title="${esc(s.zcode_path || '')}">${esc(s.zcode_path_ok ? s.zcode_path : t("s.pathNotFound"))}</p>
      </section>
      <section class="settings-group" aria-labelledby="network-heading" data-group="network">
        <h2 id="network-heading">${t("s.authLabel")}</h2>
        ${toggle(s.auth_proxy_on, "actions.toggleAuthProxy()", t("s.proxyToggle"), t("s.proxySummary"), detail("proxy", t("s.proxyMore"), t("s.proxyToggleDesc")))}
        <details class="settings-editor" data-note="proxy-editor"><summary>${t("s.proxyAddress")}<span class="settings-value">${t("s.edit")}</span></summary>
          <div class="settings-field"><label for="auth-proxy">${t("s.proxyAddress")}</label>
            <input id="auth-proxy" class="zcode-path auth-proxy" type="text" value="${esc(drafts.proxy)}" placeholder="${t("s.proxyPh")}" aria-describedby="proxy-hint" aria-invalid="${!!proxyError}" keydown="onProxyKey(event)">
            <p id="proxy-hint" class="field-hint">${t("s.proxyTestHint")}${dirty.proxy ? ` · ${t("s.unsaved")}` : ""}</p>
            <div class="settings-field-actions"><button class="btn-ghost" click="actions.saveProxy()" aria-label="${t("s.saveProxy")}">${t("common.save")}</button>
              <button class="btn-ghost" click="actions.testProxy()" ${proxyCheck?.status === 'testing' ? 'disabled' : ''}>${t("s.proxyTest")}</button></div>
            <p class="field-feedback${proxyError || ['unreachable', 'invalid'].includes(proxyCheck?.status) ? ' field-error' : ''}" role="status">${esc(proxyError ? t(proxyError) : proxyText())}</p></div>
        </details>
      </section>
      <section class="settings-group" aria-labelledby="library-heading" data-group="library">
        <h2 id="library-heading">${t("s.libLabel")}</h2><p class="settings-copy">${t("s.libraryHint")}</p>
        <div class="lib-row"><button class="btn-ghost has-ic" click="actions.importFiles()">${ic("import", 14)} ${t("s.importBtn")}</button>
          <button class="btn-ghost has-ic" click="actions.exportAll()" ${s.accounts.length ? '' : 'disabled'}>${ic("exportAll", 14)} ${t("s.exportAllBtn")}</button></div>
        ${detail("storage", t("s.storageMore"), t("s.hint"))}
      </section>
      <section class="settings-group" aria-labelledby="advanced-heading" data-group="advanced">
        <h2 id="advanced-heading">${t("s.advancedLabel")}</h2>
        <details class="settings-editor" data-note="advanced"><summary>${t("s.experimental")}<span class="settings-value">${s.hot_switch ? t("s.hotActive") : ''}</span></summary>
          ${toggle(s.hot_switch, "actions.toggleBehavior('hot')", t("s.hotSwitch"), t("s.hotSwitchSummary"), detail("hot", t("s.hotSwitchMore"), t("s.hotSwitchDesc")))}</details>
      </section>
      <section class="settings-group settings-about" aria-labelledby="about-heading" data-group="about">
        <h2 id="about-heading">${t("s.aboutLabel")}</h2>
        <div class="settings-inline update-row"><span class="settings-copy">${t("s.localVersion", { version: appVer })}</span><button class="btn-ghost" click="actions.checkUpdate()" ${checkingUpdate ? 'disabled' : ''}>${t("s.updateCheck")}</button></div>
        <p class="field-feedback${updateCheck?.status === 'error' ? ' field-error' : ''}" role="status">${esc(updateText())}</p>
        ${updateCheck?.status === 'available' ? `<button class="btn-ghost" click="actions.openRelease()">${t("s.updateOpen")}</button>` : ''}
        <a class="settings-repo" href="${repo}" target="_blank" rel="noopener" click="actions.openGitHub()"><span>${esc(new URL(repo).pathname.slice(1))}</span>${ic("accountExport", 15)}</a>
      </section>
    </main>`;
  for (const el of $app.querySelectorAll("details")) {
    el.open = expanded.has(el.dataset.note) ? expanded.get(el.dataset.note) : el.dataset.note === "proxy-editor" && s.auth_proxy_on;
    el.addEventListener("toggle", () => expanded.set(el.dataset.note, el.open));
  }
  document.getElementById("claim-interval").addEventListener("change", event => actions.setClaimInterval(event.target.value));
  for (const [id, key] of [["zcode-path", "path"], ["auth-proxy", "proxy"]]) {
    document.getElementById(id).addEventListener("input", event => {
      drafts[key] = event.target.value; dirty[key] = true;
      event.target.setAttribute("aria-invalid", "false");
      const field = event.target.closest(".settings-field");
      if (key === "path") { pathError = ""; field.querySelector(".field-error")?.remove(); }
      else {
        proxyError = ""; proxyCheck = null; proxyCheckSequence++;
        field.querySelector(".field-feedback").textContent = "";
        field.querySelector('[click="actions.testProxy()"]').disabled = false;
      }
      const hint = field.querySelector(".field-hint");
      hint.textContent = `${t(key === "path" ? "s.pathHint" : "s.proxyTestHint")} · ${t("s.unsaved")}`;
    });
  }
  if (focus) {
    const input = document.getElementById(focus.id);
    input?.focus({ preventScroll: true }); input?.setSelectionRange(focus.start, focus.end);
    if (input) input.scrollLeft = focus.scroll;
  }
  $app.scrollTop = scrollTop;
}

window.actions = actions;
window.onPathKey = e => { if (e.key === "Enter") actions.savePath(); };
window.onProxyKey = e => { if (e.key === "Enter") actions.saveProxy(); };
installDelegation();
listen("state-changed", () => { refresh().then(render).catch(() => {}); });
window.addEventListener("claim-monitor", () => {
  const content = document.getElementById("claim-history-content");
  if (content && state) content.innerHTML = historyHtml();
});
(async () => {
  try { appVer = await invoke("app_version").catch(() => ""); await refresh(); render(); dismissSplash(); }
  catch (e) { $app.innerHTML = `<div class="loading" style="color:var(--red)">${t("common.loadFail", { e: esc(String(e)) })}</div>`; dismissSplash(); }
})();
