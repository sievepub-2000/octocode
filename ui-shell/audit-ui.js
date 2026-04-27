(function () {
  const AUDIT_URL = "/api/audit";

  function createPanel() {
    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.width = "360px";
    panel.style.maxHeight = "40vh";
    panel.style.overflow = "auto";
    panel.style.background = "rgba(20,20,20,0.95)";
    panel.style.color = "#eee";
    panel.style.fontSize = "12px";
    panel.style.border = "1px solid #444";
    panel.style.borderRadius = "8px";
    panel.style.padding = "8px";
    panel.style.zIndex = "9999";

    const title = document.createElement("div");
    title.textContent = "⚠ Audit / Danger Log";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "6px";

    const list = document.createElement("div");
    list.id = "audit-list";

    panel.appendChild(title);
    panel.appendChild(list);
    document.body.appendChild(panel);
    return list;
  }

  async function loadAudit(listEl) {
    try {
      const res = await fetch(AUDIT_URL);
      const data = await res.json();
      const items = data.items || [];
      listEl.innerHTML = "";
      items.slice(0, 20).forEach((item) => {
        const row = document.createElement("div");
        row.style.borderBottom = "1px solid #333";
        row.style.padding = "4px";
        row.innerHTML = `
          <div style="color:#f66">${item.kind}</div>
          <div style="color:#aaa">${new Date(item.atMs).toLocaleTimeString()}</div>
          <div>${item.detail}</div>
        `;
        listEl.appendChild(row);
      });
    } catch (e) {
      listEl.innerHTML = "audit load failed";
    }
  }

  function dangerBadge() {
    const badge = document.createElement("div");
    badge.textContent = "⚠ DANGER MODE";
    badge.style.position = "fixed";
    badge.style.top = "10px";
    badge.style.right = "10px";
    badge.style.background = "#ff4444";
    badge.style.color = "white";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "6px";
    badge.style.fontWeight = "bold";
    badge.style.zIndex = "9999";
    document.body.appendChild(badge);
  }

  window.addEventListener("load", () => {
    const list = createPanel();
    dangerBadge();
    loadAudit(list);
    setInterval(() => loadAudit(list), 3000);
  });
})();