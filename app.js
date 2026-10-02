import { api, el, fmtDate, fmtDay, fmtTime } from "/api.js";

const $ = (id) => document.getElementById(id);
const views = ["construction", "login", "chat"];
const POLL_MS = 2000;

let me = null;
let config = null;
let lastId = 0;
let epoch = null; // changes when messages vanish for everyone (admin delete, day ended at 00:00)
let lastDay = null; // day of the last rendered message, for the date separators
let pollTimer = null;
let online = [];

function show(view) {
  for (const v of views) $(`view-${v}`).hidden = v !== view;
}

// Same name always gets the same shade of green/cyan.
const PALETTE = ["#39ff88", "#7dffb2", "#b4ff39", "#39ffd5", "#9cff6b", "#5ce1ff", "#d4ff8a", "#00e676"];
function colorFor(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function whoSpan(name) {
  const node = el("span", { class: "who" }, name);
  node.style.color = colorFor(name);
  return node;
}

/* ---------- Output ---------- */
const output = () => $("output");

function atBottom() {
  const o = output();
  return o.scrollHeight - o.scrollTop - o.clientHeight < 40;
}

function append(node) {
  const stick = atBottom();
  output().append(node);
  if (stick) output().scrollTop = output().scrollHeight;
}

function info(text, cls = "info") {
  append(el("div", { class: `line ${cls}` }, text));
}

/* ---------- Messages ---------- */
function setStarUi(btn, on) {
  btn.classList.toggle("on", on);
  btn.textContent = on ? "★" : "☆";
  btn.title = on ? "remover dos salvos" : "salvar mensagem";
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", btn.title);
}

async function toggleStar(id, btn) {
  const on = !btn.classList.contains("on");
  try {
    await api(`/api/stars/${id}`, { method: on ? "PUT" : "DELETE" });
    setStarUi(btn, on);
  } catch (err) {
    info(`erro: ${err.message}`, "err");
    if (err.status === 401 || err.status === 503) kickToStart(err.message);
  }
}

function starButton(m) {
  const btn = el("button", { class: "star", type: "button" }, "☆");
  setStarUi(btn, Boolean(m.starred));
  btn.addEventListener("click", () => toggleStar(m.id, btn));
  return btn;
}

function separator(iso) {
  const day = new Date(iso).toDateString();
  if (day === lastDay) return;
  lastDay = day;
  append(el("div", { class: "line sep", "data-sep": "" }, `── ${fmtDay(iso)} ──`));
}

function renderMessage(m) {
  separator(m.createdAt);
  const time = el("span", { class: "time" }, `[${fmtTime(m.createdAt)}] `);
  if (m.kind === "system") {
    append(el("div", { class: "line sys", "data-mid": m.id }, time, `*** AVISO: ${m.body}`, starButton(m)));
    return;
  }
  const name = m.name ?? "desconhecido";
  const mine = me && name.toLowerCase() === me.name.toLowerCase();
  append(
    el(
      "div",
      { class: `line${mine ? " me" : ""}`, "data-mid": m.id },
      time,
      whoSpan(name),
      m.isAdmin ? el("span", { class: "badge" }, " [admin]") : null,
      el("span", { class: "muted" }, " > "),
      m.body,
      starButton(m),
    ),
  );
}

/* ---------- Polling ---------- */
async function poll() {
  clearTimeout(pollTimer);
  try {
    const query = new URLSearchParams({ after: lastId });
    if (epoch) query.set("epoch", epoch);
    const data = await api(`/api/messages?${query}`);
    if (data.reset) {
      // Something disappeared for everyone (or this is the first load): redraw the message list.
      output().querySelectorAll("[data-mid], [data-sep]").forEach((n) => n.remove());
      lastId = 0;
      lastDay = null;
    }
    epoch = data.epoch;
    for (const m of data.messages) {
      renderMessage(m);
      lastId = Math.max(lastId, m.id);
    }
    online = data.online;
    $("online-count").textContent = `${online.length} online`;
  } catch (err) {
    if (err.status === 401 || err.status === 503) return kickToStart(err.message);
  }
  pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me) poll();
});

