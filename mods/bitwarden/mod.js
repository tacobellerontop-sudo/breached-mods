/* Bitwarden mod: fills logins from your vault through the Bitwarden CLI.
 *
 *   :bw.exe          fill the login for this page (asks for your master
 *                    password the first time). With several logins they
 *                    show as rows above the command bar: type to narrow,
 *                    Up/Down or Tab to move, Enter to fill.
 *                    A page with a login form shows the rows by itself
 *                    (unless the setting says only with :bw.exe).
 *   :bw.exe totp     copy this page's two-step code
 *   :bw.exe sync     fetch the latest vault
 *   :bw.exe lock     forget the unlock key
 *   :bw.exe login    log in to Bitwarden
 *   :bw.exe status
 *
 * Passkeys: when a site asks to sign in with a passkey, the ones Bitwarden
 * has for it show as rows (or one is used straight away, if the setting
 * says so). A site that offers passkeys in its login box without asking
 * shows them with its logins. New passkeys can be kept in Bitwarden too. The
 * signing happens here (PasskeyCrypto.sys.mjs); bw.exe only stores them.
 *
 * The unlock key is kept in memory only, and the master password is passed
 * to bw.exe in an environment variable, never on its command line. */

"use strict";

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const Bitwarden = {
  session: null,
  _lockTimer: null,

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

  lock() {
    clearTimeout(this._lockTimer);
    this.session = null;
  },

  /** Makes sure the vault is unlocked, asking for the master password. */
  async unlock(label = "bitwarden master password:", { auto = false } = {}) {
    let status = await this.status();
    if (status == "unauthenticated") {
      throw new Error("not logged in: run :bw.exe login (or bw login in a terminal)");
    }
    if (status == "unlocked" && this.session) {
      return;
    }
    if (auto && Bitwarden.busy()) {
      throw new Error("cancelled"); // don't take over what's being typed
    }
    let password = await Breached.prompt(label, { password: true });
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

  async logins(url) {
    let items = await this.json(["list", "items", "--url", url]);
    return items.filter(i => i.type == 1 && i.login);
  },

  /** Fills a login into the page's frames from the same site (or the login's own sites). */
  async fill(item, browser = Breached.selectedBrowser) {
    let top = browser.browsingContext;
    let sites = new Set([siteOf(top.currentWindowGlobal?.documentPrincipal)]);
    for (let { uri } of item.login.uris ?? []) {
      try {
        sites.add(siteOf(Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(uri), {})));
      } catch (e) {
        // not a web address
      }
    }
    sites.delete(null);
    let filled = false;
    let problems = [];
    let seen = [];
    // A page that's still drawing its form (after a reload, say) gets a few tries.
    for (let attempt = 0; attempt < 5 && !filled; attempt++) {
      if (attempt) {
        await new Promise(r => setTimeout(r, 500));
      }
      problems = [];
      seen = [];
      for (let bc of top.getAllBrowsingContextsInSubtree()) {
        let wg = bc.currentWindowGlobal;
        if (!wg || !sites.has(siteOf(wg.documentPrincipal))) {
          continue;
        }
        try {
          let r = await wg.getActor(ACTOR).sendQuery("Bitwarden:Fill", {
            username: item.login.username ?? "",
            password: item.login.password ?? "",
          });
          filled ||= r?.filled ?? r === true;
          if (!r?.filled) {
            seen.push(`${r?.url ?? wg.documentURI?.prePath}: ${r?.seen?.length ? r.seen.join(", ") : "no fields"}`);
          }
        } catch (e) {
          problems.push(`${wg.documentURI?.prePath}: ${e.message ?? e}`);
        }
      }
    }
    let who = item.login.username || item.name;
    if (filled) {
      Breached.showMessage(`Filled ${who}`);
    } else {
      let found = [...problems, ...seen];
      let why = found.length ? found.join("; ") : `no frames from ${[...sites].join(", ") || "a website"}`;
      Breached.showMessage(`No login form found for ${who} (Bitwarden ${Mod.info.version}; ${why})`, "error");
      console.error("Bitwarden: nothing filled", [...sites], found);
    }
  },

  async run(args) {
    let [sub, ...rest] = args.trim().split(/\s+/);
    switch (sub) {
      case "lock":
        this.lock();
        await this.bw(["lock"]);
        Breached.showMessage("Bitwarden locked");
        return;
      case "login":
        await this.login();
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
        let r = await this.bw(["get", "totp", item.id]);
        if (r.code != 0) {
          throw new Error(r.stderr || "couldn't get the code");
        }
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(r.stdout);
        Breached.showMessage("Two-step code copied");
        this.touch();
        return;
      }
    }
    if (sub) {
      throw new Error(`unknown: ${sub} (try fill, lock, sync, totp, login, status)`);
    }
    await this.choose(Breached.selectedBrowser, false);
  },

  /**
   * Shows this page's logins (and passkeys, if the page's login box is
   * waiting for one) as rows and fills the picked one. auto: the page asked
   * by showing a login form, not :bw.exe.
   */
  async choose(browser, auto, state = {}) {
    let url = this.currentURL(browser);
    await this.unlock(auto ? "bitwarden master password (Esc to skip):" : undefined, { auto });
    let logins = await this.logins(url);
    let waiting = Passkeys.waitingFor(browser);
    let passkeys = waiting ? await Passkeys.matches(waiting.request) : [];
    this.touch();
    if (Breached.selectedBrowser !== browser) {
      return;
    }
    if (!logins.length && !passkeys.length) {
      if (!auto) {
        Breached.showMessage("No Bitwarden logins for this site", "error");
      }
      return;
    }
    if (!auto && logins.length == 1 && !passkeys.length) {
      await this.fill(logins[0], browser);
      return;
    }
    if (auto && this.busy()) {
      return; // the command bar opened meanwhile: don't take it over
    }
    state.picking = true;
    state.passkeys = !!waiting;
    let picked = await Breached.pick("bitwarden:", [
      ...passkeys.map(passkey => ({
        label: Passkeys.userOf(passkey),
        detail: `passkey, ${passkey.item.name}`,
        passkey,
      })),
      ...logins.map(login => ({
        label: login.login.username || "(no username)",
        detail: login.name,
        login,
      })),
    ]);
    // Another tab may be showing by now. (The page itself may have changed
    // or reloaded, as sign-in pages do: fill what's there now.)
    if (!picked || Breached.selectedBrowser !== browser) {
      return;
    }
    if (picked.passkey) {
      await Passkeys.answerWaiting(Passkeys.waitingFor(browser) ?? waiting, picked.passkey);
    } else {
      state.login = picked.login;
      await this.fill(picked.login, browser);
    }
  },

  /** Whether the command bar is open (typing a command, or another question). */
  busy() {
    return !document.getElementById("commandbar").hidden;
  },

  // browser -> { page, open, picking, passkeys, password, login }: the
  // login rows shown by themselves for its page, so each page gets them
  // once, and the login picked there.
  offered: new WeakMap(),

  /**
   * A page shows a login form ("form"), now with a password field
   * ("password", like the second step of Google's sign-in), or its login
   * box waits for a passkey ("passkey").
   */
  offer(browser, why, { fresh = false } = {}) {
    if (Mod.pref("breached.mods.bitwarden.popup", "login") == "off" || browser !== Breached.selectedBrowser) {
      return;
    }
    let page = browser.browsingContext?.currentWindowGlobal?.innerWindowId;
    let busy = this.busy();
    let state = this.offered.get(browser);
    if (fresh && state?.page == page && !state.open) {
      state = null; // back on this page (Back/Forward): offer again
    }
    if (state?.page == page) {
      if (why == "passkey" && state.open && state.picking && !state.passkeys) {
        // Add the passkey to the rows still open.
      } else if (why == "password" && !state.password) {
        state.password = true;
        if (state.login) {
          // The account picked on the first step: its password goes here.
          this.fill(state.login, browser);
          return;
        }
        if (state.open) {
          return; // the rows still open fill the password too
        }
        if (busy) {
          return;
        }
      } else {
        return;
      }
    } else {
      if (busy) {
        return; // something else is being typed or asked
      }
      state = { page, password: why == "password" };
      this.offered.set(browser, state);
    }
    state.open = true;
    let run = (state.run = {});
    this.choose(browser, true, state)
      .catch(e => {
        if (e.message != "cancelled") {
          console.error("Bitwarden", e);
          Breached.showMessage(`bw.exe: ${e.message}`, "error");
        }
      })
      .finally(() => {
        if (state.run === run) {
          state.open = false;
        }
      });
  },
};

