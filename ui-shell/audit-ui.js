(function () {
  const AUDIT_URL = "/api/audit";
  const STATE_URL = "/api/state";
  const MAX_ROWS = 30;

  const palette = {
    bg: "rgba(17, 19, 28, 0.96)",
    fg: "#eef2ff",
    muted: "#98a2b3",
    danger: "#ff4d4f",
    warn: "#f59e0b",
    ok: "#35c46a",
    border: "rgba(255,255,255,0.16)",
  };

  let collapsed = localStorage.getItem("octocode.audit.collapsed") === "1";
  let latestState = null;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === "style") Object.assign(node.style, value);
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value);
    });
    children.forEach((child) => node.append(child));
    return node;
  }

  function createPanel() {
    const panel = el("section", {
      id: "octocode-danger-console",
      style: {
        position: "fixed",
        right: "14px",
        bottom: "14px",
        width: "420px",
        maxWidth: "calc(100vw - 28px)",
        maxHeight: "48vh",
        overflow: "hidden",
        background: palette.bg,
        color: palette.fg,
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: "12px",
        border: `1px solid ${palette.border}`,
        borderRadius: "14px",
        boxShadow: "0 18px 54px rgba(0,0,0,0.32)",
        zIndex: "9999",
        backdropFilter: "blur(10px)",
      },
    });

    const header = el("button", {
      type: "button",
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        width: "100%",
        padding: "10px 12px",
        background: "transparent",
        color: palette.fg,
        border: "0",
        borderBottom: `1px solid ${palette.border}`,
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      },
    });

    const title = el("span", {}, [document.createTextNode("⚠ Danger Console")]);
    const status = el("span", { id: "danger-status" }, [document.createTextNode("loading")]);
    status.style.color = palette.warn;
    header.append(title, status);

    const body = el("div", {
      id: "danger-body",
      style: {
        display: collapsed ? "none" : "block",
        padding: "10px 12px 12px",
        maxHeight: "calc(48vh - 44px)",
        overflow: "auto",
      },
    });

    const summary = el("div", {
      id: "danger-summary",
      style: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "6px",
        marginBottom: "10px",
      },
    });

    const list = el("div", { id: "audit-list" });
    body.append(summary, list);
    panel.append(header, body);
    document.body.appendChild(panel);

    header.addEventListener("click", () => {
      collapsed = !collapsed;
      localStorage.setItem("octocode.audit.collapsed", collapsed ? "1" : "0");
      body.style.display = collapsed ? "none" : "block";
    });

    return { panel, status, summary, list };
  }

  function chip(label, value, tone = "muted") {
    const color = tone === "danger" ? palette.danger : tone === "ok" ? palette.ok : tone === "warn" ? palette.warn : palette.muted;
    return el("div", {
      style: {
        border: `1px solid ${palette.border}`,
        borderRadius: "10px",
        padding: "7px 8px",
        background: "rgba(255,255,255,0.04)",
      },
    }, [
      el("div", { style: { color: palette.muted, marginBottom: "2px" } }, [document.createTextNode(label)]),
      el("div", { style: { color, fontWeight: "700" } }, [document.createTextNode(value)]),
    ]);
  }

  async function loadState() {
    const res = await fetch(STATE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`state HTTP ${res.status}`);
    latestState = await res.json();
    return latestState;
  }

  async function loadAudit() {
    const res = await fetch(AUDIT_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`audit HTTP ${res.status}`);
    return res.json();
  }

  function renderSummary(summaryEl, statusEl, state, items) {
    const mode = state?.status?.permissionMode || state?.config?.permissionMode || "unknown";
    const activeProvider = state?.status?.activeProviderId || state?.status?.providerId || "unknown";
    const hasTokenHint = "OCTOCODE_TOKEN optional";
    const isDanger = String(mode).toLowerCase().includes("danger");
    statusEl.textContent = isDanger ? "DANGER-FULL-ACCESS" : mode;
    statusEl.style.color = isDanger ? palette.danger : palette.ok;

    summaryEl.replaceChildren(
      chip("permission", mode, isDanger ? "danger" : "ok"),
      chip("provider", activeProvider, "muted"),
      chip("recent danger", String(items.length), items.length ? "warn" : "ok"),
      chip("trust boundary", hasTokenHint, "muted"),
    );
  }

  function renderRows(listEl, items) {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el("div", { style: { color: palette.muted, padding: "8px 0" } }, [
        document.createTextNode("No high-permission actions recorded yet."),
      ]));
      return;
    }

    items.slice(0, MAX_ROWS).forEach((item) => {
      const isShell = String(item.kind || "").includes("shell");
      const row = el("article", {
        style: {
          borderTop: `1px solid ${palette.border}`,
          padding: "8px 0",
        },
      });
      row.append(
        el("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px" } }, [
          el("strong", { style: { color: isShell ? palette.danger : palette.warn } }, [document.createTextNode(item.kind || "audit")]),
          el("span", { style: { color: palette.muted } }, [document.createTextNode(formatTime(item.atMs))]),
        ]),
        el("pre", {
          style: {
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: "5px 0 0",
            color: palette.fg,
            fontFamily: "inherit",
          },
        }, [document.createTextNode(item.detail || "")]),
      );
      listEl.append(row);
    });
  }

  function formatTime(ms) {
    const value = Number(ms || 0);
    if (!value) return "-";
    return new Date(value).toLocaleTimeString();
  }

  async function refresh(view) {
    try {
      const [state, audit] = await Promise.all([loadState(), loadAudit()]);
      const items = audit.items || [];
      renderSummary(view.summary, view.status, state, items);
      renderRows(view.list, items);
    } catch (error) {
      view.status.textContent = "offline";
      view.status.style.color = palette.warn;
      view.list.replaceChildren(el("div", { style: { color: palette.warn, padding: "8px 0" } }, [
        document.createTextNode(`danger console unavailable: ${error.message}`),
      ]));
    }
  }

  window.addEventListener("load", () => {
    const view = createPanel();
    refresh(view);
    setInterval(() => refresh(view), 3000);
  });
})();
