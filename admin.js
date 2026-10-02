import { api, el, fmtDate } from "/api.js";

const $ = (id) => document.getElementById(id);
let me = null;
let retention = null;

function toast(text) {
  const t = el("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function run(action, okText) {
  try {
    await action();
    if (okText) toast(okText);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return showLogin(err.message);
    toast(`erro: ${err.message}`);
  }
}

function showOnly(view) {
  for (const v of ["setup", "login", "panel"]) $(`view-${v}`).hidden = v !== view;
}

function showLogin(message = "") {
  me = null;
  showOnly("login");
  $("login-msg").className = message ? "form-msg err" : "form-msg";
  $("login-msg").textContent = message;
}

function showSetup(configured) {
  showOnly("setup");
  $("setup-unconfigured").hidden = configured;
  $("setup-btn").disabled = !configured;
}

function renderConstruction(on) {
  $("construction-toggle").checked = on;
  $("construction-label").textContent = on ? "Em construção (ATIVO)" : "Chat aberto ao público";
  $("construction-hint").textContent = on
    ? "Visitantes veem só a página em construção. Administradores continuam acessando o chat."
    : "Qualquer pessoa pode escolher um nome e entrar no chat.";
}

async function loadSettings() {
  const s = await api("/api/admin/settings");
  renderConstruction(s.construction === "true");
  $("set-title").value = s.title;
  $("set-motd").value = s.motd;
  $("set-construction").value = s.constructionText;
}

async function loadStats() {
  const s = await api("/api/admin/stats");
  retention = s.retention;
  $("stat-users").textContent = s.users;
  $("stat-messages").textContent = s.messages;
  $("stat-stars").textContent = s.stars;
  const r = s.retention;
  $("retention-hint").textContent = `Mensagens somem após ${r.userDays} dias e avisos após ${r.systemDays}; cada dia termina às 00:00 (${r.timeZone}). Mensagens salvas com ★ ficam guardadas só para quem salvou.`;
  $("messages-hint").textContent = "Só aparecem as mensagens ainda ativas no chat. A coluna \"expira\" mostra quando cada uma sai.";
}

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  $("users-body").replaceChildren(
    ...users.map((u) => {
      const self = u.id === me.id;
      const patch = (body, ok) => run(async () => { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body }); await loadUsers(); }, ok);
      return el(
        "tr",
        {},
        el(
          "td",
          {},
          el("span", { class: u.banned ? "muted" : "glow" }, u.name),
          u.isAdmin ? el("span", { class: "tag warn" }, "admin") : null,
          u.banned ? el("span", { class: "tag err" }, "bloqueado") : null,
        ),
        el("td", { class: "muted" }, u.messageCount),
        el("td", { class: "muted" }, u.sessionCount),
        el("td", { class: "muted" }, fmtDate(u.lastSeenAt)),
        el(
          "td",
          { class: "actions-cell" },
          self
            ? el("span", { class: "muted" }, "você")
            : [
                el("button", { class: "btn ghost small", type: "button", onclick: () => patch({ isAdmin: !u.isAdmin }, "permissão atualizada") }, u.isAdmin ? "tirar admin" : "tornar admin"),
                u.sessionCount ? el("button", { class: "btn ghost small", type: "button", onclick: () => patch({ revokeSessions: true }, "sessões encerradas") }, "deslogar") : null,
                el("button", { class: "btn ghost small", type: "button", onclick: () => patch({ banned: !u.banned }, u.banned ? "nome desbloqueado" : "nome bloqueado") }, u.banned ? "desbloquear" : "bloquear"),
                el("button", {
                  class: "btn danger small",
                  type: "button",
                  onclick: () => {
                    if (!confirm(`Apagar "${u.name}"? O nome fica livre e as mensagens dele somem.`)) return;
                    run(async () => { await api(`/api/admin/users/${u.id}`, { method: "DELETE" }); await Promise.all([loadUsers(), loadMessages(), loadStats()]); }, "nome apagado");
                  },
                }, "apagar"),
              ],
        ),
      );
    }),
  );
}

async function loadMessages() {
  const { messages } = await api("/api/admin/messages");
  const list = $("messages-list");
  if (!messages.length) return list.replaceChildren(el("p", { class: "muted" }, "nenhuma mensagem ativa."));
  list.replaceChildren(
    ...messages.map((m) =>
      el(
        "div",
        { class: "msg-item" },
        el("span", { class: "muted" }, fmtDate(m.createdAt)),
        el("span", { class: m.kind === "system" ? "warn" : "glow" }, m.kind === "system" ? "AVISO" : m.name),
        el("span", { class: "text" }, m.body),
        el("span", { class: "muted msg-meta" }, m.stars ? `★${m.stars} ` : "", `expira ${fmtDate(m.expiresAt)}`),
        el("button", {
          class: "btn danger small",
          type: "button",
          onclick: () => run(async () => { await api(`/api/admin/messages/${m.id}`, { method: "DELETE" }); await Promise.all([loadMessages(), loadStats()]); }, "mensagem apagada"),
        }, "apagar"),
      ),
    ),
  );
}