// The mod's modules by version, so an updated mod doesn't get the old
// ones Gecko still holds from before (until Breached restarts).
const V = "?v=" + Mod.info.version;

const PasskeyCrypto = ChromeUtils.importESModule(Mod.url + "PasskeyCrypto.sys.mjs" + V);

/** Passkeys from the vault, for BitwardenPasskeysParent. */
const Passkeys = {
  // A page's login box asking for a passkey without a prompt (conditional
  // mediation) waits here for :bw.exe. actor -> { request, resolve, browser }
  waiting: new Map(),

  /** "ask" (rows), "auto" (use the only match without asking) or "off". */
  mode() {
    return Mod.pref("breached.mods.bitwarden.passkeys", "ask");
  },

  userOf({ item, passkey }) {
    return passkey.userName || item.login?.username || passkey.userDisplayName || item.name;
  },

  /** The vault's passkeys for a request: { item, passkey }. */
  async matches(request) {
    let items = await Bitwarden.json(["list", "items"]);
    let allowed = new Set(request.allowCredentials ?? []);
    let found = [];
    for (let item of items) {
      for (let passkey of item.login?.fido2Credentials ?? []) {
        if (String(passkey.rpId).toLowerCase() != request.rpId) {
          continue;
        }
        let id = PasskeyCrypto.toB64url(PasskeyCrypto.credentialIdBytes(passkey.credentialId));
        let discoverable = String(passkey.discoverable) != "false";
        if (allowed.size ? allowed.has(id) : discoverable) {
          found.push({ item, passkey });
        }
      }
    }
    return found;
  },

  /** Checks the request's site; fills in the rpId. False: leave it to Gecko. */
  prepare(request, rpId) {
    request.rpId = String(rpId ?? request.host).toLowerCase();
    let ok = this.mode() != "off" && PasskeyCrypto.rpIdAllowed(request.origin, request.rpId);
    if (!ok) {
      Services.console.logStringMessage(
        `Breached passkeys: leaving ${request.rpId} to Windows (setting ${this.mode()}, page ${request.origin})`
      );
      if (this.mode() != "off") {
        Breached.showMessage(`Bitwarden can't answer ${request.rpId}'s passkey request from ${request.origin}`, "error");
      }
    }
    return ok;
  },

  /** Asks "Bitwarden or something else?" for a locked vault. */
  async useBitwarden(browser, question, detail) {
    let picked = await Breached.pickForTab(browser, question, [
      { label: "bitwarden", detail, answer: "bitwarden" },
      { label: "other", detail: "Windows Hello or a security key", answer: "native" },
    ]);
    return picked?.answer ?? null;
  },

  async get(actor, browser, request) {
    if (!this.prepare(request, request.rpId)) {
      return null;
    }
    if (request.mediation == "conditional") {
      if (this.mode() == "auto" && Bitwarden.session) {
        let found = await this.matches(request);
        if (found.length == 1) {
          return this.sign(request, found[0]);
        }
      }
      let answer = new Promise(resolve => this.waiting.set(actor, { request, resolve, browser }));
      // The page's login box offers passkeys: show them (with the logins).
      Bitwarden.offer(browser, "passkey");
      return answer;
    }
    if (!Bitwarden.session) {
      let answer = await this.useBitwarden(
        browser,
        `${request.rpId} asks for a passkey:`,
        "unlock your vault and use a passkey from it"
      );
      if (answer != "bitwarden") {
        return answer == "native" ? null : { error: "NotAllowedError" };
      }
      try {
        await Bitwarden.unlock();
      } catch (e) {
        return { error: "NotAllowedError" };
      }
    }
    let found = await this.matches(request);
    Bitwarden.touch();
    if (!found.length) {
      // Say so rather than quietly handing it to Windows.
      let picked = await Breached.pickForTab(browser, `Bitwarden has no passkey for ${request.rpId}:`, [
        { label: "cancel", detail: "don't sign in with a passkey", answer: "cancel" },
        { label: "other", detail: "Windows Hello or a security key", answer: "native" },
      ]);
      return picked?.answer == "native" ? null : { error: "NotAllowedError" };
    }
    let choice = found[0];
    if (this.mode() != "auto" || found.length > 1) {
      let picked = await Breached.pickForTab(browser, `${request.rpId} passkey:`, [
        ...found.map(f => ({ label: this.userOf(f), detail: `passkey, ${f.item.name}`, found: f })),
        { label: "other", detail: "Windows Hello or a security key", native: true },
      ]);
      if (!picked) {
        return { error: "NotAllowedError" };
      }
      if (picked.native) {
        return null;
      }
      choice = picked.found;
    }
    return this.sign(request, choice);
  },

  async sign(request, { item, passkey }) {
    let counter = Number(passkey.counter) || 0;
    // Bitwarden leaves a counter at 0 (sites accept that); one in use goes up.
    let next = counter > 0 ? counter + 1 : 0;
    let credential = await PasskeyCrypto.assert(crypto.subtle, request, passkey, next);
    if (next) {
      this.saveCounter(item.id, passkey.credentialId, next).catch(e =>
        console.error("Bitwarden: saving the passkey counter", e)
      );
    }
    Breached.showMessage(`Signed in to ${request.rpId} as ${this.userOf({ item, passkey })} with a Bitwarden passkey`);
    return { credential };
  },

  async saveCounter(id, credentialId, counter) {
    let item = await Bitwarden.json(["get", "item", id]);
    let passkey = item.login?.fido2Credentials?.find(p => p.credentialId == credentialId);
    if (passkey) {
      passkey.counter = String(counter);
      await this.saveItem(item);
    }
  },

  /** bw.exe create item / edit item with the item as base64 JSON. */
  async saveItem(item) {
    let encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(item))));
    let args = item.id ? ["edit", "item", item.id, encoded] : ["create", "item", encoded];
    return Bitwarden.json(args);
  },

  /** For :bw.exe: the passkey request waiting on this tab's page, if any. */
  waitingFor(browser) {
    for (let [actor, entry] of this.waiting) {
      if (entry.browser === browser) {
        return { actor, ...entry };
      }
    }
    return null;
  },

  async answerWaiting(waiting, found) {
    if (!this.waiting.has(waiting.actor)) {
      Breached.showMessage("The page stopped waiting for a passkey", "error");
      return;
    }
    this.waiting.delete(waiting.actor);
    waiting.resolve(await this.sign(waiting.request, found));
  },

  async create(actor, browser, request) {
    if (!this.prepare(request, request.rp.id) || !request.algorithms.includes(-7)) {
      return null;
    }
    let user = request.user.name || request.user.displayName;
    if (this.mode() != "auto") {
      let answer = await this.useBitwarden(
        browser,
        `${request.rpId} wants to make a passkey for ${user}:`,
        "keep it in your Bitwarden vault"
      );
      if (answer != "bitwarden") {
        return answer == "native" ? null : { error: "NotAllowedError" };
      }
    }
    try {
      await Bitwarden.unlock();
    } catch (e) {
      return { error: "NotAllowedError" };
    }
    if (request.excludeCredentials.length) {
      let existing = await this.matches({ ...request, allowCredentials: request.excludeCredentials });
      if (existing.length) {
        Breached.showMessage(`Bitwarden already has a passkey for ${user} on ${request.rpId}`, "error");
        return { error: "InvalidStateError", message: "This account already has a passkey here." };
      }
    }
    let made = await PasskeyCrypto.create(
      crypto.subtle,
      { ...request, rpName: request.rp.name },
      () => crypto.randomUUID()
    );
    // Onto this site's login for the same user, or a new login.
    let login = (await Bitwarden.logins(request.origin)).find(
      i => i.login.username == request.user.name && !i.login.fido2Credentials?.length
    );
    try {
      if (login) {
        let item = await Bitwarden.json(["get", "item", login.id]);
        item.login.fido2Credentials = [made.passkey];
        await this.saveItem(item);
      } else {
        await this.saveItem({
          organizationId: null,
          collectionIds: null,
          folderId: null,
          type: 1,
          name: request.rp.name || request.rpId,
          notes: null,
          favorite: false,
          fields: [],
          login: {
            uris: [{ match: null, uri: request.origin }],
            username: request.user.name,
            password: null,
            totp: null,
            fido2Credentials: [made.passkey],
          },
          secureNote: null,
          card: null,
          identity: null,
          reprompt: 0,
        });
      }
    } catch (e) {
      Breached.showMessage(`Couldn't save the passkey in Bitwarden: ${e.message}`, "error");
      return { error: "NotAllowedError" };
    }
    Bitwarden.touch();
    Breached.showMessage(`Saved a passkey for ${user} on ${request.rpId} in Bitwarden`);
    return { credential: made.credential };
  },

  abort(actor, id) {
    let entry = this.waiting.get(actor);
    if (entry?.request.id == id) {
      this.waiting.delete(actor);
      entry.resolve(null);
    }
  },

  forget(actor) {
    let entry = this.waiting.get(actor);
    this.waiting.delete(actor);
    entry?.resolve(null);
  },
};
const { setHandler } = ChromeUtils.importESModule(Mod.url + "PasskeysParent.sys.mjs" + V);
setHandler(window, Passkeys);
const LoginForms = ChromeUtils.importESModule(Mod.url + "BitwardenParent.sys.mjs" + V);
LoginForms.setHandler(window, Bitwarden);