/* ---------- Saved messages (★) ---------- */
const savedPanel = () => $("saved-panel");

function closeSaved() {
  savedPanel().hidden = true;
  $("chat-input").focus();
}

function renderSaved(list) {
  const box = $("saved-list");
  if (!list.length) {
    box.replaceChildren(el("p", { class: "muted" }, "nada salvo ainda. toque na ☆ ao lado de uma mensagem para guardá-la."));
    return;
  }
  box.replaceChildren(
    ...list.map((m) => {
      const row = el("div", { class: "saved-item" });
      const meta = el(
        "div",
        { class: "saved-meta muted" },
        `${fmtDate(m.createdAt)} `,
        m.kind === "system" ? el("span", { class: "warn" }, "AVISO") : whoSpan(m.name ?? "desconhecido"),
      );
      const remove = el("button", { class: "btn ghost small", type: "button" }, "remover");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api(`/api/stars/${m.id}`, { method: "DELETE" });
          row.remove();
          const chatStar = output().querySelector(`[data-mid="${m.id}"] .star`);
          if (chatStar) setStarUi(chatStar, false);
          if (!box.children.length) renderSaved([]);
        } catch (err) {
          remove.disabled = false;
          $("saved-hint").textContent = `erro: ${err.message}`;
        }
      });
      row.append(meta, el("div", { class: "saved-body" }, m.body), remove);
      return row;
    }),
  );
}

async function openSaved() {
  const days = config.retention?.userDays ?? 30;
  $("saved-hint").textContent = `Só você vê esta lista. As mensagens salvas continuam aqui depois de sumirem do chat (${days} dias).`;
  $("saved-list").replaceChildren(el("p", { class: "muted" }, "carregando..."));
  savedPanel().hidden = false;
  try {
    renderSaved((await api("/api/stars")).messages);
  } catch (err) {
    $("saved-list").replaceChildren(el("p", { class: "err" }, `erro: ${err.message}`));
    if (err.status === 401 || err.status === 503) kickToStart(err.message);
  }
}

/* ---------- Commands ---------- */
const COMMANDS = {
  ajuda() {
    info("comandos disponíveis:");
    info("  /ajuda              mostra esta lista");
    info("  /quem               lista quem está online");
    info("  /salvas             abre suas mensagens salvas (★)");
    info("  /senha atual nova   troca sua senha (sem espaços)");
    info("  /limpar             limpa a tela");
    info("  /sair [tudo]        encerra a sessão (tudo = em todos os aparelhos)");
    if (me?.isAdmin) info("  /admin              abre o painel de administração");
    const r = config.retention;
    if (r) info(`as mensagens somem após ${r.userDays} dias (avisos: ${r.systemDays}); cada dia termina às 00:00. use ☆ para guardar.`);
  },
  quem() {
    info(online.length ? `online agora (${online.length}): ${online.join(", ")}` : "ninguém online além de você.");
  },
  salvas() {
    openSaved();
  },
  async senha([current, next]) {
    if (!current || !next) return info("uso: /senha <senha atual> <nova senha> (sem espaços)", "err");
    try {
      await api("/api/password", { method: "POST", body: { current, next } });
      info("senha alterada. os outros aparelhos foram desconectados.", "glow");
    } catch (err) {
      info(`erro: ${err.message}`, "err");
    }
  },
  limpar() {
    output().replaceChildren();
    lastDay = null; // new messages start with a fresh date line
  },
  sair([scope]) {
    logout(scope === "tudo");
  },
  admin() {
    if (me?.isAdmin) location.href = "/admin";
    else info("comando restrito ao administrador.", "err");
  },
};
COMMANDS.help = COMMANDS.ajuda;
COMMANDS.who = COMMANDS.quem;
COMMANDS.saved = COMMANDS.salvas;
COMMANDS.password = COMMANDS.senha;
COMMANDS.clear = COMMANDS.limpar;
COMMANDS.exit = COMMANDS.sair;