const refreshAll = () => Promise.all([loadSettings(), loadStats(), loadUsers(), loadMessages()]);

/* ---------- Admin terminal ---------- */
const out = (text, cls = "") => {
  const box = $("console-out");
  box.append(el("div", { class: `line ${cls}` }, text));
  box.scrollTop = box.scrollHeight;
};

async function findUser(name) {
  const { users } = await api("/api/admin/users");
  const user = users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!user) throw new Error(`nome não encontrado: ${name}`);
  return user;
}

let pending = null; // a destructive command waiting for "sim"
const askConfirm = (text, action) => {
  pending = action;
  out(`${text} digite "sim" para confirmar.`, "warn");
};

const COMMANDS = {
  ajuda: {
    usage: "ajuda",
    desc: "mostra esta lista",
    run() {
      for (const c of Object.values(COMMANDS)) out(`  ${c.usage.padEnd(22)} ${c.desc}`, "muted");
    },
  },
  stats: {
    usage: "stats",
    desc: "nomes, mensagens ativas e salvas",
    async run() {
      const s = await api("/api/admin/stats");
      out(`${s.users} nomes, ${s.messages} mensagens ativas, ${s.stars} salvas.`);
    },
  },
  usuarios: {
    usage: "usuarios",
    desc: "lista os nomes registrados",
    async run() {
      const { users } = await api("/api/admin/users");
      for (const u of users) {
        const flags = [u.isAdmin ? "admin" : "", u.banned ? "bloqueado" : ""].filter(Boolean).join(",");
        out(`  ${u.name.padEnd(20)} ${flags.padEnd(10)} msgs:${u.messageCount} aparelhos:${u.sessionCount} visto:${fmtDate(u.lastSeenAt)}`, "muted");
      }
    },
  },
  aviso: {
    usage: "aviso <texto>",
    desc: "publica um aviso para todos",
    async run(arg) {
      if (!arg) throw new Error("uso: aviso <texto>");
      await api("/api/admin/messages", { method: "POST", body: { body: arg } });
      out("aviso publicado.", "glow");
    },
  },
  bloquear: {
    usage: "bloquear <nome>",
    desc: "bloqueia o nome e encerra as sessões",
    async run(arg) {
      const u = await findUser(arg);
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { banned: true } });
      out(`${u.name} bloqueado.`, "glow");
    },
  },
  desbloquear: {
    usage: "desbloquear <nome>",
    desc: "libera um nome bloqueado",
    async run(arg) {
      const u = await findUser(arg);
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { banned: false } });
      out(`${u.name} desbloqueado.`, "glow");
    },
  },
  promover: {
    usage: "promover <nome>",
    desc: "dá acesso de administrador",
    async run(arg) {
      const u = await findUser(arg);
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { isAdmin: true } });
      out(`${u.name} agora é administrador.`, "glow");
    },
  },
  rebaixar: {
    usage: "rebaixar <nome>",
    desc: "tira o acesso de administrador",
    async run(arg) {
      const u = await findUser(arg);
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { isAdmin: false } });
      out(`${u.name} não é mais administrador.`, "glow");
    },
  },
  deslogar: {
    usage: "deslogar <nome>",
    desc: "encerra as sessões do nome em todos os aparelhos",
    async run(arg) {
      const u = await findUser(arg);
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { revokeSessions: true } });
      out(`sessões de ${u.name} encerradas.`, "glow");
    },
  },
  apagar: {
    usage: "apagar <nome>",
    desc: "apaga o nome, as mensagens dele e libera o nome",
    async run(arg) {
      const u = await findUser(arg);
      askConfirm(`apagar "${u.name}" e as mensagens dele?`, async () => {
        await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
        out(`${u.name} apagado.`, "glow");
      });
    },
  },
  "limpar-chat": {
    usage: "limpar-chat",
    desc: "apaga todas as mensagens (inclusive as salvas)",
    run() {
      askConfirm("apagar TODAS as mensagens do chat?", async () => {
        await api("/api/admin/messages", { method: "DELETE" });
        out("chat limpo.", "glow");
      });
    },
  },
  limpeza: {
    usage: "limpeza",
    desc: "remove agora as mensagens vencidas que ninguém salvou",
    async run() {
      const r = await api("/api/admin/purge", { method: "POST" });
      out(`${r.messages} mensagem(ns) vencida(s) removida(s).`, "glow");
    },
  },
  construcao: {
    usage: "construcao on|off",
    desc: "liga ou desliga o modo em construção",
    async run(arg) {
      if (arg !== "on" && arg !== "off") throw new Error("uso: construcao on|off");
      await api("/api/admin/settings", { method: "PUT", body: { construction: arg === "on" } });
      out(arg === "on" ? "site em construção." : "chat aberto ao público.", "glow");
    },
  },
  limpar: {
    usage: "limpar",
    desc: "limpa a tela do terminal",
    run() {
      $("console-out").replaceChildren();
    },
  },
  sair: {
    usage: "sair",
    desc: "encerra a sessão do painel",
    async run() {
      await logout();
    },
  },
};

