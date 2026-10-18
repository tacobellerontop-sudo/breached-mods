/* Tab groups mod.
 *
 *   :group <name>   put this tab in a group (made if it's new)
 *   :group          pick one of the groups for this tab
 *   :ungroup        take this tab out of its group
 *   :groups         pick a group to fold away or open again
 *
 * A group's name sits in the tab bar before its first tab; clicking it
 * folds the group. Groups are kept by the tabs' addresses, so they come back
 * when Breached reopens your tabs. */

"use strict";

const STATE = "breached.mods.groups.state";
const COLOURS = ["#e8955a", "#6aa5d8", "#7cc47f", "#c88bd9", "#e0c25c", "#e07b7b", "#5fc4bd", "#a0a0aa"];

// name -> { colour, folded }
const groups = new Map();
// Tab -> group name
const member = new WeakMap();

const CSS = `
.tab[data-group] { box-shadow: inset 0 3px 0 var(--group-colour); }
:root[tabs-vertical] .tab[data-group] { box-shadow: inset 3px 0 0 var(--group-colour); }
.tab[group-folded]:not([selected]) { display: none; }
.group-label {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 6px;
  max-width: 140px;
  background: var(--group-colour);
  color: #1d1d21;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  -moz-window-dragging: no-drag;
}
.group-label[folded]::after { content: " \\2026"; }
`;
const sheet = Services.io.newURI("data:text/css," + encodeURIComponent(CSS));
window.windowUtils.loadSheet(sheet, window.windowUtils.AUTHOR_SHEET);
Mod.onUnload(() => window.windowUtils.removeSheet(sheet, window.windowUtils.AUTHOR_SHEET));

function groupOf(tab) {
  return tab ? member.get(tab) ?? null : null;
}

function nextColour() {
  let used = new Set([...groups.values()].map(g => g.colour));
  return COLOURS.find(c => !used.has(c)) ?? COLOURS[groups.size % COLOURS.length];
}

/** Puts tab in group name, next to the group's other tabs. */
function join(tab, name) {
  if (!groups.has(name)) {
    groups.set(name, { colour: nextColour(), folded: false });
  }
  member.set(tab, name);
  let others = Breached.tabs.filter(t => t !== tab && groupOf(t) == name);
  if (others.length) {
    let last = others.at(-1).index;
    Breached.moveTab(tab, last + (tab.index < last ? 0 : 1));
  }
  render();
  save();
}

function leave(tab) {
  member.delete(tab);
  render();
  save();
}

function toggle(name) {
  let g = groups.get(name);
  if (g) {
    g.folded = !g.folded;
    render();
    save();
  }
}

/** Draws the colours and the group names in the tab bar. */
function render() {
  let bar = Breached.$tabbar;
  for (let label of bar.querySelectorAll(".group-label")) {
    label.remove();
  }
  // Groups without tabs are gone.
  let live = new Set(Breached.tabs.map(groupOf).filter(Boolean));
  for (let name of [...groups.keys()]) {
    if (!live.has(name)) {
      groups.delete(name);
    }
  }
  let labelled = new Set();
  for (let tab of Breached.tabs) {
    let name = groupOf(tab);
    let g = name && groups.get(name);
    tab.el.toggleAttribute("data-group", !!g);
    tab.el.toggleAttribute("group-folded", !!g?.folded);
    if (!g) {
      tab.el.style.removeProperty("--group-colour");
      continue;
    }
    tab.el.setAttribute("data-group", name);
    tab.el.style.setProperty("--group-colour", g.colour);
    if (!labelled.has(name)) {
      labelled.add(name);
      let label = document.createElement("span");
      label.className = "group-label";
      label.textContent = name;
      label.title = g.folded ? `${name}: click to open the group` : `${name}: click to fold the group away`;
      label.style.setProperty("--group-colour", g.colour);
      label.toggleAttribute("folded", g.folded);
      label.dataset.group = name;
      label.addEventListener("mousedown", event => {
        if (event.button == 0) {
          event.preventDefault();
          event.stopPropagation();
          toggle(name);
        }
      });
      bar.insertBefore(label, tab.el);
    }
  }
}