async function onSubmitChat(e) {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  if (text.startsWith("/")) {
    const [rawCmd, ...args] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    // Never echo passwords back onto the screen.
    info(`$ ${cmd === "senha" || cmd === "password" ? "/senha ••••••" : text}`, "muted");
    await (COMMANDS[cmd] ?? (() => info(`comando não encontrado: /${cmd} — digite /ajuda`, "err")))(args);
    return;
  }

  try {
    await api("/api/messages", { method: "POST", body: { body: text } });
    poll();
  } catch (err) {
    info(`erro: ${err.message}`, "err");
    if (err.status === 401 || err.status === 503) kickToStart(err.message);
  }
}

/* ---------- Session flow ---------- */
function enterChat() {
  show("chat");
  document.title = config.title;
  $("chat-title").textContent = config.title;
  $("prompt-name").textContent = me.name;
  $("who-am-i").textContent = me.isAdmin ? `${me.name} [admin]` : me.name;
  output().replaceChildren();
  lastId = 0;
  lastDay = null;
  epoch = null;
  info(`${config.title} — sessão iniciada como ${me.name}`, "glow");
  if (config.construction && me.isAdmin) info("modo em construção ATIVO: só administradores veem o chat.", "warn");
  if (config.motd) info(config.motd);
  info("—".repeat(24));
  poll();
  $("chat-input").focus();
}

function showLogin(message = "") {
  show("login");
  document.title = config.title;
  $("login-title").textContent = config.title;
  $("login-msg").textContent = message;
  $("login-msg").className = `form-msg${message ? " err" : ""}`;
}

function showConstruction() {
  show("construction");
  document.title = config.title;
  $("construction-text").textContent = config.constructionText || "Em construção.";
}

function backToStart(message = "") {
  clearTimeout(pollTimer);
  me = null;
  savedPanel().hidden = true;
  if (config.construction) showConstruction();
  else showLogin(message);
}

const kickToStart = (message) => backToStart(message);

async function logout(all = false) {
  clearTimeout(pollTimer);
  await api("/api/logout", { method: "POST", body: { all } }).catch(() => {});
  backToStart();
}

async function onSubmitLogin(e) {
  e.preventDefault();
  const btn = e.submitter ?? e.target.querySelector("button");
  const msg = $("login-msg");
  btn.disabled = true;
  msg.className = "form-msg muted";
  msg.textContent = "autenticando...";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { name: $("login-name").value, password: $("login-pass").value },
    });
    me = data.user;
    $("login-pass").value = "";
    enterChat();
    if (data.created) info(`o nome "${me.name}" agora é seu. guarde a senha — ela é a única chave dele.`, "warn");
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = `erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  $("login-form").addEventListener("submit", onSubmitLogin);
  $("chat-form").addEventListener("submit", onSubmitChat);
  $("logout-btn").addEventListener("click", () => logout());
  $("saved-btn").addEventListener("click", openSaved);
  $("saved-close").addEventListener("click", closeSaved);
  savedPanel().addEventListener("click", (e) => {
    if (e.target === savedPanel()) closeSaved();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !savedPanel().hidden) closeSaved();
  });

  try {
    config = await api("/api/config");
  } catch {
    config = { construction: true, motd: "", constructionText: "Em construção." };
  }
  config.title ||= "TERMINAL//CHAT";
  document.title = config.title;

  // The login cookie, if any, is sent automatically: people stay signed in until they log out.
  try {
    me = (await api("/api/me")).user;
  } catch {
    me = null;
  }

  if (me && (!config.construction || me.isAdmin)) return enterChat();
  if (config.construction) return showConstruction();
  showLogin();
}

boot();