Mod.actor("BitwardenPasskeys", {
  parent: "PasskeysParent.sys.mjs" + V,
  child: "PasskeysChild.sys.mjs" + V,
  // When the page's root element arrives, before its scripts run (like Firefox's about: pages).
  events: { DOMDocElementInserted: { capture: true } },
});

function siteOf(principal) {
  try {
    if (!principal || !/^https?$/.test(principal.scheme)) {
      return null;
    }
    return principal.baseDomain || principal.host;
  } catch (e) {
    return null;
  }
}

const ACTOR = Mod.actor("Bitwarden", {
  parent: "BitwardenParent.sys.mjs" + V,
  child: "BitwardenChild.sys.mjs" + V,
  // Pages with a login form show the vault's logins by themselves.
  events: { DOMContentLoaded: {}, pageshow: {}, focusin: {} },
  matches: ["http://*/*", "https://*/*"],
});

Mod.command("bw.exe", {
  usage: "bw.exe [totp|sync|lock|login|status]  (fill this page's login from Bitwarden)",
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
Mod.onUnload(() => {
  Bitwarden.lock();
  for (let actor of [...Passkeys.waiting.keys()]) {
    Passkeys.forget(actor);
  }
  setHandler(window, null);
  LoginForms.setHandler(window, null);
});