// ------------------------------------------------------------ saving

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (Breached.isPrivate) {
      return;
    }
    let state = {
      groups: Object.fromEntries(groups),
      tabs: Breached.tabs.filter(t => groupOf(t)).map(t => [t.url, groupOf(t)]),
    };
    Services.prefs.setStringPref(STATE, JSON.stringify(state));
  }, 500);
}

function restore() {
  let state;
  try {
    state = JSON.parse(Services.prefs.getStringPref(STATE, "{}"));
  } catch (e) {
    return;
  }
  for (let [name, g] of Object.entries(state.groups ?? {})) {
    groups.set(name, { colour: g.colour ?? nextColour(), folded: !!g.folded });
  }
  let free = [...Breached.tabs];
  for (let [url, name] of state.tabs ?? []) {
    let i = free.findIndex(t => t.url == url);
    if (i >= 0 && groups.has(name)) {
      member.set(free[i], name);
      free.splice(i, 1);
    }
  }
}

if (!Breached.isPrivate) {
  restore();
}
render();

let onChange = () => {
  render();
  save();
};
for (let type of ["TabOpen", "TabClose", "TabMove", "TabSelect"]) {
  window.addEventListener("Breached:" + type, onChange);
  Mod.onUnload(() => window.removeEventListener("Breached:" + type, onChange));
}
// A tab opened from a grouped tab joins its group.
let onOpen = event => {
  let tab = event.detail?.tab;
  let name = groupOf(tab?.opener);
  if (tab && name && !groupOf(tab)) {
    join(tab, name);
  }
};
window.addEventListener("Breached:TabOpen", onOpen);
Mod.onUnload(() => window.removeEventListener("Breached:TabOpen", onOpen));
Mod.onUnload(() => {
  for (let tab of Breached.tabs) {
    tab.el.removeAttribute("data-group");
    tab.el.removeAttribute("group-folded");
    tab.el.style.removeProperty("--group-colour");
  }
  for (let label of Breached.$tabbar.querySelectorAll(".group-label")) {
    label.remove();
  }
});
Mod.onUninstall(() => Services.prefs.clearUserPref(STATE));

// ------------------------------------------------------------ commands

Mod.command("group", {
  usage: "group [name]  (put this tab in a group; no name lists the groups)",
  async run(args) {
    let tab = Breached.selected;
    let name = args.trim();
    if (!name) {
      if (!groups.size) {
        throw new Error("no groups yet: :group <name> makes one");
      }
      let picked = await Breached.pick(
        "Put this tab in which group?",
        [...groups.keys()].map(n => ({ label: n, detail: `${Breached.tabs.filter(t => groupOf(t) == n).length} tabs`, answer: n }))
      );
      if (!picked) {
        return;
      }
      name = picked.answer;
    }
    join(tab, name);
    Breached.showMessage(`Tab in group ${name}`);
  },
});

Mod.command("ungroup", {
  usage: "ungroup  (take this tab out of its group)",
  run() {
    let tab = Breached.selected;
    if (!groupOf(tab)) {
      throw new Error("this tab isn't in a group");
    }
    leave(tab);
  },
});

Mod.command("groups", {
  usage: "groups  (pick a group to fold away or open again)",
  async run() {
    if (!groups.size) {
      throw new Error("no groups yet: :group <name> makes one");
    }
    let picked = await Breached.pick(
      "Fold or open which group?",
      [...groups].map(([n, g]) => ({
        label: n,
        detail: `${Breached.tabs.filter(t => groupOf(t) == n).length} tabs, ${g.folded ? "folded away" : "open"}`,
        answer: n,
      }))
    );
    if (picked) {
      toggle(picked.answer);
    }
  },
});

// For the self-test.
Mod.hook("groups", { groupOf, join, leave, toggle, groups });
