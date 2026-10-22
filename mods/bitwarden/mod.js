/* Bitwarden mod: logins from your vault through the Bitwarden CLI.
 *
 *   Ctrl+Shift+L     (or :bw.exe) click into a login box first. The site's
 *                    logins show as rows above the command bar: type to
 *                    narrow, Up/Down to move, Enter to pick. Then pick what
 *                    to do: paste the username or password into the box
 *                    you were in, or copy it.
 *   :bw.exe totp     copy this page's two-step code
 *   :bw.exe find     search the whole vault (logins, secure notes, cards,
 *                    identities); pick one, then a field to paste or copy
 *   :bw.exe notes    the secure notes: each line is a row to copy
 *   :bw.exe generate a new password (generate 32 for its length, generate
 *                    words for a passphrase): paste, copy or another one
 *   :bw.exe username a new username (a random word, or an address made
 *                    from your email address or domain in settings)
 *   :bw.exe new      save a login for this site: a username and a new
 *                    password, kept in the vault and pasted into the page
 *   :bw.exe sync     fetch the latest vault
 *   :bw.exe lock     lock (the PIN unlocks it again)
 *   :bw.exe lock all lock so that only the master password unlocks it
 *   :bw.exe login    log in to Bitwarden
 *   :bw.exe pin      set or change the PIN
 *   :bw.exe status
 *
 * Autofill: while the vault is unlocked, Gecko's own password manager gets
 * its logins (Autofill.sys.mjs). It fills in a site's only login when the
 * page loads and lists the logins when you click a login box. They stay in
 * memory; nothing is written to Gecko's login store.
 *
 * The first unlock asks for your master password, then offers a PIN for
 * the next ones (after the vault locks itself when idle, or after a
 * restart if the setting says so).
 *
 * Passkeys: Breached answers sites' passkey requests itself, inside the
 * engine (resource://breached/Passkeys.sys.mjs), instead of Windows Hello.
 * Unlocking loads the vault's passkeys into it; a site then signs in with
 * its passkey straight away (rows if there are several accounts). A login
 * box that offers passkeys shows them with the logins of Ctrl+Shift+L.
 * Passkeys sites make are kept in the vault. They stay usable until
 * :bw.exe lock all or Breached closes. bw.exe only stores them.
 *
 * Pasting types the text into the page the way a keyboard does, so it
 * works in any box the page has. The unlock key is kept in memory only
 * (with a PIN it can also be kept, locked with the PIN, in the profile),
 * and the master password is passed to bw.exe in an environment
 * variable, never on its command line. */

