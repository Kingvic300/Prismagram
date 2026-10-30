// Import from a live database: Supabase or any PostgreSQL server. Rust connects and reads the
// catalog; this module runs the dialog. The connection string is remembered with its password
// replaced by Supabase's [YOUR-PASSWORD] placeholder, so the password never reaches disk.

const STORAGE_KEY = "prismagram.database";
const PLACEHOLDER = "[YOUR-PASSWORD]";

export function createDatabaseImport({ dialog, invoke, onImported }) {
  const $ = (id) => dialog.querySelector(`#${id}`);
  const url = $("dbUrl");
  const password = $("dbPassword");
  const schemas = $("dbSchemas");
  const error = $("dbError");
  const submit = $("dbImport");
  const inputs = [url, password, schemas, submit];
  // Bumped on cancel, so a pull that finishes after the dialog closed is ignored.
  let attempt = 0;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.url) url.value = saved.url;
    if (saved.schemas) schemas.value = saved.schemas;
  } catch {
    /* storage unavailable: start empty */
  }

  function setBusy(busy) {
    inputs.forEach((el) => (el.disabled = busy));
    submit.textContent = busy ? "Connecting…" : "Import";
  }

  function close() {
    attempt++;
    setBusy(false);
    dialog.close();
  }

  dialog.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = ++attempt;
    error.hidden = true;
    setBusy(true);
    try {
      const result = await invoke("pull_database", {
        url: url.value,
        password: password.value,
        schemas: schemas.value.split(",").map((s) => s.trim()).filter(Boolean),
      });
      if (current !== attempt) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: withoutPassword(url.value), schemas: schemas.value }));
      } catch {
        /* storage unavailable: nothing remembered */
      }
      close();
      await onImported(result);
    } catch (err) {
      if (current !== attempt) return;
      error.textContent = String(err);
      error.hidden = false;
      setBusy(false);
    }
  });
  $("dbCancel").addEventListener("click", close);
  dialog.addEventListener("cancel", () => attempt++);

  return {
    open() {
      error.hidden = true;
      dialog.showModal();
      (url.value ? password : url).focus();
    },
    /** Empties the form back to its defaults. The caller removes the stored copy. */
    clear() {
      url.value = password.value = "";
      schemas.value = schemas.defaultValue;
    },
  };
}

/**
 * The connection string with `password` put in, ready to paste elsewhere: in place of a
 * placeholder such as `[YOUR-PASSWORD]` or `<db_password>`, or after a user name that has none.
 */
export function withPassword(url, password) {
  const value = url.trim();
  if (!password) return value;
  const encoded = encodeURIComponent(password);
  const placeholder = /\[YOUR-PASSWORD\]|<db_password>|<password>/;
  if (placeholder.test(value)) return value.replace(placeholder, encoded);
  return value.replace(/^([a-z][\w+.-]*:\/\/[^:/@?#]+)@/i, `$1:${encoded}@`);
}

/** `postgres://user:secret@host/db` → `postgres://user:[YOUR-PASSWORD]@host/db`. */
export function withoutPassword(value) {
  return value
    .replace(/^([^]*?:\/\/[^:/@]*):([^]*)@([^@]*)$/, (_, user, _secret, rest) => `${user}:${PLACEHOLDER}@${rest}`)
    .replace(/(\bpassword\s*=\s*)('[^']*'|[^\s&]+)/gi, "$1");
}
