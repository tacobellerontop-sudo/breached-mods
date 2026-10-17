// Breached marks this page when it opens it: <html data-breached="0.1.7">,
// and data-installed="<version>" on the Install link of each mod it has.
// Breached handles the clicks itself; other browsers download the zip.
"use strict";

function newer(a, b) {
  let x = a.split(".").map(Number);
  let y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) != (y[i] || 0)) {
      return (x[i] || 0) > (y[i] || 0);
    }
  }
  return false;
}

function render() {
  let inBreached = document.documentElement.hasAttribute("data-breached");
  for (let link of document.querySelectorAll("a[data-breached-mod]")) {
    let installed = link.getAttribute("data-installed");
    let state = !inBreached ? "download" : !installed ? "install" : newer(link.dataset.version, installed) ? "update" : "installed";
    link.dataset.state = state;
    link.textContent = { download: "Download", install: "Install", update: "Update", installed: "Installed" }[state];
    link.title = state == "installed" ? "Remove or change it in Breached's Settings > Mods" : "";
  }
}

render();
document.addEventListener("BreachedModsState", render);