"use strict";

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const Bitwarden = {
  session: null,
  _lockTimer: null,
  // The unlocked vault's items, so Ctrl+Shift+L and autofill don't wait on
  // bw.exe (a second or more a call). Refreshed in the background.
  items: null,
  _itemsAt: 0,
  _checkedAt: 0,

  async exe() {
    let path = Mod.pref("breached.mods.bitwarden.path", "").trim();
    if (path) {
      if (!(await IOUtils.exists(path))) {
        throw new Error(`bw.exe isn't at ${path} (see settings > mods)`);
      }
      return path;
    }
    try {
      return await Subprocess.pathSearch("bw.exe");
    } catch (e) {
      throw new Error("bw.exe wasn't found. Install the Bitwarden CLI or set its place in settings > mods");
    }
  },

  /** Runs bw.exe; resolves to { code, stdout, stderr }. */
  async bw(args, env = {}) {
    let environment = { BW_NOINTERACTION: "true", ...env };
    if (this.session && !("BW_SESSION" in env)) {
      environment.BW_SESSION = this.session;
    }
    let proc = await Subprocess.call({
      command: await this.exe(),
      arguments: args,
      environment,
      environmentAppend: true,
      stderr: "pipe",
    });
    proc.stdin.close();
    let readAll = async pipe => {
      let out = "";
      for (let chunk; (chunk = await pipe.readString()); ) {
        out += chunk;
      }
      return out;
    };
    let [stdout, stderr, { exitCode }] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.wait(),
    ]);
    return { code: exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  },

  async json(args) {
    let r = await this.bw(args);
    if (r.code != 0) {
      throw new Error(r.stderr || r.stdout || `bw.exe ${args[0]} failed`);
    }
    return JSON.parse(r.stdout);
  },

  async status() {
    return (await this.json(["status"])).status; // unauthenticated, locked, unlocked
  },

  touch() {
    clearTimeout(this._lockTimer);
    let minutes = parseInt(Mod.pref("breached.mods.bitwarden.lockMinutes", "0"), 10);
    if (minutes > 0) {
      this._lockTimer = setTimeout(() => this.lock(), minutes * 60 * 1000);
    }
  },

  /** Locks: the idle timer keeps the PIN-locked copy, :bw.exe lock doesn't. */
  lock({ forget = false } = {}) {
    clearTimeout(this._lockTimer);
    this.session = null;
    this._checkedAt = 0;
    this.forgetItems();
    if (forget) {
      Pin.forget();
      // Locked for good: sites can't use its passkeys until it's unlocked again.
      if (Engine.provider === Passkeys) {
        Engine.unload();
      }
    }
  },

  /** Makes sure the vault is unlocked, asking for the PIN or the master password. */
  async unlock() {
    if (this.session && Date.now() - this._checkedAt < 10 * 60 * 1000) {
      // Checked lately: no need to ask bw.exe again (that's the slow part).
      return;
    }
    let status = await this.status();
    if (status == "unauthenticated") {
      throw new Error("not logged in: run :bw.exe login (or bw login in a terminal)");
    }
    if (status == "unlocked" && this.session) {
      this._checkedAt = Date.now();
      if (!Engine.loaded) {
        await Passkeys.load().catch(e => console.error("Bitwarden: loading passkeys", e));
      }
      return;
    }
    if (Pin.has()) {
      let session = await Pin.unlock();
      if (session) {
        this.session = session;
        if ((await this.status()) == "unlocked") {
          this._checkedAt = Date.now();
          this.touch();
          await Passkeys.load().catch(e => console.error("Bitwarden: loading passkeys", e));
          return;
        }
        // bw.exe was locked since (say, bw lock in a terminal): the key is spent.
        this.session = null;
        Pin.forget();
        Breached.showMessage("The PIN no longer unlocks Bitwarden: use the master password", "error");
      }
    }
    let password = await Breached.prompt("bitwarden master password:", { password: true });
    if (!password) {
      throw new Error("cancelled");
    }
    Breached.showMessage("Unlocking…");
    let r = await this.bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
      BW_PASSWORD: password,
      BW_SESSION: null,
    });
    password = null;
    if (r.code != 0 || !r.stdout) {
      throw new Error(r.stderr || "couldn't unlock");
    }
    this.session = r.stdout;
    this._checkedAt = Date.now();
    this.touch();
    await Passkeys.load().catch(e => console.error("Bitwarden: loading passkeys", e));
    if (!Pin.has() && Mod.pref("breached.mods.bitwarden.pin", "ask") != "off") {
      await Pin.set(this.session, { offer: true });
    }
  },

  async login() {
    let email = await Breached.prompt("bitwarden email:");
    if (!email) {
      return;
    }
    let password = await Breached.prompt("bitwarden master password:", { password: true });
    if (!password) {
      return;
    }
    let args = ["login", email.trim(), "--passwordenv", "BW_PASSWORD", "--raw"];
    let r = await this.bw(args, { BW_PASSWORD: password, BW_SESSION: "" });
    if (r.code != 0 && /two-step|two step|2fa|code/i.test(r.stderr + r.stdout)) {
      let code = await Breached.prompt("two-step code from your authenticator app:");
      if (!code) {
        return;
      }
      r = await this.bw([...args, "--method", "0", "--code", code.trim()], {
        BW_PASSWORD: password,
        BW_SESSION: null,
      });
    }
    password = null;
    if (r.code != 0 || !r.stdout) {
      throw new Error(r.stderr || "couldn't log in");
    }
    this.session = r.stdout;
    this.touch();
    Breached.showMessage("Logged in to Bitwarden");
  },

  currentURL(browser = Breached.selectedBrowser) {
    let url = browser?.currentURI?.spec;
    if (!url || !/^https?:/.test(url)) {
      throw new Error("open a website first");
    }
    return url;
  },

  /** The vault's items, from memory when they're recent. */
  async vault({ fresh = false } = {}) {
    let age = Date.now() - this._itemsAt;
    if (this.items && !fresh && age < 10 * 60 * 1000) {
      if (age > 60 * 1000) {
        this.refresh();
      }
      return this.items;
    }
    this.items = await this.json(["list", "items"]);
    this._itemsAt = Date.now();
    return this.items;
  },

  refresh() {
    if (this._refreshing || !this.session) {
      return;
    }
    this._refreshing = this.json(["list", "items"])
      .then(items => {
        if (this.session) {
          this.items = items;
          this._itemsAt = Date.now();
        }
      })
      .catch(e => console.error("Bitwarden: refreshing the vault", e))
      .finally(() => (this._refreshing = null));
  },

  forgetItems() {
    this.items = null;
    this._itemsAt = 0;
  },

  async logins(url) {
    return this.matching(await this.vault(), url);
  },

  /** The login items whose web addresses match url (Bitwarden's match rules). */
  matching(items, url) {
    let page;
    try {
      page = new URL(url);
    } catch (e) {
      return [];
    }
    return items.filter(i => i.type == 1 && i.login && (i.login.uris ?? []).some(u => uriMatches(u, page)));
  },

  async run(args) {
    let [sub, ...rest] = args.trim().split(/\s+/);
    switch (sub) {
      case "lock":
        if (rest[0] == "all") {
          // The unlock key itself is spent, and the PIN with it.
          this.lock({ forget: true });
          await this.bw(["lock"]);
          Breached.showMessage("Bitwarden locked; the master password is needed next time");
        } else {
          this.lock();
          Breached.showMessage(Pin.has() ? "Bitwarden locked (the PIN unlocks it)" : "Bitwarden locked");
        }
        return;
      case "login":
        await this.login();
        return;
      case "pin":
        await this.unlock();
        await Pin.set(this.session, { offer: false });
        return;
      case "status": {
        let status = await this.status();
        Breached.showMessage(`Bitwarden: ${status == "unlocked" && !this.session ? "locked" : status}`);
        return;
      }
      case "sync":
        await this.unlock();
        Breached.showMessage("Syncing…");
        await this.json(["sync"]).catch(() => null);
        await this.vault({ fresh: true });
        Breached.showMessage("Bitwarden synced");
        this.touch();
        return;
      case "totp": {
        let url = this.currentURL();
        await this.unlock();
        let item = (await this.logins(url)).find(i => i.login.totp);
        if (!item) {
          throw new Error("no two-step code saved for this site");
        }
        this.copy(await this.totp(item), true);
        Breached.showMessage("Two-step code copied");
        this.touch();
        return;
      }
      case "find":
      case "search":
        await this.find(rest.join(" "));
        return;
      case "notes":
      case "note":
        await this.find(rest.join(" "), { type: 2 });
        return;
      case "generate":
      case "gen":
        await this.offerPassword(rest);
        return;
      case "username":
      case "user":
        await this.offerUsername();
        return;
      case "new":
      case "add":
        await this.newLogin();
        return;
    }
    if (sub) {
      throw new Error(`unknown: ${sub} (try find, notes, generate, username, new, totp, sync, lock, login, pin, status)`);
    }
    await this.choose(Breached.selectedBrowser);
  },

  /**
   * Ctrl+Shift+L or :bw.exe: this page's logins (and passkeys, if its login
   * box is waiting for one) as rows; then paste or copy from the picked one.
   */
  async choose(browser) {
    let url = this.currentURL(browser);
    await this.unlock();
    let logins = await this.logins(url);
    // A login box waiting for a passkey: Bitwarden's passkeys for it come first.
    let waiting = Engine.waiting(browser);
    let passkeys = waiting ? await Engine.offers(waiting) : [];
    this.touch();
    if (!logins.length && !passkeys.length) {
      Breached.showMessage("No Bitwarden logins for this site", "error");
      return;
    }
    let picked =
      logins.length == 1 && !passkeys.length
        ? { login: logins[0] }
        : await Breached.pick("bitwarden:", [
            ...passkeys.map(passkey => ({
              label: passkey.name,
              detail: `passkey for ${passkey.rpId}`,
              passkey,
            })),
            ...logins.map(login => ({
              label: login.login.username || "(no username)",
              detail: login.name,
              login,
            })),
          ]);
    if (!picked || Breached.selectedBrowser !== browser) {
      return;
    }
    if (picked.passkey) {
      if (Engine.waiting(browser) != waiting) {
        Breached.showMessage("The page stopped waiting for a passkey", "error");
        return;
      }
      Engine.use(waiting, picked.passkey.credentialId);
      Breached.showMessage(`Signing in to ${picked.passkey.rpId} as ${picked.passkey.name}`);
      return;
    }
    let { login } = picked.login;
    let who = login.username || picked.login.name;
    let actions = [];
    if (login.username && login.password) {
      // Like qutebrowser's Bitwarden script: from the username box, Tab to the password.
      actions.push({ label: "paste both", detail: "username, Tab, password", paste: "both" });
    }
    if (login.username) {
      actions.push({ label: "paste username", detail: login.username, paste: "username" });
    }
    if (login.password) {
      actions.push({ label: "paste password", detail: "into the box you were in", paste: "password" });
    }
    if (login.totp) {
      actions.push({ label: "paste two-step code", detail: "the current code", paste: "totp" });
    }
    if (login.username) {
      actions.push({ label: "copy username", detail: login.username, copy: "username" });
    }
    if (login.password) {
      actions.push({ label: "copy password", detail: "cleared from the clipboard after 30 seconds", copy: "password" });
    }
    if (login.totp) {
      actions.push({ label: "copy two-step code", detail: "the current code", copy: "totp" });
    }
    // Its notes and custom fields too.
    let extra = fieldsOf(picked.login).filter(f => !["username", "password"].includes(f.name));
    actions.push(...extra.map(field => ({ label: `copy ${field.name}`, detail: field.shown, field })));
    let action = await Breached.pick(`${who}:`, actions);
    if (action?.field) {
      this.copy(action.field.value, action.field.secret);
      Breached.showMessage(`Copied the ${action.field.name} of ${who}`);
      return;
    }
    if (!action || Breached.selectedBrowser !== browser) {
      return;
    }
    let what = action.paste ?? action.copy;
    if (what == "both") {
      await this.paste(browser, [login.username, "\t", login.password]);
      Breached.showMessage(`Pasted the username and password of ${who}`);
      return;
    }
    let text = what == "totp" ? await this.totp(picked.login) : login[what];
    let name = { username: "username", password: "password", totp: "two-step code" }[what];
    if (action.paste) {
      await this.paste(browser, [text]);
      Breached.showMessage(`Pasted the ${name} of ${who}`);
    } else {
      this.copy(text, what != "username");
      Breached.showMessage(`Copied the ${name} of ${who}`);
    }
  },

  /** :bw.exe find / notes: the vault's items (of one type), then a field of the picked one. */
  async find(text, { type = null } = {}) {
    await this.unlock();
    let items = (await this.vault()).filter(i => (type == null || i.type == type) && KINDS[i.type]);
    this.touch();
    if (!items.length) {
      Breached.showMessage(type == 2 ? "No secure notes in your vault" : "Your vault is empty", "error");
      return;
    }
    let browser = Breached.selectedBrowser;
    let rows = items
      .map(item => ({ label: item.name || "(no name)", detail: summary(item), item }))
      .sort((a, b) => a.label.localeCompare(b.label));
    let words = text.toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter(r => words.every(w => `${r.label} ${r.detail}`.toLowerCase().includes(w)));
    let picked = rows.length == 1 && words.length ? rows[0] : await Breached.pick(type == 2 ? "secure notes:" : "bitwarden:", rows);
    if (!picked) {
      return;
    }
    let item = picked.item;
    let fields = fieldsOf(item);
    if (!fields.length) {
      Breached.showMessage(`${item.name} has nothing to copy`, "error");
      return;
    }
    let canPaste = /^https?:/.test(browser?.currentURI?.spec ?? "");
    let actions = [];
    for (let field of fields) {
      if (field.name == "note") {
        // A note: the whole of it, then each line, so one line can be copied.
        actions.push({ label: "copy the whole note", detail: field.shown, field });
        let lines = field.value.split(/\r?\n/).filter(l => l.trim());
        if (lines.length > 1) {
          actions.push(...lines.map(line => ({ label: line.trim(), detail: "copy this line", field: { ...field, value: line.trim() } })));
        }
        continue;
      }
      actions.push({ label: `copy ${field.name}`, detail: field.shown, field });
      if (canPaste && field.name != "note") {
        actions.push({ label: `paste ${field.name}`, detail: "into the box you were in", field, paste: true });
      }
    }
    let action = await Breached.pick(`${item.name}:`, actions);
    if (!action) {
      return;
    }
    let { field } = action;
    let value = field.name == "two-step code" ? await this.totp(item) : field.value;
    if (action.paste) {
      if (Breached.selectedBrowser !== browser) {
        return;
      }
      await this.paste(browser, [value]);
      Breached.showMessage(`Pasted the ${field.name} of ${item.name}`);
    } else {
      this.copy(value, field.secret);
      Breached.showMessage(`Copied ${action.label.startsWith("copy") ? "the " + field.name : "the line"} of ${item.name}`);
    }
  },

  /** A new password (or passphrase), Bitwarden's generator. */
  async generate({ length, words, symbols = true } = {}) {
    if (words) {
      let r = await this.bw(["generate", "--passphrase", "--words", String(words), "--separator", "-", "--capitalize", "--includeNumber"]);
      if (r.code != 0 || !r.stdout) {
        throw new Error(r.stderr || "couldn't make a passphrase");
      }
      return r.stdout;
    }
    return randomPassword(length || generatorLength(), symbols);
  },

  /** :bw.exe generate [length] [words [count]] [simple] */
  async offerPassword(args) {
    let options = {};
    for (let i = 0; i < args.length; i++) {
      let arg = args[i].toLowerCase();
      if (/^\d+$/.test(arg)) {
        options.length = Math.min(128, Math.max(5, parseInt(arg, 10)));
      } else if (arg == "words" || arg == "passphrase") {
        options.words = /^\d+$/.test(args[i + 1] ?? "") ? Math.min(20, Math.max(3, parseInt(args[++i], 10))) : 4;
      } else if (arg == "simple" || arg == "nosymbols") {
        options.symbols = false;
      } else {
        throw new Error(`generate takes a length, "words" or "simple", not ${arg}`);
      }
    }
    await this.offer("password", () => this.generate(options));
  },

  /** :bw.exe username */
  async offerUsername() {
    await this.offer("username", () => this.username());
  },

  /** Shows a new value with paste, copy and another one. */
  async offer(name, make) {
    let browser = Breached.selectedBrowser;
    let canPaste = /^https?:/.test(browser?.currentURI?.spec ?? "");
    let secret = name == "password";
    for (;;) {
      let value = await make();
      let rows = [];
      if (canPaste) {
        rows.push({ label: value, detail: `paste this ${name} into the box you were in`, act: "paste" });
      }
      rows.push(
        { label: canPaste ? `copy` : value, detail: `copy this ${name}${secret ? " (cleared after 30 seconds)" : ""}`, act: "copy" },
        { label: "another one", detail: `make a different ${name}`, act: "again" }
      );
      let picked = await Breached.pick(`new ${name}:`, rows);
      if (!picked) {
        return null;
      }
      if (picked.act == "again") {
        continue;
      }
      if (picked.act == "paste") {
        if (Breached.selectedBrowser !== browser) {
          return null;
        }
        await this.paste(browser, [value]);
        Breached.showMessage(`Pasted the new ${name}`);
      } else {
        this.copy(value, secret);
        Breached.showMessage(`Copied the new ${name}`);
      }
      return value;
    }
  },

  /** A random username: a word and digits, or an address from the email setting. */
  async username() {
    let r = await this.bw(["generate", "--passphrase", "--words", "1", "--separator", ""]);
    let word = r.code == 0 && /^[a-z]+$/i.test(r.stdout) ? r.stdout.toLowerCase() : randomPassword(8, false).toLowerCase().replace(/[^a-z]/g, "") || "user";
    let digits = String(randomInt(10000)).padStart(4, "0");
    let email = Mod.pref("breached.mods.bitwarden.usernameEmail", "").trim();
    if (/^[^@\s]+@[^@\s]+$/.test(email)) {
      // Plus addressing: mail still reaches you, and shows which site it came from.
      let [user, domain] = email.split("@");
      return `${user}+${word}${digits}@${domain}`;
    }
    let domain = Mod.pref("breached.mods.bitwarden.usernameDomain", "").trim().replace(/^@/, "");
    if (/^[^@\s]+\.[^@\s]+$/.test(domain)) {
      return `${word}${digits}@${domain}`;
    }
    return word + digits;
  },

  /** :bw.exe new: a login for this site, with a new password, kept in the vault and pasted. */
  async newLogin() {
    let browser = Breached.selectedBrowser;
    let url = new URL(this.currentURL(browser));
    await this.unlock();
    let suggestions = [];
    for (let i = 0; i < 3; i++) {
      suggestions.push(await this.username());
    }
    let pickedName = await Breached.pick(`username for ${url.hostname}:`, [
      { label: "type my own", detail: "type the username or email address", own: true },
      ...[...new Set(suggestions)].map(name => ({ label: name, detail: "a new username", name })),
    ]);
    if (!pickedName) {
      return;
    }
    let username = pickedName.own ? await Breached.prompt(`username for ${url.hostname}:`) : pickedName.name;
    if (!username) {
      return;
    }
    let password = await this.generate();
    let item = {
      type: 1,
      name: url.hostname,
      notes: null,
      favorite: false,
      fields: [],
      login: { uris: [{ match: null, uri: url.origin }], username: username.trim(), password, totp: null },
      secureNote: null,
      card: null,
      identity: null,
      reprompt: 0,
    };
    Breached.showMessage("Saving…");
    let saved = await Passkeys.saveItem(item);
    this.items = [...(this.items ?? []).filter(i => i.id != saved.id), saved];
    this.touch();
    Breached.showMessage(`Saved ${username} for ${url.hostname} in Bitwarden`);
    let action = await Breached.pick(`${username}:`, [
      { label: "paste both", detail: "username, Tab, password", parts: [username.trim(), "\t", password] },
      { label: "paste password", detail: "into the box you were in", parts: [password] },
      { label: "paste username", detail: username, parts: [username.trim()] },
      { label: "copy password", detail: "cleared from the clipboard after 30 seconds", copy: password },
    ]);
    if (!action || Breached.selectedBrowser !== browser) {
      return;
    }
    if (action.copy) {
      this.copy(action.copy, true);
      Breached.showMessage("Copied the new password");
    } else {
      await this.paste(browser, action.parts);
      Breached.showMessage(`Pasted the ${action.label.replace("paste ", "")}`);
    }
  },

  async totp(item) {
    let r = await this.bw(["get", "totp", item.id]);
    if (r.code != 0) {
      throw new Error(r.stderr || "couldn't get the code");
    }
    return r.stdout;
  },

  /** Types into the page's focused box, as a keyboard would; "\t" presses Tab. */
  async paste(browser, parts) {
    browser.focus();
    // Let the page get its focus back (the rows had it).
    await new Promise(r => setTimeout(r, 150));
    let tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    if (!tip.beginInputTransaction(window, () => true)) {
      throw new Error("couldn't type into the page");
    }
    for (let part of parts) {
      if (part == "\t") {
        let tab = new KeyboardEvent("", { key: "Tab", code: "Tab", keyCode: KeyboardEvent.DOM_VK_TAB });
        tip.keydown(tab);
        tip.keyup(tab);
        // Let the page move its focus.
        await new Promise(r => setTimeout(r, 100));
      } else {
        tip.commitCompositionWith(part);
      }
    }
  },

  /** Copies text; a secret is cleared after 30 seconds if it's still there. */
  copy(text, secret) {
    let helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
    helper.copyString(text);
    if (secret) {
      clearTimeout(this._clearTimer);
      this._clearTimer = setTimeout(() => {
        if (readClipboard() === text) {
          helper.copyString("");
        }
      }, 30 * 1000);
    }
  },
};

