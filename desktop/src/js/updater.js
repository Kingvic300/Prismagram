// Background updates: check GitHub Releases quietly, download the signed update, then offer a
// one-click restart. Updates are verified against the public key built into the app, so only
// releases signed with the maintainers' key install. The check is a plain file download.

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

export function createUpdater({ banner, onStatus }) {
  const updaterApi = window.__TAURI__?.updater;
  const processApi = window.__TAURI__?.process;
  let busy = false;
  let pending = null;
  let timers = [];

  async function check({ manual = false } = {}) {
    if (!updaterApi || busy) return;
    if (pending) return showReady(pending.version);
    busy = true;
    onStatus(manual ? "Checking for updates…" : null);
    try {
      const update = await updaterApi.check();
      if (!update) {
        if (manual) onStatus("You're on the latest version.");
        return;
      }
      let total = 0;
      let done = 0;
      onStatus(`Downloading Prismagram ${update.version}…`);
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength || 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          if (total) onStatus(`Downloading Prismagram ${update.version}… ${Math.round((100 * done) / total)}%`);
        }
      });
      pending = update;
      onStatus(`Prismagram ${update.version} is ready to install.`);
      showReady(update.version);
    } catch (err) {
      if (manual) onStatus(`Couldn't check for updates. You may be offline. (${err})`);
      else onStatus(null);
    } finally {
      busy = false;
    }
  }

  function showReady(version) {
    banner.querySelector("[data-version]").textContent = version;
    banner.hidden = false;
  }

  async function restart() {
    if (!pending) return;
    const button = banner.querySelector("[data-restart]");
    button.disabled = true;
    button.textContent = "Installing…";
    try {
      await pending.install();
      await processApi.relaunch();
    } catch (err) {
      button.disabled = false;
      button.textContent = "Restart now";
      onStatus(`Update failed: ${err}`);
    }
  }

  banner.querySelector("[data-restart]").addEventListener("click", restart);
  banner.querySelector("[data-later]").addEventListener("click", () => (banner.hidden = true));

  return {
    available: Boolean(updaterApi),
    check,
    setAuto(enabled) {
      timers.forEach(clearTimeout);
      timers = [];
      if (!enabled || !updaterApi) return;
      timers.push(setTimeout(() => check(), FIRST_CHECK_MS));
      timers.push(setInterval(() => check(), CHECK_EVERY_MS));
    },
  };
}