const history = [];
let historyAt = 0;

async function execute(line) {
  out(`$ ${line}`, "muted");

  if (pending) {
    const action = pending;
    pending = null;
    if (line.toLowerCase() !== "sim") return out("cancelado.", "muted");
    return action();
  }

  const [rawCmd, ...rest] = line.split(/\s+/);
  const command = COMMANDS[rawCmd.toLowerCase()];
  if (!command) return out(`comando não encontrado: ${rawCmd} — digite ajuda`, "err");
  return command.run(rest.join(" ").trim());
}

async function onConsoleSubmit(e) {
  e.preventDefault();
  const input = $("console-input");
  const line = input.value.trim();
  if (!line) return;
  input.value = "";
  history.push(line);
  historyAt = history.length;
  try {
    await execute(line);
    if (!pending && me) await refreshAll(); // keep the cards in sync with what the command changed
  } catch (err) {
    if (err.status === 401 || err.status === 403) return showLogin(err.message);
    out(`erro: ${err.message}`, "err");
  }
}

function onConsoleKey(e) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  historyAt = Math.min(Math.max(historyAt + (e.key === "ArrowUp" ? -1 : 1), 0), history.length);
  $("console-input").value = history[historyAt] ?? "";
}

/* ---------- Session ---------- */
async function enterPanel() {
  showOnly("panel");
  $("admin-name").textContent = `logado como ${me.name}`;
  $("console-user").textContent = me.name;
  if (!$("console-out").children.length) out("terminal do administrador — digite ajuda para ver os comandos.", "muted");
  await run(refreshAll);
}

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
}

async function onSetup(e) {
  e.preventDefault();
  const msg = $("setup-msg");
  if ($("setup-pass").value !== $("setup-pass2").value) {
    msg.className = "form-msg err";
    msg.textContent = "erro: as senhas não são iguais.";
    return;
  }
  msg.className = "form-msg muted";
  msg.textContent = "criando administrador...";
  try {
    const data = await api("/api/setup", {
      method: "POST",
      body: { setupKey: $("setup-key").value, name: $("setup-name").value, password: $("setup-pass").value },
    });
    me = data.user;
    for (const id of ["setup-key", "setup-pass", "setup-pass2"]) $(id).value = "";
    enterPanel();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = `erro: ${err.message}`;
  }
}

async function onLogin(e) {
  e.preventDefault();
  const msg = $("login-msg");
  msg.className = "form-msg muted";
  msg.textContent = "autenticando...";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { name: $("login-name").value, password: $("login-pass").value, adminOnly: true },
    });
    me = data.user;
    $("login-pass").value = "";
    enterPanel();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = `erro: ${err.message}`;
  }
}

async function boot() {
  $("setup-form").addEventListener("submit", onSetup);
  $("login-form").addEventListener("submit", onLogin);
  $("logout-btn").addEventListener("click", logout);
  $("console-form").addEventListener("submit", onConsoleSubmit);
  $("console-input").addEventListener("keydown", onConsoleKey);
  $("console-out").addEventListener("click", () => $("console-input").focus());

  $("construction-toggle").addEventListener("change", (e) =>
    run(async () => {
      const s = await api("/api/admin/settings", { method: "PUT", body: { construction: e.target.checked } });
      renderConstruction(s.construction === "true");
    }, e.target.checked ? "site em construção" : "chat aberto ao público"),
  );

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(() => api("/api/admin/settings", {
      method: "PUT",
      body: { title: $("set-title").value.trim(), motd: $("set-motd").value.trim(), constructionText: $("set-construction").value.trim() },
    }), "textos salvos");
  });

  $("announce-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      await api("/api/admin/messages", { method: "POST", body: { body: $("announce-body").value } });
      $("announce-body").value = "";
      await Promise.all([loadMessages(), loadStats()]);
    }, "aviso publicado");
  });

  $("clear-messages").addEventListener("click", () => {
    if (!confirm("Apagar TODAS as mensagens do chat?")) return;
    run(async () => { await api("/api/admin/messages", { method: "DELETE" }); await Promise.all([loadMessages(), loadStats()]); }, "chat limpo");
  });

  $("run-purge").addEventListener("click", () =>
    run(async () => {
      const r = await api("/api/admin/purge", { method: "POST" });
      await Promise.all([loadMessages(), loadStats()]);
      toast(`${r.messages} mensagem(ns) vencida(s) removida(s)`);
    }),
  );

  // Already signed in from an earlier visit? The cookie is sent automatically.
  try {
    me = (await api("/api/me")).user;
  } catch {
    me = null;
  }
  if (me?.isAdmin) return enterPanel();

  const status = await api("/api/setup").catch(() => ({ needsSetup: false }));
  if (status.needsSetup) return showSetup(status.configured);
  showLogin(me ? "este nome não tem acesso de administrador. entre com outro nome." : "");
}

boot();