/**
 * The PIN: the unlock key locked with a key made from the PIN (PBKDF2 and
 * AES-GCM). Kept in memory, and in the profile if the setting says so.
 */
const Pin = {
  PREF: "breached.mods.bitwarden.pinLocked",
  _memory: null, // { salt, iv, data } as base64

  keepAfterRestart() {
    return Mod.pref("breached.mods.bitwarden.pin", "ask") == "restart";
  },

  stored() {
    if (this._memory) {
      return this._memory;
    }
    if (!this.keepAfterRestart()) {
      return null;
    }
    try {
      return JSON.parse(Mod.pref(this.PREF, "")) || null;
    } catch (e) {
      return null;
    }
  },

  has() {
    return Mod.pref("breached.mods.bitwarden.pin", "ask") != "off" && !!this.stored();
  },

  async key(pin, salt) {
    let base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async set(session, { offer }) {
    let pin = await Breached.prompt(
      offer ? "choose a PIN to unlock Bitwarden next time (Esc to skip):" : "new bitwarden PIN:",
      { password: true }
    );
    if (!pin) {
      return;
    }
    let again = await Breached.prompt("the PIN again:", { password: true });
    if (again !== pin) {
      Breached.showMessage("The PINs didn't match, so no PIN was set (:bw.exe pin to try again)", "error");
      return;
    }
    let salt = crypto.getRandomValues(new Uint8Array(16));
    let iv = crypto.getRandomValues(new Uint8Array(12));
    let data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(pin, salt), new TextEncoder().encode(session));
    this._memory = { salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) };
    if (this.keepAfterRestart()) {
      Services.prefs.setStringPref(this.PREF, JSON.stringify(this._memory));
    }
    Breached.showMessage(
      this.keepAfterRestart() ? "PIN set" : "PIN set (until Breached closes; then the master password again)"
    );
  },

  /** Asks for the PIN; the unlock key, or null for "use the master password". */
  async unlock() {
    let stored = this.stored();
    for (let tries = 0; tries < 3; tries++) {
      let pin = await Breached.prompt(
        tries ? "wrong PIN, try again:" : "bitwarden PIN (Esc for the master password):",
        { password: true }
      );
      if (!pin) {
        return null;
      }
      try {
        let plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: unb64(stored.iv) },
          await this.key(pin, unb64(stored.salt)),
          unb64(stored.data)
        );
        return new TextDecoder().decode(plain);
      } catch (e) {
        // wrong PIN
      }
    }
    this.forget();
    Breached.showMessage("Three wrong PINs: the PIN is off until you unlock with the master password", "error");
    return null;
  },

  forget() {
    this._memory = null;
    Services.prefs.clearUserPref(this.PREF);
  },
};

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// The mod's modules by version, so an updated mod doesn't get the old
// ones Gecko still holds from before (until Breached restarts).
const V = "?v=" + Mod.info.version;

const PasskeyCrypto = ChromeUtils.importESModule(Mod.url + "PasskeyCrypto.sys.mjs" + V);
const { Passkeys: Engine } = ChromeUtils.importESModule("resource://breached/Passkeys.sys.mjs");

/**
 * Bitwarden as Breached's passkey provider. Breached's built-in
 * authenticator answers the sites (inside Gecko, so nothing goes to Windows
 * Hello); this loads the vault's passkeys into it and keeps the ones sites
 * make in the vault.
 */
const Passkeys = {
  name: "Bitwarden",
  // Passkeys sites made while the vault was locked: [{ passkey, browser }]
  unsaved: [],

  on() {
    // ("ask" and "auto" were the settings before 1.7.)
    return Mod.pref("breached.mods.bitwarden.passkeys", "on") != "off";
  },

  userOf({ item, passkey }) {
    return passkey.userName || item.login?.username || passkey.userDisplayName || item.name;
  },

  /** Loads the vault's passkeys into Breached (the vault is unlocked). */
  async load() {
    if (!Engine.running) {
      // (The logins still go into memory, for Ctrl+Shift+L and autofill.)
      await Bitwarden.vault({ fresh: true });
      return;
    }
    // New ones made while locked go into the vault first, then load with the rest.
    await this.saveUnsaved();
    let items = await Bitwarden.vault({ fresh: true });
    let list = [];
    for (let item of items) {
      for (let passkey of item.login?.fido2Credentials ?? []) {
        if (passkey.keyAlgorithm && passkey.keyAlgorithm != "ECDSA") {
          continue;
        }
        try {
          list.push({
            credentialId: PasskeyCrypto.toB64url(PasskeyCrypto.credentialIdBytes(passkey.credentialId)),
            rpId: String(passkey.rpId).toLowerCase(),
            privateKey: PasskeyCrypto.toB64url(PasskeyCrypto.fromB64(passkey.keyValue)),
            userHandle: passkey.userHandle ? PasskeyCrypto.toB64url(PasskeyCrypto.fromB64(passkey.userHandle)) : "",
            signCount: Number(passkey.counter) || 0,
            discoverable: String(passkey.discoverable) != "false",
            name: this.userOf({ item, passkey }),
            itemId: item.id,
            stored: passkey.credentialId,
          });
        } catch (e) {
          console.error(`Bitwarden: skipping a passkey of ${item.name}`, e);
        }
      }
    }
    Engine.load(list);
  },

  /** A site asked for a passkey while none are loaded: unlock, then it can try again. */
  request(browser, origin) {
    let host = new URL(origin).hostname;
    Breached.showMessage(`${host} asked for a passkey: unlock Bitwarden, then try again`);
    Bitwarden.unlock().catch(e => {
      if (e.message != "cancelled") {
        Breached.showMessage(`bw.exe: ${e.message}`, "error");
      }
    });
  },

  /** A site made a passkey in Breached: keep it in the vault. */
  async created(passkey, browser) {
    this.unsaved.push({ passkey, browser });
    if (!Bitwarden.session) {
      Breached.showMessage(`Unlock Bitwarden (Ctrl+Shift+L) to keep the new passkey for ${passkey.rpId}`);
      return;
    }
    await this.saveUnsaved();
  },

  async saveUnsaved() {
    while (this.unsaved.length && Bitwarden.session) {
      let { passkey, browser } = this.unsaved.shift();
      try {
        await this.save(passkey, browser);
      } catch (e) {
        Breached.showMessage(`Couldn't save the passkey for ${passkey.rpId} in Bitwarden: ${e.message}`, "error");
      }
    }
  },

  async save(passkey, browser) {
    let url = browser?.currentURI?.spec ?? `https://${passkey.rpId}/`;
    // Onto the site's only login without a passkey, or a new login.
    let logins = (await Bitwarden.logins(url)).filter(i => !i.login.fido2Credentials?.length);
    let login = logins.length == 1 ? logins[0] : null;
    let username = login?.login.username ?? "";
    let id = PasskeyCrypto.fromB64(passkey.credentialId);
    let stored = {
      credentialId: id.length == 16 ? PasskeyCrypto.bytesToGuid(id) : "b64." + passkey.credentialId,
      keyType: "public-key",
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
      keyValue: passkey.privateKey,
      rpId: passkey.rpId,
      rpName: passkey.rpId,
      userHandle: passkey.userHandle,
      userName: username,
      userDisplayName: username,
      counter: String(passkey.signCount || 0),
      discoverable: String(passkey.discoverable !== false),
      creationDate: new Date().toISOString(),
    };
    let saved;
    if (login) {
      let item = await Bitwarden.json(["get", "item", login.id]);
      item.login.fido2Credentials = [stored];
      saved = await this.saveItem(item);
    } else {
      saved = await this.saveItem({
        organizationId: null,
        collectionIds: null,
        folderId: null,
        type: 1,
        name: passkey.rpId,
        notes: null,
        favorite: false,
        fields: [],
        login: {
          uris: [{ match: null, uri: new URL(url).origin }],
          username: username || null,
          password: null,
          totp: null,
          fido2Credentials: [stored],
        },
        secureNote: null,
        card: null,
        identity: null,
        reprompt: 0,
      });
    }
    Object.assign(passkey, { name: username || passkey.rpId, itemId: saved?.id ?? login?.id, stored: stored.credentialId });
    Bitwarden.touch();
    Breached.showMessage(`Saved a passkey${username ? " for " + username : ""} on ${passkey.rpId} in Bitwarden`);
  },

  /** A passkey signed in: keep its count in the vault, so the next start carries on from it. */
  async used(passkey) {
    if (passkey.itemId && Bitwarden.session) {
      await this.saveCounter(passkey.itemId, passkey.stored, passkey.signCount);
    }
  },

  async saveCounter(id, credentialId, counter) {
    let item = await Bitwarden.json(["get", "item", id]);
    let passkey = item.login?.fido2Credentials?.find(p => p.credentialId == credentialId);
    if (passkey && Number(passkey.counter) < counter) {
      passkey.counter = String(counter);
      await this.saveItem(item);
    }
  },

  /** bw.exe create item / edit item with the item as base64 JSON. */
  async saveItem(item) {
    let encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(item))));
    let args = item.id ? ["edit", "item", item.id, encoded] : ["create", "item", encoded];
    let saved = await Bitwarden.json(args);
    Bitwarden.refresh();
    return saved;
  },
};
// Each window runs this mod; Breached has one passkey provider. A popup
// window (an extension's) or a private one doesn't take it.
window.breachedBitwardenPasskeys = Passkeys;
const PASSKEYS_PREF = "breached.mods.bitwarden.passkeys";
if (["ask", "auto"].includes(Mod.pref(PASSKEYS_PREF, "on"))) {
  Services.prefs.setStringPref(PASSKEYS_PREF, "on");
}
const passkeysSetting = () => {
  if (Passkeys.on() && !Breached.isPopup && !Breached.isPrivate && !Engine.running) {
    Engine.start(Passkeys);
    if (Bitwarden.session) {
      Passkeys.load().catch(e => console.error("Bitwarden: loading passkeys", e));
    }
  } else if (!Passkeys.on() && Engine.provider === Passkeys) {
    Engine.stop();
  }
};
passkeysSetting();
Services.prefs.addObserver(PASSKEYS_PREF, passkeysSetting);
// Before 1.7 the passkeys were answered in the page.
for (let name of ["BitwardenPasskeys", "Bitwarden"]) {
  if (ModHost.Mods._actors?.has(name)) {
    try {
      ChromeUtils.unregisterWindowActor(name);
    } catch (e) {
      // not registered
    }
    ModHost.Mods._actors.delete(name);
  }
}

// ---------------------------------------------------------------- vault items

const KINDS = { 1: "login", 2: "secure note", 3: "card", 4: "identity" };

/** The detail shown beside an item's name. */
function summary(item) {
  let kind = KINDS[item.type];
  let extra =
    item.type == 1
      ? item.login?.username
      : item.type == 3
        ? [item.card?.brand, item.card?.number ? "…" + item.card.number.slice(-4) : null].filter(Boolean).join(" ")
        : item.type == 4
          ? [item.identity?.firstName, item.identity?.lastName].filter(Boolean).join(" ") || item.identity?.email
          : item.notes?.split(/\r?\n/)[0];
  return extra ? `${kind}: ${extra}` : kind;
}

/** An item's fields that can be copied: { name, value, shown, secret }. */
function fieldsOf(item) {
  let fields = [];
  // secret: hidden in the rows and cleared from the clipboard after 30 seconds.
  let add = (name, value, secret = true, shown = null) => {
    if (value != null && String(value).trim() !== "") {
      value = String(value);
      shown ??= secret ? "•".repeat(Math.min(value.length, 12)) : value.split(/\r?\n/)[0];
      fields.push({ name, value, secret, shown });
    }
  };
  let { login, card, identity: id } = item;
  if (item.type == 1 && login) {
    add("username", login.username, false);
    add("password", login.password);
    if (login.totp) {
      fields.push({ name: "two-step code", value: "", secret: true, shown: "the current code" });
    }
    add("web address", login.uris?.[0]?.uri, false);
  } else if (item.type == 3 && card) {
    add("card number", card.number);
    add("cardholder name", card.cardholderName, false);
    if (card.expMonth || card.expYear) {
      add("expiry", `${String(card.expMonth ?? "").padStart(2, "0")}/${card.expYear ?? ""}`, false);
    }
    add("security code", card.code);
  } else if (item.type == 4 && id) {
    add("name", [id.title, id.firstName, id.middleName, id.lastName].filter(Boolean).join(" "), false);
    add("email", id.email, false);
    add("phone", id.phone, false);
    add("username", id.username, false);
    add("company", id.company, false);
    add("address", [id.address1, id.address2, id.address3].filter(Boolean).join(", "), false);
    add("city", id.city, false);
    add("state", id.state, false);
    add("postal code", id.postalCode, false);
    add("country", id.country, false);
    add("social security number", id.ssn);
    add("passport number", id.passportNumber);
    add("licence number", id.licenseNumber);
  }
  // A note's first line shows; the clipboard is still cleared.
  add("note", item.notes, true, item.notes?.split(/\r?\n/).find(l => l.trim())?.trim());
  for (let field of item.fields ?? []) {
    // Custom fields: 0 text, 1 hidden, 2 a tick box, 3 linked (nothing to copy).
    if (field.type == 3) {
      continue;
    }
    add(field.name || "field", field.type == 2 ? String(field.value == "true") : field.value, field.type == 1);
  }
  return fields;
}

/** A random number below n, without the bias of %. */
function randomInt(n) {
  let limit = Math.floor(0x100000000 / n) * n;
  let value;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= limit);
  return value % n;
}

/** Like Bitwarden's default: upper and lower case, digits and (unless simple) symbols, one of each. */
function randomPassword(length, symbols = true) {
  let sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789"];
  if (symbols) {
    sets.push("!@#$%^&*");
  }
  let all = sets.join("");
  let chars = sets.map(set => set[randomInt(set.length)]);
  while (chars.length < length) {
    chars.push(all[randomInt(all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    let j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function generatorLength() {
  let length = parseInt(Mod.pref("breached.mods.bitwarden.generateLength", "20"), 10);
  return Number.isFinite(length) ? Math.min(128, Math.max(5, length)) : 20;
}

/** The site part Bitwarden's default "base domain" matching compares. */
function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch (e) {
    return host; // an IP address or localhost
  }
}

/** Whether one of a login's web addresses matches the page (Bitwarden's match detection). */
function uriMatches({ uri, match }, page) {
  if (!uri) {
    return false;
  }
  let saved;
  try {
    saved = new URL(/^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : "https://" + uri);
  } catch (e) {
    return false;
  }
  switch (match ?? 0) {
    case 0: // base domain
      return /^https?:$/.test(saved.protocol) && baseDomain(saved.hostname) == baseDomain(page.hostname);
    case 1: // host (with port)
      return saved.host == page.host;
    case 2: // starts with
      return page.href.startsWith(uri);
    case 3: // exact
      return page.href == uri;
    case 4: // regular expression
      try {
        return new RegExp(uri, "i").test(page.href);
      } catch (e) {
        return false;
      }
    default: // 5: never
      return false;
  }
}

// ---------------------------------------------------------------- autofill

const Autofill = ChromeUtils.importESModule(Mod.url + "Autofill.sys.mjs" + V);
const AUTOFILL_PREF = "breached.mods.bitwarden.autofill";

/** Gecko's password manager asks this for a site's logins (see Autofill.sys.mjs). */
const Logins = {
  /** The unlocked vault's logins for a page's origin; none while locked. */
  loginsFor(origin) {
    if (!Bitwarden.session || !Bitwarden.items) {
      return [];
    }
    Bitwarden.touch();
    return Bitwarden.matching(Bitwarden.items, origin + "/").map(i => ({
      id: i.id,
      username: i.login.username ?? "",
      password: i.login.password ?? "",
    }));
  },

  loginById(id, origin) {
    let item = Bitwarden.session && Bitwarden.items?.find(i => i.id == id && i.type == 1);
    if (!item || (origin && !Bitwarden.matching([item], origin + "/").length)) {
      return null;
    }
    return { id, origin, username: item.login.username ?? "", password: item.login.password ?? "" };
  },
};
window.breachedBitwardenLogins = Logins;

/** Gecko's login prefs, unless the Passwords mod (Gecko's own saved passwords) sets them. */
function autofillPrefs(mode) {
  if (ModHost.loaded.has("passwords")) {
    return;
  }
  if (mode == "off") {
    Services.prefs.setBoolPref("signon.rememberSignons", false);
    Services.prefs.clearUserPref("signon.storeSignons");
    return;
  }
  Services.prefs.setBoolPref("signon.rememberSignons", true);
  // Fill and suggest, but never save passwords in Gecko's own store.
  Services.prefs.setBoolPref("signon.storeSignons", false);
  Services.prefs.setBoolPref("signon.autofillForms", mode == "fill");
}

const autofillSetting = () => {
  let mode = Mod.pref(AUTOFILL_PREF, "fill");
  let ours = Autofill.provider() === Logins;
  if (mode == "off") {
    if (ours) {
      Autofill.stop();
      autofillPrefs("off");
    }
    return;
  }
  if (Breached.isPopup || (Autofill.provider() && !ours)) {
    if (ours) {
      autofillPrefs(mode);
    }
    return;
  }
  Autofill.start(Logins);
  autofillPrefs(mode);
};
autofillSetting();
Services.prefs.addObserver(AUTOFILL_PREF, autofillSetting);

/** The clipboard's text, or null. */
function readClipboard() {
  try {
    let trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    trans.init(null);
    trans.addDataFlavor("text/plain");
    Services.clipboard.getData(trans, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
    let data = {};
    trans.getTransferData("text/plain", data);
    return data.value?.QueryInterface(Ci.nsISupportsString).data ?? null;
  } catch (e) {
    return null;
  }
}

Mod.command("bw.exe", {
  usage:
    "bw.exe [find|notes|generate|username|new|totp|sync|lock|login|pin|status]  (paste or copy this site's login from Bitwarden; Ctrl+Shift+L)",
  run(args) {
    Bitwarden.run(args).catch(e => {
      if (e.message != "cancelled") {
        console.error("Bitwarden", e);
        Breached.showMessage(`bw.exe: ${e.message}`, "error");
      }
    });
  },
});
Mod.command("bw", { alias: "bw.exe" });
Mod.key("l", "accel,shift", () => Breached.run("bw.exe"));
Mod.onUnload(() => {
  Bitwarden.lock();
  delete window.breachedBitwardenPasskeys;
  delete window.breachedBitwardenLogins;
  Services.prefs.removeObserver(AUTOFILL_PREF, autofillSetting);
  if (Autofill.provider() === Logins) {
    let other = [...Services.wm.getEnumerator("breached:main")].find(w => w != window && !w.closed && w.breachedBitwardenLogins);
    if (other && ModHost.loaded.has("bitwarden")) {
      Autofill.handOver(other.breachedBitwardenLogins);
    } else {
      Autofill.stop();
      autofillPrefs("off");
    }
  }
  Services.prefs.removeObserver(PASSKEYS_PREF, passkeysSetting);
  if (Engine.provider === Passkeys) {
    // Hand the passkeys to another window running the mod, else back to Windows.
    let other = [...Services.wm.getEnumerator("breached:main")].find(w => w != window && !w.closed && w.breachedBitwardenPasskeys);
    if (other && ModHost.loaded.has("bitwarden") && Passkeys.on()) {
      Engine.provider = other.breachedBitwardenPasskeys;
    } else {
      Engine.stop();
    }
  }
});
