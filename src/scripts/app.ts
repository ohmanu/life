import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

type Day = { date: string; count: number; level: number };
type Repo = { name: string; pushed_at: string; private: boolean; language: string | null };
type GitHub = {
  login: string; name: string | null; total_year: number; last_90: number; streak: number; longest: number;
  days: Day[]; repos: Repo[]; open_prs: number; open_issues: number; synced_at: string;
};
type Status<T> = { connected: boolean; snapshot: T | null };
type Encargo = {
  id: string; uid: number; recibido: string; asunto: string; tipo: string; que: string; nombre: string; correo: string;
  telefono: string; empresa: string; fecha: string; lugar: string; web: string; presupuesto: string; idioma: string;
  mensaje: string; estado: string; respondido: string | null;
};
type Gmail = { connected: boolean; user: string | null; synced_at: string | null; encargos: Encargo[] };

const ESTADOS = ["nuevo", "respondido", "presupuesto", "confirmado", "cobrado", "descartado"] as const;
const COLUMNAS = ["nuevo", "respondido", "presupuesto", "confirmado", "cobrado"];
const NOMBRE_ESTADO: Record<string, string> = {
  nuevo: "Nuevo", respondido: "Respondido", presupuesto: "Presupuesto", confirmado: "Confirmado", cobrado: "Cobrado", descartado: "Descartado",
};
const LIMITE_H = 48;

const TAURI = "__TAURI_INTERNALS__" in window;
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const css = getComputedStyle(document.documentElement);
const C = (n: string) => css.getPropertyValue(n).trim();
const K = { bg: C("--bg"), bg2: C("--bg-2"), grid: C("--grid"), ph: C("--ph"), text: C("--text"), hi: C("--hi"), alert: C("--alert") };
const NS = "http://www.w3.org/2000/svg";
const MONO = "IBM Plex Mono, monospace";
const DIAS = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
const MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

const fmt = (n: number, d = 0) =>
  n.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: "always" } as Intl.NumberFormatOptions);
const pad = (n: number) => String(n).padStart(2, "0");
const daysAgo = (iso: string) => {
  const a = new Date(iso); const b = new Date();
  a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
};
const rel = (iso: string) => { const d = daysAgo(iso); return d <= 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} d`; };
/** Texto que viene de correos ajenos: siempre escapado antes de meterlo en el HTML. */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3600000;
const sinResponder = (e: Encargo) => e.estado === "nuevo" && !e.respondido;
const tarde = (e: Encargo) => sinResponder(e) && hoursSince(e.recibido) > LIMITE_H;
const abierto = (e: Encargo) => e.estado !== "cobrado" && e.estado !== "descartado";
const espera = (iso: string) => { const h = hoursSince(iso); return h < 1 ? "ahora" : h < 72 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} d`; };
const stamp = (iso: string) => { const d = new Date(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function svgEl(tag: string, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}
function label(parent: Element, x: number, y: number, s: string | number, a: Record<string, string | number> = {}) {
  const t = svgEl("text", { x, y, "font-size": 10, fill: K.grid, "font-family": MONO, ...a }, parent);
  t.textContent = String(s);
  return t;
}

/* ---------- reloj ---------- */
function tick() {
  const d = new Date();
  $("clock").textContent = `${DIAS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
tick();
setInterval(tick, 1000);

/* ---------- ventana ---------- */
if (TAURI) {
  const w = getCurrentWindow();
  $("w-min").addEventListener("click", () => w.minimize());
  $("w-max").addEventListener("click", () => w.toggleMaximize());
  $("w-close").addEventListener("click", () => w.close());
  $("app").addEventListener("dblclick", e => {
    if ((e.target as HTMLElement).closest("[data-tauri-drag-region]")) w.toggleMaximize();
  });
} else {
  $("demo").hidden = false;
}

/* ---------- cifras que cuentan ---------- */
function countUp(root: HTMLElement | null) {
  if (reduce || !root) return;
  root.querySelectorAll<HTMLElement>(".kpi .v").forEach(node => {
    const original = node.textContent ?? "";
    const m = original.match(/\d[\d.]*(,\d+)?/);
    if (!m) return;
    const raw = m[0];
    const dec = (raw.split(",")[1] || "").length;
    const target = parseFloat(raw.replace(/\./g, "").replace(",", "."));
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 950);
      const e = 1 - Math.pow(1 - p, 3);
      node.textContent = p < 1 ? original.replace(raw, fmt(target * e, dec)) : original;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* ---------- pestañas ---------- */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')];
function select(tab: HTMLButtonElement) {
  tabs.forEach(t => {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")!).hidden = !on;
  });
  countUp($(tab.getAttribute("aria-controls")!));
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => select(t));
  t.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    select(n); n.focus();
  });
});

/* ---------- privacidad y teclado ---------- */
const pb = $<HTMLButtonElement>("privacy");
function togglePrivacy() {
  const on = !$("app").classList.contains("private");
  $("app").classList.toggle("private", on);
  pb.setAttribute("aria-pressed", String(on));
  pb.textContent = on ? "Mostrar cifras" : "Ocultar cifras";
}
pb.addEventListener("click", togglePrivacy);
document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test((document.activeElement as HTMLElement)?.tagName ?? "");
  const f = tabs.find(t => t.dataset.key === e.key);
  if (f) { e.preventDefault(); select(f); return; }
  if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "p") togglePrivacy();
});
document.addEventListener("contextmenu", e => { if (TAURI && !(e.target as HTMLElement).closest("input")) e.preventDefault(); });

/* ---------- radar (sin datos hasta la fase 4) ---------- */
(function radar() {
  const svg = $("radar") as unknown as SVGSVGElement;
  const cx = 150, cy = 150, R = 105;
  const axes = ["TRABAJO", "DINERO", "CREACIÓN", "CUERPO", "GENTE", "DESCANSO"];
  const pt = (i: number, v: number) => { const a = -Math.PI / 2 + i * 2 * Math.PI / axes.length; return [cx + Math.cos(a) * R * v / 10, cy + Math.sin(a) * R * v / 10]; };
  const spin = svgEl("g", { class: "spin" }, svg);
  for (let d = 0; d < 360; d += 10) {
    const a = d * Math.PI / 180, r1 = R + 6, r2 = R + (d % 30 ? 9 : 13);
    svgEl("line", { x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1, x2: cx + Math.cos(a) * r2, y2: cy + Math.sin(a) * r2, stroke: K.grid, "stroke-width": 1 }, spin);
  }
  for (let k = 1; k <= 5; k++) svgEl("circle", { cx, cy, r: R * k / 5, fill: "none", stroke: K.grid, "stroke-width": k === 5 ? 1.2 : .7 }, svg);
  axes.forEach((a, i) => {
    const [x, y] = pt(i, 10);
    svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: K.grid, "stroke-width": .7 }, svg);
    const [lx, ly] = pt(i, 13.4);
    label(svg, lx, ly + 4, a, { "text-anchor": "middle", fill: K.text, "letter-spacing": 1 });
  });
  const sw = svgEl("g", { class: "sweep" }, svg);
  const ex = cx - R * Math.sin(Math.PI / 5), ey = cy - R * Math.cos(Math.PI / 5);
  svgEl("path", { d: `M${cx} ${cy}L${cx} ${cy - R}A${R} ${R} 0 0 0 ${ex} ${ey}Z`, fill: K.ph, opacity: .14 }, sw);
  svgEl("line", { x1: cx, y1: cy, x2: cx, y2: cy - R, stroke: K.ph, "stroke-width": 1.2, opacity: .85 }, sw);
  svgEl("circle", { cx, cy, r: 2.5, fill: K.ph }, svg);
  label(svg, cx, cy + 22, "SIN SEÑAL", { "text-anchor": "middle", fill: K.ph, class: "blink", "letter-spacing": 2 });
})();

/* ---------- GitHub: pintar ---------- */
function setText(key: string, value: string) {
  document.querySelectorAll<HTMLElement>(`[data-k="${key}"]`).forEach(n => (n.textContent = value));
}

function heat(days: Day[]) {
  const svg = $("heat") as unknown as SVGSVGElement;
  svg.replaceChildren();
  const s = 12, g = 2, x0 = 30, y0 = 18, op = [0, .25, .5, .75, 1];
  if (!days.length) { label(svg, x0, 60, "SIN DATOS · CONECTA GITHUB EN F5", { fill: K.grid }); return; }
  const first = new Date(days[0].date + "T00:00:00");
  const offset = first.getDay();
  let lastMonth = -1;
  ["LUN", "MIÉ", "VIE"].forEach((d, i) => label(svg, 0, y0 + (1 + i * 2) * (s + g) + 10, d, { "font-size": 8.5 }));
  days.forEach((d, idx) => {
    const n = idx + offset, w = Math.floor(n / 7), wd = n % 7;
    const date = new Date(d.date + "T00:00:00");
    if (wd === 0 || idx === 0) {
      const m = date.getMonth();
      if (m !== lastMonth && date.getDate() <= 7) { label(svg, x0 + w * (s + g), 11, MESES[m], { "font-size": 9.5 }); lastMonth = m; }
    }
    svgEl("rect", {
      x: x0 + w * (s + g), y: y0 + wd * (s + g), width: s, height: s,
      fill: d.level ? K.ph : K.bg2, "fill-opacity": d.level ? op[d.level] : 1, class: "pop", style: `--i:${w}`,
    }, svg).appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: `${d.date} · ${d.count}` }));
  });
  const n = days.length - 1 + offset;
  svgEl("rect", { x: x0 + Math.floor(n / 7) * (s + g) - 1.5, y: y0 + (n % 7) * (s + g) - 1.5, width: s + 3, height: s + 3, fill: "none", stroke: K.hi, "stroke-width": 1.5, class: "blink" }, svg);
}

let ghState: Status<GitHub> = { connected: false, snapshot: null };
let gmState: Gmail = { connected: false, user: null, synced_at: null, encargos: [] };
let selected: string | null = null;

function briefEncargos(lines: string[]) {
  const g = gmState;
  if (!g.connected && !g.encargos.length) {
    lines.push(`Gmail sin conectar. Ve a <b>F5 · Conexiones</b> para leer los encargos de la web.`);
    return;
  }
  const sin = g.encargos.filter(sinResponder).sort((a, b) => a.recibido.localeCompare(b.recibido));
  if (sin.length) {
    const viejo = sin[0];
    const late = tarde(viejo);
    lines.push(`<span class="${late ? "alarm" : "hot"}">${sin.length} encargo${sin.length === 1 ? "" : "s"} sin responder</span>. `
      + `<b>${esc(viejo.que || viejo.tipo)} · ${esc(viejo.nombre)}</b> lleva <span class="${late ? "alarm" : "hot"}">${espera(viejo.recibido)}</span> esperando.`);
  } else {
    lines.push(g.encargos.length ? "Todos los encargos tienen respuesta." : "Aún no ha llegado ningún encargo por la web.");
  }
  const now = new Date();
  const mes = g.encargos.filter(e => { const d = new Date(e.recibido); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const abiertos = g.encargos.filter(abierto).length;
  if (g.encargos.length) lines.push(`<b>${mes.length}</b> encargo${mes.length === 1 ? "" : "s"} este mes · <b>${abiertos}</b> abierto${abiertos === 1 ? "" : "s"} en el tablero.`);
}

function brief() {
  const gh = ghState.snapshot, connected = ghState.connected;
  const lines: string[] = [];
  briefEncargos(lines);
  if (gh) {
    const last = gh.repos[0];
    lines.push(`Racha en GitHub: <b>${gh.streak} ${gh.streak === 1 ? "día" : "días"}</b>.${last ? ` Último push en <b>${last.name}</b> ${rel(last.pushed_at)}.` : ""}`);
    lines.push(`<b>${fmt(gh.last_90)}</b> contribuciones en 90 días; <b>${fmt(gh.total_year)}</b> en el último año.`);
    lines.push(gh.open_prs || gh.open_issues
      ? `Tienes <span class="hot">${gh.open_prs} PR${gh.open_prs === 1 ? "" : "s"} y ${gh.open_issues} issue${gh.open_issues === 1 ? "" : "s"}</span> abiertos.`
      : "Sin PRs ni issues abiertos.");
    const dormant = gh.repos.filter(r => daysAgo(r.pushed_at) > 21).slice(0, 2);
    if (dormant.length) lines.push(dormant.map(r => `<b>${r.name}</b> lleva <span class="hot">${daysAgo(r.pushed_at)} días</span> sin tocarse`).join(" · ") + ".");
  } else {
    lines.push(connected ? "GitHub conectado. Sincronizando…" : `GitHub sin conectar. Ve a <b>F5 · Conexiones</b> y pega un token de solo lectura.`);
  }
  briefInstagram(lines);
  briefYouTube(lines);
  briefDinero(lines);
  const ul = $("brief");
  ul.innerHTML = lines.map((l, i) => `<li data-k="${pad(i + 1)}" style="--i:${i}"><span>${l}</span></li>`).join("");
  const last = [gh?.synced_at, gmState.synced_at].filter(Boolean).sort().pop();
  $("brief-time").textContent = last ? `ACTUALIZADO ${stamp(last)}` : "";
}

function render(st: Status<GitHub>) {
  ghState = st;
  const gh = st.snapshot;
  const src = $("src-github");
  src.className = "src" + (st.connected ? " on" : "");
  src.lastChild!.textContent = st.connected ? (gh ? `GitHub · ${gh.login}` : "GitHub") : "GitHub · sin conectar";
  setText("streak", gh ? `${gh.streak} ${gh.streak === 1 ? "día" : "días"}` : "—");
  setText("longest", gh ? `récord del año: ${gh.longest} días` : "");
  setText("last_90", gh ? fmt(gh.last_90) : "—");
  setText("total_year", gh ? `${fmt(gh.total_year)} en el último año` : "");
  setText("open_prs", gh ? String(gh.open_prs) : "—");
  setText("open_issues", gh ? String(gh.open_issues) : "—");
  setText("login", gh ? `de racha · @${gh.login}` : "");
  $("heat-sync").textContent = gh ? `SINCRONIZADO ${stamp(gh.synced_at)}` : "SIN SINCRONIZAR";
  heat(gh?.days ?? []);
  $("repos").innerHTML = gh
    ? gh.repos.map(r => `<div class="row"><span>${r.name}${r.private ? ' <span class="lang">privado</span>' : ""}${r.language ? `<span class="lang">${r.language}</span>` : ""}</span><span>${rel(r.pushed_at)}</span></div>`).join("")
    : `<div class="row"><span class="muted">Sin datos</span><span></span></div>`;
  brief();

  $("gh-state").textContent = st.connected ? `Conectado${gh ? ` · @${gh.login}` : ""}` : "Sin conectar";
  $("gh-state").className = "state" + (st.connected ? " on" : "");
  $("gh-form").hidden = st.connected;
  $("gh-help").hidden = st.connected;
  $("gh-sync").hidden = !st.connected;
  $("gh-off").hidden = !st.connected;
  const active = tabs.find(t => t.getAttribute("aria-selected") === "true");
  if (active) countUp($(active.getAttribute("aria-controls")!));
}

/* ---------- encargos: pintar ---------- */
function setE(key: string, value: string, alarm = false) {
  document.querySelectorAll<HTMLElement>(`[data-e="${key}"]`).forEach(n => { n.textContent = value; n.classList.toggle("alarm", alarm); });
}

function board(list: Encargo[]) {
  const el = $("board");
  if (!list.length) {
    el.innerHTML = gmState.connected
      ? `<div class="board-empty">Ningún encargo todavía. LIFE mira Gmail cada 10 minutos.</div>`
      : `<div class="board-empty">Conecta Gmail en <b>F5 · Conexiones</b> para traer las hojas de encargo de glutamatocult.com.</div>`;
    return;
  }
  el.innerHTML = COLUMNAS.map(col => {
    const items = list.filter(e => e.estado === col);
    const cards = items.map((e, i) => `
      <button type="button" class="card${tarde(e) ? " late" : ""}" data-id="${esc(e.id)}" aria-pressed="${e.id === selected}" style="--i:${i}">
        <span class="t">${esc(e.que || e.asunto)}</span>
        <span class="n">${esc(e.nombre)}</span>
        <span class="m"><span>${esc(e.tipo)}</span><span class="age">${col === "nuevo" ? espera(e.recibido) : rel(e.recibido)}</span></span>
      </button>`).join("");
    return `<div class="col"><div class="col-h"><span>${NOMBRE_ESTADO[col]}</span><b>${items.length}</b></div>
      <div class="col-list">${cards || `<div class="col-empty">—</div>`}</div></div>`;
  }).join("");
  const desc = list.filter(e => e.estado === "descartado").length;
  $("enc-foot").textContent = `GMAIL · SOLO LECTURA · CADA 10 MIN${desc ? ` · ${desc} DESCARTADO${desc === 1 ? "" : "S"}` : ""}`;
}

function ficha(e: Encargo | undefined) {
  const el = $("ficha");
  if (!e) { el.innerHTML = `<p class="muted">Elige un encargo del tablero para ver su hoja.</p>`; return; }
  const filas: [string, string, boolean?][] = [
    ["Recibido", `${stamp(e.recibido)} · ${rel(e.recibido)}`],
    ["Respondido", e.respondido
      ? `${stamp(e.respondido)} · ${Math.max(0, Math.round((new Date(e.respondido).getTime() - new Date(e.recibido).getTime()) / 3600000))} h después`
      : "aún no"],
    ["Correo", e.correo], ["Teléfono", e.telefono], ["Empresa o proyecto", e.empresa],
    [e.tipo === "Software" ? "Plazo" : "Fecha", e.fecha], ["Lugar", e.lugar], ["Web actual", e.web],
    ["Presupuesto", e.presupuesto, true], ["Idioma de la web", e.idioma],
  ];
  el.innerHTML = `
    <div class="head"><h4>${esc(e.tipo)} · ${esc(e.que)}</h4><span class="${tarde(e) ? "late blink" : "muted"}">${tarde(e) ? `${espera(e.recibido)} SIN RESPUESTA` : esc(NOMBRE_ESTADO[e.estado] ?? e.estado).toUpperCase()}</span></div>
    <div class="sub">${esc(e.nombre)}</div>
    <div class="rows">${filas.filter(([, v]) => v).map(([k, v, money]) => `<div class="row"><span>${k}</span><span${money ? ' class="money"' : ""}>${k === "Recibido" || k === "Respondido" ? v : esc(v)}</span></div>`).join("")}</div>
    ${e.mensaje ? `<div class="mensaje">${esc(e.mensaje)}</div>` : ""}
    <div class="estados" role="group" aria-label="Estado del encargo">
      ${ESTADOS.map(s => `<button type="button" class="btn" data-estado="${s}" aria-pressed="${s === e.estado}">${NOMBRE_ESTADO[s]}</button>`).join("")}
    </div>
    <div class="estados"><button type="button" class="btn" id="enc-open">Abrir en Gmail</button><span class="msg" id="enc-msg"></span></div>`;
}

function chart(list: Encargo[]) {
  const svg = $("enc-chart") as unknown as SVGSVGElement;
  svg.replaceChildren();
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 11 + i, 1));
  const counts = months.map(m => list.filter(e => { const d = new Date(e.recibido); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); }).length);
  const max = Math.max(1, ...counts);
  const x0 = 8, bw = 22, gap = 7, base = 140, H = 110;
  svgEl("line", { x1: x0, y1: base + .5, x2: x0 + 12 * (bw + gap), y2: base + .5, stroke: K.grid, "stroke-width": 1 }, svg);
  counts.forEach((c, i) => {
    const x = x0 + i * (bw + gap), h = c ? Math.max(3, (c / max) * H) : 0;
    if (h) svgEl("rect", { x, y: base - h, width: bw, height: h, fill: K.ph, "fill-opacity": i === 11 ? 1 : .55, class: "grow", style: `--i:${i}` }, svg);
    if (c) label(svg, x + bw / 2, base - h - 5, c, { "text-anchor": "middle", fill: K.hi, class: "fade" });
    label(svg, x + bw / 2, base + 16, MESES[months[i].getMonth()], { "text-anchor": "middle", "font-size": 9 });
  });
  const total = counts.reduce((a, b) => a + b, 0);
  $("enc-chart-tot").textContent = `${total} EN TOTAL`;
}

function renderGmail(g: Gmail) {
  gmState = g;
  const list = g.encargos;
  const now = new Date();
  const sin = list.filter(sinResponder), late = list.filter(tarde);
  const enMes = (e: Encargo, m: number, y: number) => { const d = new Date(e.recibido); return d.getMonth() === m && d.getFullYear() === y; };
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const mes = list.filter(e => enMes(e, now.getMonth(), now.getFullYear())).length;
  const mesAnt = list.filter(e => enMes(e, prev.getMonth(), prev.getFullYear())).length;
  const resp = list.filter(e => e.respondido && hoursSince(e.recibido) < 90 * 24)
    .map(e => (new Date(e.respondido!).getTime() - new Date(e.recibido).getTime()) / 3600000).filter(h => h >= 0);
  const cobrados = list.filter(e => e.estado === "cobrado" && new Date(e.recibido).getFullYear() === now.getFullYear()).length;
  const has = g.connected || list.length > 0;

  setE("sin", has ? String(sin.length) : "—", late.length > 0);
  setE("sin_d", !has ? "conecta Gmail en F5" : late.length ? `${late.length} pasa${late.length === 1 ? "" : "n"} de ${LIMITE_H} h` : sin.length ? `el más antiguo: ${espera(sin.sort((a, b) => a.recibido.localeCompare(b.recibido))[0].recibido)}` : "al día");
  setE("abiertos", has ? String(list.filter(abierto).length) : "—");
  setE("abiertos_d", has ? `de ${list.length} en total` : "");
  setE("mes", has ? String(mes) : "—");
  setE("mes_d", has ? `${mesAnt} el mes pasado` : "");
  setE("resp", resp.length ? `${fmt(resp.reduce((a, b) => a + b, 0) / resp.length, 1)} h` : "—");
  setE("cobrados", has ? String(cobrados) : "—");
  setE("cobrados_d", has ? `en ${now.getFullYear()}` : "");

  if (selected && !list.some(e => e.id === selected)) selected = null;
  if (!selected) selected = (sin[0] ?? list.find(abierto))?.id ?? null;
  board(list);
  ficha(list.find(e => e.id === selected));
  chart(list);
  $("enc-sync").textContent = g.synced_at ? `SINCRONIZADO ${stamp(g.synced_at)}` : g.connected ? "SINCRONIZANDO…" : "SIN CONECTAR";

  const src = $("src-gmail");
  src.className = "src" + (g.connected ? (late.length ? " err" : " on") : "");
  src.lastChild!.textContent = !g.connected ? "Gmail · sin conectar" : sin.length ? `Gmail · ${sin.length} sin responder` : "Gmail";
  $("gm-state").textContent = g.connected ? `Conectado · ${g.user ?? ""}` : "Sin conectar";
  $("gm-state").className = "state" + (g.connected ? " on" : "");
  $("gm-form").hidden = g.connected;
  $("gm-help").hidden = g.connected;
  $("gm-sync").hidden = !g.connected;
  $("gm-off").hidden = !g.connected;
  brief();
}

$("board").addEventListener("click", e => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".card");
  if (!card) return;
  selected = card.dataset.id ?? null;
  $("board").querySelectorAll(".card").forEach(c => c.setAttribute("aria-pressed", String(c === card)));
  ficha(gmState.encargos.find(x => x.id === selected));
});

$("ficha").addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  const id = selected;
  if (!id) return;
  const encMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = document.getElementById("enc-msg"); if (m) { m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); } };
  const estado = t.closest<HTMLElement>("[data-estado]")?.dataset.estado;
  if (estado) {
    if (!TAURI) { renderGmail({ ...gmState, encargos: gmState.encargos.map(x => x.id === id ? { ...x, estado } : x) }); return; }
    try { renderGmail(await invoke<Gmail>("encargo_estado", { id, estado })); }
    catch (err) { encMsg(String(err), "err"); }
    return;
  }
  if (t.id === "enc-open") {
    if (!TAURI) { encMsg("En modo demo no se abre Gmail.", "err"); return; }
    try { await invoke("encargo_abrir", { id }); }
    catch (err) { encMsg(String(err), "err"); }
  }
});

/* ---------- instagram ---------- */
type IgPost = {
  id: string; caption: string; media_type: string; product: string; timestamp: string; permalink: string;
  likes: number | null; comments: number | null; reach: number | null; views: number | null; saved: number | null; shares: number | null;
};
type IgDia = { fecha: string; valor: number };
type Instagram = {
  username: string; name: string | null; followers: number; follows: number; media_count: number; posts: IgPost[];
  reach: IgDia[]; reach_30: number | null; views_30: number | null; engaged_30: number | null; interactions_30: number | null;
  online: number[]; historia: IgDia[]; synced_at: string;
};
let igState: Status<Instagram> = { connected: false, snapshot: null };

const setI = (key: string, value: string) => document.querySelectorAll<HTMLElement>(`[data-i="${key}"]`).forEach(n => (n.textContent = value));
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : fmt(n));
const TIPO_IG: Record<string, string> = { REELS: "REEL", FEED: "POST", STORY: "STORY", AD: "ANUNCIO" };

/** Seguidores ganados en ~30 días según la historia que guarda LIFE. */
function igDelta(ig: Instagram) {
  const h = ig.historia;
  if (h.length < 2) return null;
  const limite = new Date(Date.now() - 30 * DIA);
  const ref = h.find(d => new Date(d.fecha + "T00:00:00") >= limite) ?? h[0];
  const dias = Math.max(1, Math.round((Date.now() - new Date(ref.fecha + "T00:00:00").getTime()) / DIA));
  return { delta: ig.followers - ref.valor, dias };
}

function igChart(ig: Instagram | null) {
  const svg = $("ig-chart") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!ig || !ig.reach.length) { label(svg, 10, 75, ig ? "SIN ESTADÍSTICAS DE ALCANCE TODAVÍA" : "SIN DATOS · CONECTA INSTAGRAM EN F5", { fill: K.grid }); return; }
  const l = 40, r = 552, top = 14, base = 122, n = ig.reach.length, gw = (r - l) / n, bw = Math.max(2, gw * .62);
  const max = Math.max(1, ...ig.reach.map(d => d.valor));
  for (let k = 0; k <= 2; k++) {
    const v = max * k / 2, y = base - v / max * (base - top);
    svgEl("line", { x1: l, y1: y, x2: r, y2: y, stroke: K.grid, "stroke-width": 1, "stroke-dasharray": k ? "2 4" : "" }, svg);
    label(svg, l - 6, y + 3, fmt(Math.round(v)), { "text-anchor": "end", "font-size": 9 });
  }
  ig.reach.forEach((d, i) => {
    const h = d.valor / max * (base - top), x = l + i * gw + (gw - bw) / 2;
    const rect = svgEl("rect", { x, y: base - h, width: bw, height: Math.max(h, d.valor ? 1 : 0), fill: K.ph, "fill-opacity": i === n - 1 ? 1 : .55, class: "grow", style: `--i:${i}` }, svg);
    rect.appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: `${d.fecha} · alcance ${fmt(d.valor)}` }));
    if ((i % 7 === 0 && n - 1 - i >= 4) || i === n - 1) label(svg, x + bw / 2, base + 14, ddmm(new Date(d.fecha + "T00:00:00")), { "text-anchor": "middle", "font-size": 9 });
  });
  // Seguidores (historia de LIFE) en su propia escala, solo dentro de la ventana del gráfico.
  const desde = ig.reach[0].fecha;
  const hist = ig.historia.filter(d => d.fecha >= desde);
  if (hist.length >= 2) {
    const mn = Math.min(...hist.map(d => d.valor)), mx = Math.max(...hist.map(d => d.valor));
    const X = (f: string) => l + (Math.max(0, Math.round((new Date(f + "T00:00:00").getTime() - new Date(desde + "T00:00:00").getTime()) / DIA)) + .5) * gw;
    const Y = (v: number) => base - 10 - (v - mn + 1) / (mx - mn + 2) * (base - top - 20);
    const pts = hist.map(d => `${X(d.fecha)},${Y(d.valor)}`).join(" ");
    svgEl("polyline", { points: pts, fill: "none", stroke: K.hi, "stroke-width": 1.6, pathLength: 1, class: "draw glow" }, svg);
  }
  label(svg, r, top - 2, "BARRAS: ALCANCE DIARIO · LÍNEA: SEGUIDORES", { "text-anchor": "end", "font-size": 8.5 });
}

function igHoras(ig: Instagram | null) {
  const el = $("ig-horas");
  if (!ig || !ig.online.length) { el.innerHTML = ig ? `<span class="lbl-h">Mejor hora</span><span style="grid-column: span 24; text-align:left">${ig.followers < 100 ? "Instagram la da con 100 seguidores o más." : "Meta no da ahora esta métrica para tu cuenta."}</span>` : ""; return; }
  const max = Math.max(...ig.online);
  const top = ig.online.indexOf(max);
  el.innerHTML = `<span class="lbl-h">Conectados</span>` + ig.online.map((v, h) => `<i class="${h === top ? "top" : ""}" style="height:${4 + v / max * 22}px" title="${pad(h)}:00 · ${fmt(v)}"></i>`).join("")
    + `<span class="lbl-h"></span>` + ig.online.map((_, h) => `<span>${h % 3 === 0 ? pad(h) : ""}</span>`).join("");
  el.setAttribute("aria-label", `Hora con más seguidores conectados: ${pad(top)}:00`);
}

function igPosts(ig: Instagram | null) {
  const el = $("ig-posts");
  const posts = ig?.posts ?? [];
  $("ig-posts-n").textContent = ig ? `${fmt(ig.media_count)} EN TOTAL` : "";
  if (!posts.length) { el.innerHTML = `<p class="muted">${ig ? "Sin publicaciones." : "Conecta Instagram en F5."}</p>`; return; }
  const best = (k: keyof IgPost) => Math.max(0, ...posts.map(p => (p[k] as number | null) ?? 0));
  const tops = { reach: best("reach"), views: best("views"), likes: best("likes") };
  const cell = (v: number | null, top?: number) => `<span class="n${top && v && v === top ? " best" : ""}">${num(v)}</span>`;
  el.innerHTML = `<div class="post head"><span>Fecha</span><span>Tipo</span><span>Texto</span><span class="n">Alcance</span><span class="n">Vistas</span><span class="n">Me gusta</span><span class="n">Coment.</span><span class="n">Guard.</span><span class="n">Compart.</span></div>`
    + posts.map(p => `<div class="post">
      <span class="muted">${ddmm(new Date(p.timestamp))}.${new Date(p.timestamp).getFullYear() % 100}</span>
      <span class="tp">${TIPO_IG[p.product] ?? esc(p.media_type)}</span>
      <a class="tx" href="#" data-url="${esc(p.permalink)}" title="${esc(p.caption || "Sin texto")}">${esc(p.caption || "Sin texto")}</a>
      ${cell(p.reach, tops.reach)}${cell(p.views, tops.views)}${cell(p.likes, tops.likes)}${cell(p.comments)}${cell(p.saved)}${cell(p.shares)}
    </div>`).join("");
}

function briefInstagram(lines: string[]) {
  const ig = igState.snapshot;
  if (!ig) { if (igState.connected) lines.push("Instagram conectado. Sincronizando…"); return; }
  const d = igDelta(ig);
  const ultimo = ig.posts.find(p => p.product !== "STORY");
  lines.push(`Instagram: <b>${fmt(ig.followers)}</b> seguidores${d && d.delta ? ` (<span class="hot">${d.delta > 0 ? "+" : ""}${fmt(d.delta)}</span> en ${d.dias} d)` : ""}`
    + (ig.reach_30 !== null ? ` · alcance de <b>${fmt(ig.reach_30)}</b> en 30 días` : "")
    + (ultimo ? `. Última publicación ${rel(ultimo.timestamp)}${ultimo.reach !== null ? `: alcance <b>${fmt(ultimo.reach)}</b>` : ""}.` : "."));
}

function renderInstagram(st: Status<Instagram>) {
  igState = st;
  const ig = st.snapshot;
  const d = ig ? igDelta(ig) : null;
  $("ig-h").textContent = ig ? `Instagram · @${ig.username}` : "Instagram";
  setI("seg", ig ? fmt(ig.followers) : "—");
  setI("seg_d", ig ? (d ? `${d.delta >= 0 ? "+" : ""}${fmt(d.delta)} en ${d.dias} d · sigues a ${fmt(ig.follows)}` : `sigues a ${fmt(ig.follows)} · historia desde hoy`) : st.connected ? "sincronizando…" : "conecta Instagram en F5");
  setI("reach", ig ? num(ig.reach_30) : "—");
  setI("reach_d", ig && ig.engaged_30 !== null ? `${fmt(ig.engaged_30)} cuentas interactuaron` : "");
  setI("views", ig ? num(ig.views_30) : "—");
  setI("views_d", ig ? `${fmt(ig.media_count)} publicaciones` : "");
  setI("inter", ig ? num(ig.interactions_30) : "—");
  const top = ig && ig.online.length ? ig.online.indexOf(Math.max(...ig.online)) : -1;
  setI("inter_d", top >= 0 ? `mejor hora: ${pad(top)}:00` : "");
  igChart(ig);
  igHoras(ig);
  igPosts(ig);
  $("ig-sync").textContent = ig ? `SINCRONIZADO ${stamp(ig.synced_at)}` : st.connected ? "SINCRONIZANDO…" : "SIN CONECTAR";

  const src = $("src-instagram");
  src.className = "src" + (st.connected ? " on" : "");
  src.lastChild!.textContent = st.connected ? (ig ? `Instagram · @${ig.username}` : "Instagram") : "Instagram · sin conectar";
  $("ig-state").textContent = st.connected ? `Conectado${ig ? ` · @${ig.username}` : ""}` : "Sin conectar";
  $("ig-state").className = "state" + (st.connected ? " on" : "");
  $("ig-form").hidden = st.connected;
  $("ig-help").hidden = st.connected;
  $("ig-sync-btn").hidden = !st.connected;
  $("ig-off").hidden = !st.connected;
  brief();
}

$("ig-posts").addEventListener("click", async e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-url]");
  if (!a) return;
  e.preventDefault();
  if (!TAURI) return;
  try { await invoke("instagram_abrir", { url: a.dataset.url }); } catch { /* enlace no válido: no se abre */ }
});

const igMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("ig-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };
$("ig-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!TAURI) { igMsg("En modo demo no se guarda nada.", "err"); return; }
  const input = $<HTMLInputElement>("ig-token"), btn = $<HTMLButtonElement>("ig-connect");
  btn.disabled = true; igMsg("Comprobando el token con Instagram y leyendo tus publicaciones…");
  try {
    const snap = await invoke<Instagram>("instagram_connect", { token: input.value });
    input.value = "";
    igMsg(`Conectado como @${snap.username}.`, "ok");
    renderInstagram({ connected: true, snapshot: snap });
  } catch (err) { igMsg(String(err), "err"); }
  finally { btn.disabled = false; }
});
$("ig-sync-btn").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("ig-sync-btn");
  btn.disabled = true; igMsg("Leyendo Instagram…");
  try { renderInstagram({ connected: true, snapshot: await invoke<Instagram>("instagram_sync") }); igMsg("Sincronizado.", "ok"); }
  catch (err) { igMsg(String(err), "err"); $("src-instagram").className = "src err"; }
  finally { btn.disabled = false; }
});
$("ig-off").addEventListener("click", async () => {
  try { await invoke("instagram_disconnect"); igMsg("Token borrado de las credenciales de Windows. El historial de seguidores se queda en life.db."); renderInstagram({ connected: false, snapshot: null }); }
  catch (err) { igMsg(String(err), "err"); }
});

function demoInstagram(): Status<Instagram> {
  let seed = 29;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dia = (i: number) => { const d = new Date(Date.now() - i * DIA); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const reach = Array.from({ length: 30 }, (_, i) => ({ fecha: dia(29 - i), valor: Math.round(180 + rnd() * 420 + (i > 24 ? 300 : 0)) }));
  const historia = Array.from({ length: 30 }, (_, i) => ({ fecha: dia(29 - i), valor: 1180 + Math.round(i * 1.4 + rnd() * 3) }));
  const textos = ["Retrato en luz de ventana", "Boda en Sintra · selección", "Carta nueva de Café Ámbar", "Detrás de cámaras", "Cerámica de Mar", "Paseo nocturno", "Prueba de color"];
  const posts = textos.map((t, i) => ({
    id: String(i), caption: t, media_type: i % 3 === 0 ? "VIDEO" : "IMAGE", product: i % 3 === 0 ? "REELS" : "FEED",
    timestamp: new Date(Date.now() - (i * 5 + 1) * DIA).toISOString(), permalink: "https://www.instagram.com/",
    likes: Math.round(40 + rnd() * 160), comments: Math.round(rnd() * 20), reach: Math.round(300 + rnd() * 1500),
    views: Math.round(500 + rnd() * 4000), saved: Math.round(rnd() * 30), shares: Math.round(rnd() * 15),
  }));
  const online = Array.from({ length: 24 }, (_, h) => Math.round(30 + 200 * Math.exp(-((h - 21) ** 2) / 12) + 60 * Math.exp(-((h - 14) ** 2) / 8)));
  return {
    connected: true,
    snapshot: {
      username: "ejemplo", name: "Ejemplo", followers: 1222, follows: 310, media_count: 214, posts, reach,
      reach_30: 9840, views_30: 31200, engaged_30: 612, interactions_30: 1890, online, historia, synced_at: new Date().toISOString(),
    },
  };
}

/* ---------- youtube ---------- */
type YtVideo = {
  id: string; title: string; published: string; duration: string; views: number | null; likes: number | null; comments: number | null;
  views_28: number | null; minutes_28: number | null; retention_28: number | null;
};
type YtDia = { fecha: string; views: number; minutes: number; subs: number };
type YouTube = {
  channel: string; subscribers: number | null; total_views: number; video_count: number; videos: YtVideo[]; dias: YtDia[];
  views_28: number | null; minutes_28: number | null; avg_duration_28: number | null; retention_28: number | null;
  subs_ganados_28: number | null; subs_perdidos_28: number | null; trafico: [string, number][]; synced_at: string;
};
type YtView = { configurado: boolean; connected: boolean; snapshot: YouTube | null };
let ytState: YtView = { configurado: false, connected: false, snapshot: null };

const setY = (key: string, value: string) => document.querySelectorAll<HTMLElement>(`[data-y="${key}"]`).forEach(n => (n.textContent = value));
const TRAFICO: Record<string, string> = {
  YT_SEARCH: "Búsqueda de YouTube", SUGGESTED_VIDEO: "Vídeos sugeridos", BROWSE: "Inicio y suscripciones", EXT_URL: "Webs externas",
  SHORTS: "Shorts", PLAYLIST: "Listas", NO_LINK_OTHER: "Directo o desconocido", YT_CHANNEL: "Tu canal", NOTIFICATION: "Notificaciones",
  YT_OTHER_PAGE: "Otras páginas de YouTube", END_SCREEN: "Pantallas finales", SUBSCRIBER: "Suscriptores", RELATED_VIDEO: "Vídeos relacionados",
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;

function ytChart(yt: YouTube | null) {
  const svg = $("yt-chart") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!yt || !yt.dias.length) { label(svg, 0, 40, yt ? "SIN DATOS DE ANALYTICS TODAVÍA" : "SIN DATOS · CONECTA YOUTUBE EN F5", { fill: K.grid, "font-size": 9 }); return; }
  const n = yt.dias.length, max = Math.max(1, ...yt.dias.map(d => d.views));
  const X = (i: number) => 2 + i * (296 / Math.max(1, n - 1)), Y = (v: number) => 60 - v / max * 52;
  for (let k = 0; k < 3; k++) svgEl("line", { x1: 0, y1: 8 + k * 26, x2: 300, y2: 8 + k * 26, stroke: K.grid, "stroke-width": 1, "stroke-dasharray": "2 4" }, svg);
  const d = yt.dias.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.views).toFixed(1)}`).join("");
  svgEl("path", { d: d + `L${X(n - 1)} 60L${X(0)} 60Z`, fill: K.ph, "fill-opacity": .12, class: "fade" }, svg);
  svgEl("path", { d, fill: "none", stroke: K.ph, "stroke-width": 1.5, pathLength: 1, class: "draw glow" }, svg);
  const ex = X(n - 1), ey = Y(yt.dias[n - 1].views);
  svgEl("rect", { x: ex - 3, y: ey - 3, width: 6, height: 6, fill: "none", stroke: K.hi, class: "ping" }, svg);
  svgEl("rect", { x: ex - 3, y: ey - 3, width: 6, height: 6, fill: K.hi, class: "fade" }, svg);
  label(svg, 0, 69, ddmm(new Date(yt.dias[0].fecha + "T00:00:00")), { "font-size": 8.5 });
  label(svg, 300, 69, ddmm(new Date(yt.dias[n - 1].fecha + "T00:00:00")), { "font-size": 8.5, "text-anchor": "end" });
}

function renderYouTube(v: YtView) {
  ytState = v;
  const yt = v.snapshot;
  $("yt-h").textContent = yt ? `YouTube · ${yt.channel}` : "YouTube";
  const neto = yt && yt.subs_ganados_28 !== null ? yt.subs_ganados_28 - (yt.subs_perdidos_28 ?? 0) : null;
  setY("subs", yt ? (yt.subscribers === null ? "oculto" : fmt(yt.subscribers)) : "—");
  setY("subs_d", yt ? (neto !== null ? `${neto >= 0 ? "+" : ""}${fmt(neto)} en 28 d` : `${fmt(yt.video_count)} vídeos`) : v.connected ? "sincronizando…" : "conecta YouTube en F5");
  setY("views", yt ? num(yt.views_28) : "—");
  setY("views_d", yt ? `${fmt(yt.total_views)} en total` : "");
  setY("horas", yt && yt.minutes_28 !== null ? fmt(yt.minutes_28 / 60, yt.minutes_28 < 600 ? 1 : 0) : "—");
  setY("horas_d", yt && yt.avg_duration_28 !== null ? `${mmss(yt.avg_duration_28)} de media por vista` : "");
  setY("ret", yt && yt.retention_28 !== null ? `${fmt(yt.retention_28, 0)} %` : "—");
  setY("ret_d", yt ? "del vídeo, de media" : "");
  ytChart(yt);
  const vids = (yt?.videos ?? []).slice().sort((a, b) => (b.views_28 ?? -1) - (a.views_28 ?? -1) || b.published.localeCompare(a.published)).slice(0, 5);
  $("yt-videos").innerHTML = vids.length
    ? vids.map(x => `<div class="row"><span><a href="#" data-yt="${esc(x.id)}" title="${esc(x.title)}">${esc(x.title)}</a></span><span>${x.views_28 !== null ? `${fmt(x.views_28)} · 28 d` : `${num(x.views)} vistas`}${x.retention_28 !== null ? ` · ${fmt(x.retention_28, 0)} %` : ""}</span></div>`).join("")
    : `<div class="row"><span class="muted">${yt ? "Sin vídeos." : "Sin datos"}</span><span></span></div>`;
  const tot = (yt?.trafico ?? []).reduce((s, t) => s + t[1], 0);
  $("yt-trafico").innerHTML = yt && tot
    ? `<div class="row"><span class="muted">DE DÓNDE VIENEN · 28 D</span><span></span></div>` + yt.trafico.slice(0, 4).map(([k, n]) => `<div class="row"><span>${esc(TRAFICO[k] ?? k)}</span><span>${fmt(n / tot * 100)} %</span></div>`).join("")
    : "";
  $("yt-sync").textContent = yt ? `SINCRONIZADO ${stamp(yt.synced_at)}` : v.connected ? "SINCRONIZANDO…" : "SIN CONECTAR";

  const src = $("src-youtube");
  src.className = "src" + (v.connected ? " on" : "");
  src.lastChild!.textContent = v.connected ? (yt ? `YouTube · ${yt.channel}` : "YouTube") : "YouTube · sin conectar";
  $("yt-state").textContent = v.connected ? `Conectado${yt ? ` · ${yt.channel}` : ""}` : v.configurado ? "Cliente guardado" : "Sin conectar";
  $("yt-state").className = "state" + (v.connected ? " on" : "");
  $("yt-help").hidden = v.configurado;
  $("yt-form").hidden = v.configurado;
  $("yt-actions").hidden = !v.configurado;
  $("yt-connect").textContent = v.connected ? "Volver a autorizar" : "Conectar con YouTube";
  $("yt-sync-btn").hidden = !v.connected;
  $("yt-off").textContent = v.connected ? "Desconectar" : "Olvidar cliente";
  brief();
}

function briefYouTube(lines: string[]) {
  const yt = ytState.snapshot;
  if (!yt) { if (ytState.connected) lines.push("YouTube conectado. Sincronizando…"); return; }
  const neto = yt.subs_ganados_28 !== null ? yt.subs_ganados_28 - (yt.subs_perdidos_28 ?? 0) : null;
  lines.push(`YouTube: <b>${yt.subscribers === null ? "suscriptores ocultos" : `${fmt(yt.subscribers)} suscriptores`}</b>${neto ? ` (<span class="hot">${neto > 0 ? "+" : ""}${fmt(neto)}</span> en 28 d)` : ""}`
    + (yt.views_28 !== null ? ` · <b>${fmt(yt.views_28)}</b> vistas y <b>${fmt((yt.minutes_28 ?? 0) / 60)}</b> h vistas en 28 días.` : "."));
}

$("yt-videos").addEventListener("click", async e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-yt]");
  if (!a) return;
  e.preventDefault();
  if (TAURI) try { await invoke("youtube_abrir", { id: a.dataset.yt }); } catch { /* no se abre */ }
});

const ytMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("yt-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };
async function ytAccion(btn: HTMLButtonElement, aviso: string, fn: () => Promise<YtView>, ok: (v: YtView) => string) {
  if (!TAURI) { ytMsg("En modo demo no se conecta nada: abre LIFE como app.", "err"); return; }
  btn.disabled = true; ytMsg(aviso);
  try { const v = await fn(); renderYouTube(v); ytMsg(ok(v), "ok"); }
  catch (err) { ytMsg(String(err), "err"); }
  finally { btn.disabled = false; }
}
$("yt-form").addEventListener("submit", e => {
  e.preventDefault();
  const id = $<HTMLInputElement>("yt-id"), secret = $<HTMLInputElement>("yt-secret");
  ytAccion($<HTMLButtonElement>("yt-save"), "Guardando…", () => invoke<YtView>("youtube_configurar", { clientId: id.value, secret: secret.value }),
    () => { id.value = ""; secret.value = ""; return "Cliente guardado en las credenciales de Windows. Ahora pulsa Conectar con YouTube."; });
});
$("yt-connect").addEventListener("click", () =>
  ytAccion($<HTMLButtonElement>("yt-connect"), "Da permiso en el navegador que se ha abierto (Google avisará de que la app no está verificada: es la tuya)…",
    () => invoke<YtView>("youtube_conectar"), v => `Conectado${v.snapshot ? ` · ${v.snapshot.channel}` : ""}.`));
$("yt-sync-btn").addEventListener("click", () =>
  ytAccion($<HTMLButtonElement>("yt-sync-btn"), "Leyendo YouTube…", () => invoke<YtView>("youtube_sync"), () => "Sincronizado."));
$("yt-off").addEventListener("click", () => {
  const todo = !ytState.connected;
  ytAccion($<HTMLButtonElement>("yt-off"), "", () => invoke<YtView>("youtube_disconnect", { todo }),
    () => todo ? "ID y secreto del cliente borrados." : "Permiso quitado de LIFE. Para revocarlo también en Google: myaccount.google.com/permissions.");
});

function demoYouTube(): YtView {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dia = (i: number) => { const d = new Date(Date.now() - i * DIA); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dias = Array.from({ length: 28 }, (_, i) => ({ fecha: dia(28 - i), views: Math.round(40 + rnd() * 80 + (i > 20 ? 90 : 0)), minutes: Math.round(100 + rnd() * 200), subs: Math.round(rnd() * 3) }));
  const titulos = ["Cómo ilumino un retrato con una ventana", "Boda en Sintra · película", "Mi equipo de foto en 2026", "Editar en Lightroom en 10 minutos", "Producto con luz continua"];
  const videos = titulos.map((t, i) => ({ id: `demo${i}`, title: t, published: new Date(Date.now() - (i * 20 + 3) * DIA).toISOString(), duration: "PT8M", views: Math.round(300 + rnd() * 3000), likes: 20, comments: 4, views_28: Math.round(30 + rnd() * 900), minutes_28: 400, retention_28: 30 + rnd() * 30 }));
  return {
    configurado: true, connected: true,
    snapshot: {
      channel: "Ejemplo", subscribers: 1204, total_views: 98400, video_count: 37, videos, dias, views_28: 3120, minutes_28: 9050,
      avg_duration_28: 174, retention_28: 41.5, subs_ganados_28: 38, subs_perdidos_28: 7,
      trafico: [["YT_SEARCH", 1300], ["SUGGESTED_VIDEO", 900], ["BROWSE", 500], ["EXT_URL", 420]], synced_at: new Date().toISOString(),
    },
  };
}

/* ---------- dinero ---------- */
const CATS = ["Ingresos", "Casa y facturas", "Súper", "Restaurantes", "Transporte", "Suscripciones", "Compras", "Equipo",
  "Ocio", "Salud", "Viajes", "Impuestos", "Comisiones", "Efectivo", "Transferencias", "Otros", "Interno"] as const;
/** Reglas automáticas por descripción. Lo que corriges a mano manda sobre ellas. */
const REGLAS: [string, RegExp][] = [
  ["Casa y facturas", /alquiler|\brent\b|iberdrola|endesa|naturgy|holaluz|octopus|canal de isabel|aguas? de|comunidad de prop|vodafone|orange|yoigo|masmovil|pepephone|lowi|simyo|digi\b|o2\b|seguro hogar/],
  ["Súper", /mercadona|carrefour|lidl|aldi|\bdia\b|eroski|alcampo|consum|hipercor|ahorramas|bonpreu|caprabo|condis|spar\b|supermercado|froiz|gadis|bm\b/],
  ["Restaurantes", /restaurante|\bbar\b|caf[eé]|cafeter|burger|mcdonald|kfc|telepizza|domino|just ?eat|glovo|deliveroo|uber ?eats|starbucks|tapas|pizzer|cervecer|taberna|bodega|sushi/],
  ["Transporte", /\buber\b|cabify|bolt|renfe|metro|\bemt\b|\btmb\b|taxi|repsol|cepsa|\bbp\b|galp|shell|gasolin|parking|aparcamiento|bicing|free ?now|blablacar|ouigo|iryo|alsa|peaje|autopista/],
  ["Viajes", /ryanair|vueling|iberia|easyjet|booking|airbnb|hotel|expedia|aena|trainline|hostel/],
  ["Suscripciones", /netflix|spotify|hbo|\bmax\b|disney|prime video|amazon prime|apple\.com|itunes|icloud|google (one|storage|play)|youtube|adobe|github|openai|anthropic|claude|chatgpt|filmin|dazn|notion|figma|dropbox|microsoft|xbox|playstation|patreon|midjourney|canva/],
  ["Equipo", /fotocasion|fotoprix|fujifilm|canon|nikon|sony|leica|bhphoto|b&h|adorama|calumet|apple store|pccomponentes|mediamarkt|coolmod/],
  ["Compras", /amazon|aliexpress|zara|h&m|ikea|decathlon|corte ingl|primark|fnac|shein|wallapop|vinted|uniqlo|leroy/],
  ["Salud", /farmacia|cl[ií]nica|dental|dentist|hospital|[oó]ptica|sanitas|adeslas|fisio|gimnasio|\bgym\b|basic-?fit|holmes|anytime/],
  ["Ocio", /cine|yelmo|cinesa|teatro|concierto|ticketmaster|entradas|steam|museo|librer|casa del libro|escape/],
  ["Impuestos", /agencia tributaria|aeat|hacienda|seguridad social|tgss|ayuntamiento|\bdgt\b|impuesto|tasa municipal/],
  ["Comisiones", /\bfee\b|comisi[oó]n|plan (premium|metal|plus)|revolut (premium|metal|plus)/],
];

type Mov = {
  id: string; fecha: string; completada: string | null; tipo: string; producto: string; descripcion: string; comercio: string;
  importe: number; comision: number; divisa: string; estado: string; saldo: number | null; interno: boolean; fuente: string;
};
type Banco = {
  configurado: boolean; conectado: boolean; app_id: string | null; valido_hasta: string | null;
  sincronizado: string | null; cuentas: number; error: string | null;
};
type Patrimonio = {
  oro_onzas: number | null; oro_coste: number | null; oro_valor_resumen: number | null; oro_fecha: string | null;
  oro_precio: number | null; oro_precio_fecha: string | null; hucha_saldo: number | null; hucha_fecha: string | null;
  hucha_tin: number | null;
};
const SIN_PATRIMONIO: Patrimonio = { oro_onzas: null, oro_coste: null, oro_valor_resumen: null, oro_fecha: null, oro_precio: null, oro_precio_fecha: null, hucha_saldo: null, hucha_fecha: null, hucha_tin: null };
type Dinero = { movimientos: Mov[]; categorias: Record<string, string>; importado: string | null; archivo: string | null; banco: Banco; patrimonio: Patrimonio };
const SIN_BANCO: Banco = { configurado: false, conectado: false, app_id: null, valido_hasta: null, sincronizado: null, cuentas: 0, error: null };
type Importe = { nuevos: number; solapados: number; actualizados: number; ignorados: number; leidos: number; vista: Dinero };
type Sub = { comercio: string; nombre: string; cada: "semanal" | "mensual" | "anual"; dias: number; importe: number; mensual: number; ultimo: Date; proximo: Date; sube: number; desde: string };

let rvState: Dinero = { movimientos: [], categorias: {}, importado: null, archivo: null, banco: SIN_BANCO, patrimonio: SIN_PATRIMONIO };
let mesSel: string | null = null;  // AAAA-MM
let subsCache: Sub[] = [];

const eur = (n: number, d = 0) => `${fmt(n, d)} €`;
const mesKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const mesDe = (k: string) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1);
const mesNombre = (k: string, largo = false) => {
  const d = mesDe(k);
  return largo ? d.toLocaleDateString("es-ES", { month: "long", year: "numeric" }) : `${MESES[d.getMonth()]} ${d.getFullYear()}`;
};
const fechaDe = (f: string) => new Date(f.replace(" ", "T"));
const ddmm = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const DIA = 86400000;

function autoCat(m: Mov): string {
  if (m.interno) return "Interno";
  if (m.tipo === "cajero") return "Efectivo";
  if (m.tipo === "comision") return "Comisiones";
  if (m.importe > 0 && m.tipo !== "reembolso") return "Ingresos";
  const d = m.descripcion.toLowerCase();
  for (const [cat, re] of REGLAS) if (re.test(d)) return cat;
  if (m.tipo === "transferencia") return "Transferencias";
  return "Otros";
}
function catOf(m: Mov): string {
  const manual = rvState.categorias[m.comercio];
  if (manual) return manual;
  const a = autoCat(m);
  return a === "Otros" && subsCache.some(s => s.comercio === m.comercio) ? "Suscripciones" : a;
}
/** Solo euros y nada interno: lo que cuenta para ingresos y gastos. */
const cuenta = (m: Mov) => m.divisa === "EUR" && catOf(m) !== "Interno";

function mediana(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

/** Gasto del día a día: se repite, pero no es una suscripción. */
const NO_RECURRENTE = new Set(["Súper", "Restaurantes", "Transporte", "Efectivo", "Compras", "Interno"]);
/** Cargos que se repiten por comercio con intervalo y importe estables. */
function detectarSubs(list: Mov[]): Sub[] {
  const por = new Map<string, Mov[]>();
  for (const m of list) {
    if (m.divisa !== "EUR" || m.importe >= 0 || m.interno || NO_RECURRENTE.has(autoCat(m))) continue;
    (por.get(m.comercio) ?? por.set(m.comercio, []).get(m.comercio)!).push(m);
  }
  const out: Sub[] = [];
  const hoy = Date.now();
  for (const [comercio, ms] of por) {
    if (ms.length < 2) continue;
    ms.sort((a, b) => a.fecha.localeCompare(b.fecha));
    const t = ms.map(m => fechaDe(m.fecha).getTime());
    const gaps = t.slice(1).map((x, i) => (x - t[i]) / DIA);
    const g = mediana(gaps);
    const tipo = g >= 6 && g <= 8 ? "semanal" : g >= 26 && g <= 35 ? "mensual" : g >= 350 && g <= 380 ? "anual" : null;
    if (!tipo) continue;
    const minimo = tipo === "semanal" ? 4 : tipo === "mensual" ? 3 : 2;
    if (ms.length < minimo) continue;
    const tol = tipo === "semanal" ? 2 : tipo === "mensual" ? 6 : 20;
    if (gaps.filter(x => Math.abs(x - g) <= tol).length / gaps.length < .7) continue;
    const amts = ms.map(m => -m.importe);
    const med = mediana(amts.slice(-4));
    if (amts.slice(-3).some(a => Math.abs(a - med) / med > .3)) continue;
    const ultimo = new Date(t[t.length - 1]);
    if ((hoy - ultimo.getTime()) / DIA > g * 1.5 + 5) continue;  // ya no se cobra
    const last = amts[amts.length - 1];
    // Subida de precio en los últimos 90 días, solo si antes era un importe fijo
    // (las facturas variables no avisan).
    let k = amts.length - 1;
    while (k > 0 && Math.abs(amts[k - 1] - last) < .01) k--;
    const prev = k > 0 ? amts[k - 1] : last;
    const antes = amts.slice(Math.max(0, k - 3), k);
    const fijo = antes.length >= 2 && antes.every(a => Math.abs(a - prev) < .01);
    const reciente = k > 0 && (hoy - t[k]) / DIA <= 90;
    const sube = fijo && reciente && last - prev >= .5 && last > prev * 1.01 ? last - prev : 0;
    const cambio = new Date(t[k]);
    out.push({
      comercio, nombre: ms[ms.length - 1].descripcion, cada: tipo, dias: g, importe: last,
      mensual: tipo === "semanal" ? last * 52 / 12 : tipo === "anual" ? last / 12 : last,
      ultimo, proximo: new Date(ultimo.getTime() + Math.round(g) * DIA), sube,
      desde: sube ? MESES[cambio.getMonth()] : "",
    });
  }
  return out.sort((a, b) => b.mensual - a.mensual);
}

type Mes = { ing: number; gas: number; cats: Map<string, number> };
function porMes(list: Mov[]) {
  const map = new Map<string, Mes>();
  for (const m of list) {
    if (!cuenta(m)) continue;
    const k = m.fecha.slice(0, 7);
    const r = map.get(k) ?? map.set(k, { ing: 0, gas: 0, cats: new Map() }).get(k)!;
    const c = catOf(m);
    if (c === "Ingresos") r.ing += m.importe;
    else {
      const g = -m.importe + m.comision;
      r.gas += g;
      r.cats.set(c, (r.cats.get(c) ?? 0) + g);
    }
  }
  return map;
}

/** Último saldo de cada producto en euros. */
/** ¿Es un traspaso entre la cuenta y la hucha? Por el nombre de la hucha (de los intereses del
 *  resumen) o por las palabras que usa Revolut («Cuenta con mejora activada», «Savings Vault»…). */
function esHuchaDe(list: Mov[]) {
  const nombres = [...new Set(list.filter(m => m.producto !== "cuenta")
    .map(m => m.descripcion.match(/^Intereses de (.+)$/)?.[1]?.toLowerCase()).filter(Boolean))] as string[];
  return (m: Mov) => {
    const d = m.descripcion.toLowerCase();
    return nombres.some(n => n.length >= 4 && d.includes(n)) || /cuenta con mejora|cuenta remunerada|hucha|savings|pocket|vault|ahorros/.test(d);
  };
}

/** Patrimonio (cuenta + hucha + oro) a fin de cada mes, reconstruido hacia atrás desde hoy:
 *  la cuenta, quitando los movimientos posteriores; la hucha, quitando traspasos e intereses
 *  posteriores; el oro, a coste desde que se compró (el mes en curso, a precio de hoy). */
function seriePatrimonio(list: Mov[], s: ReturnType<typeof saldos>, keys: string[]) {
  const ahora = mesKey(new Date());
  const cuenta = list.filter(m => m.producto === "cuenta" && m.divisa === "EUR");
  const esHucha = esHuchaDe(list);
  const oroFecha = rvState.patrimonio?.oro_fecha;
  const compraOro = list.find(m => /\bxau\b/i.test(m.descripcion))?.fecha ?? (oroFecha ? `${oroFecha} 00:00:00` : null);
  const oroCoste = s.oroInfo ? (s.oroInfo.coste ?? s.oroInfo.valor) : 0;
  const diario = s.hucha?.diario ?? 0;
  return keys.map(k => {
    if (k >= ahora) return s.total;
    const fin = `${k}-31 23:59:59`;
    const despues = cuenta.filter(m => m.fecha > fin);
    const c = s.cuenta - despues.reduce((a, m) => a + m.importe - m.comision, 0);
    const finD = mesDe(k); finD.setMonth(finD.getMonth() + 1);
    const dias = Math.max(0, (Date.now() - finD.getTime()) / DIA);
    const h = s.hucha
      ? Math.max(0, s.hucha.saldo + despues.filter(m => m.interno && esHucha(m)).reduce((a, m) => a + m.importe, 0) - diario * dias)
      : 0;
    const o = compraOro && compraOro <= fin ? oroCoste : 0;
    return c + h + o;
  });
}

/** Retención de IRPF sobre los intereses en España. */
const RETENCION = .19;

/** Hucha: Open Banking no la da. Último saldo conocido (resumen del ejercicio o puesto a mano)
 *  + traspasos desde la cuenta después de esa fecha + intereses estimados al ritmo del último mes. */
function huchaEstimada(list: Mov[], p: Patrimonio) {
  const ahorro = list.filter(m => m.producto !== "cuenta" && m.divisa === "EUR");
  const conSaldo = [...ahorro].reverse().find(m => m.saldo !== null);
  const bases = [
    conSaldo ? { saldo: conSaldo.saldo!, fecha: conSaldo.fecha, manual: false } : null,
    p.hucha_saldo !== null && p.hucha_fecha ? { saldo: p.hucha_saldo, fecha: p.hucha_fecha, manual: true } : null,
  ].filter(Boolean) as { saldo: number; fecha: string; manual: boolean }[];
  if (!bases.length) return null;
  const base = bases.sort((a, b) => a.fecha.localeCompare(b.fecha)).pop()!;
  const dia = base.fecha.slice(0, 10);
  const esHucha = esHuchaDe(list);
  const traspasos = list
    .filter(m => m.producto === "cuenta" && m.divisa === "EUR" && m.fecha.slice(0, 10) > dia && catOf(m) === "Interno" && esHucha(m))
    .reduce((s, m) => s - m.importe, 0);
  // Intereses: con tu TIN (neto de la retención del 19 %, se pagan a diario), o si no lo has
  // puesto, al ritmo del último mes de intereses del resumen.
  const ultInt = [...ahorro].reverse().find(m => m.descripcion.startsWith("Intereses de"));
  const dias = Math.max(0, Math.floor((Date.now() - fechaDe(base.fecha).getTime()) / DIA));
  const diario = p.hucha_tin !== null
    ? (base.saldo + traspasos) * p.hucha_tin / 100 / 365 * (1 - RETENCION)
    : ultInt ? ultInt.importe / Math.max(1, +ultInt.fecha.slice(8, 10)) : 0;
  const intereses = diario * dias;
  return { saldo: base.saldo + traspasos + intereses, base, traspasos, intereses, diario, tin: p.hucha_tin, estimado: traspasos !== 0 || intereses > 0 };
}

function oroValor(p: Patrimonio) {
  if (p.oro_onzas === null || p.oro_onzas <= 0) return null;
  const vivo = p.oro_precio !== null;
  const valor = vivo ? p.oro_onzas * p.oro_precio! : p.oro_valor_resumen;
  if (valor === null) return null;
  return { valor, onzas: p.oro_onzas, precio: p.oro_precio, vivo, coste: p.oro_coste, ganancia: p.oro_coste ? valor - p.oro_coste : null };
}

function saldos(list: Mov[], p: Patrimonio) {
  let ultima: Mov | undefined;
  for (const m of list) if (m.saldo !== null && m.divisa === "EUR" && m.producto === "cuenta") ultima = m;
  const cuentaS = ultima?.saldo ?? 0;
  const h = huchaEstimada(list, p);
  const o = oroValor(p);
  const ahorro = h?.saldo ?? 0, oro = o?.valor ?? 0;
  return {
    total: cuentaS + ahorro + oro, liquido: cuentaS + ahorro, cuenta: cuentaS, ahorro, oro, hucha: h, oroInfo: o,
    fecha: ultima?.fecha ?? null, hay: !!ultima || !!h || !!o,
  };
}

function patri(s: ReturnType<typeof saldos>) {
  const el = $("patri");
  if (!s.hay) { el.innerHTML = `<p class="muted">Sin datos. Importa el resumen del ejercicio o conecta Revolut en F5.</p>`; $("patri-foot").textContent = ""; return; }
  const h = s.hucha, o = s.oroInfo;
  const pct = (a: number, b: number) => `${a >= 0 ? "+" : ""}${fmt(a / b * 100, 1)} %`;
  el.innerHTML = `
    <div><span class="k">Cuenta</span><span class="v money">${eur(s.cuenta, 2)}</span>
      <span class="d muted">${s.fecha ? `saldo a ${ddmm(fechaDe(s.fecha))} · ${rvState.banco.conectado ? "banco" : "CSV"}` : "sin saldo"}</span></div>
    <div><span class="k">Hucha${h?.estimado ? " ≈" : ""}</span><span class="v money">${h ? eur(h.saldo, 2) : "—"}</span>
      <span class="d muted">${h ? `${h.base.manual ? "puesto a mano" : "resumen"} el ${ddmm(fechaDe(h.base.fecha))}: <span class="money">${eur(h.base.saldo, 2)}</span>` : "importa el resumen del ejercicio o ajústala a mano"}</span>
      ${h && (h.traspasos || h.intereses > 0) ? `<span class="d muted">${h.traspasos ? `traspasos <span class="money">${h.traspasos > 0 ? "+" : ""}${fmt(h.traspasos, 2)} €</span>` : ""}${h.traspasos && h.intereses > 0 ? " · " : ""}${h.intereses > 0 ? `intereses ≈ <span class="money">+${fmt(h.intereses, 2)} €</span>` : ""}</span>` : ""}
      ${h && h.diario > 0 ? `<span class="d muted">${h.tin !== null ? `${fmt(h.tin, 2)} % TIN` : "ritmo del último mes"} · <span class="money">≈ ${fmt(h.diario, 2)} €</span>/día netos</span>` : ""}</div>
    <div><span class="k">Oro</span><span class="v money">${o ? eur(o.valor, 2) : "—"}</span>
      <span class="d muted">${o ? `${fmt(o.onzas, 6)} oz${o.precio ? ` × ${fmt(o.precio, 2)} €/oz` : " · valor del resumen"}` : "sin oro"}</span>
      ${o?.ganancia !== null && o?.ganancia !== undefined && o.coste ? `<span class="d">costó <span class="money">${eur(o.coste)}</span> · <span class="${o.ganancia >= 0 ? "up" : "down"} money">${o.ganancia >= 0 ? "+" : ""}${fmt(o.ganancia, 2)} € (${pct(o.ganancia, o.coste)})</span></span>` : ""}</div>
    <div class="tot"><span class="k">Total</span><span class="v money">${eur(s.total, 2)}</span>
      <span class="d muted">líquido <span class="money">${eur(s.liquido)}</span> · oro ${s.total ? fmt(s.oro / s.total * 100, 1) : 0} %</span></div>`;
  const pr = rvState.patrimonio?.oro_precio_fecha;
  $("patri-foot").textContent = `ORO: API.GOLD-API.COM${pr ? ` · ${stamp(pr)}` : ""} · LA HUCHA SE ESTIMA HASTA EL PRÓXIMO RESUMEN O AJUSTE`;
}

const setM = (key: string, value: string, alarm = false) =>
  document.querySelectorAll<HTMLElement>(`[data-m="${key}"]`).forEach(n => { n.textContent = value; n.classList.toggle("alarm", alarm); });

function flow(meses: Map<string, Mes>, keys: string[], serie: number[]) {
  const svg = $("flow") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!meses.size) { label(svg, 20, 110, "SIN DATOS · IMPORTA EL CSV DE REVOLUT", { fill: K.grid }); return; }
  const defs = svgEl("defs", {}, svg);
  const pat = svgEl("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: K.text, "stroke-width": 1.2 }, pat);
  const l = 46, r = 552, top = 18, base = 190, gw = (r - l) / keys.length, bw = gw * .3;
  const data = keys.map(k => meses.get(k) ?? { ing: 0, gas: 0, cats: new Map() });
  // Barras en su escala; la línea del patrimonio, en la suya (sus cifras van en las etiquetas).
  const accs = serie;
  const max = Math.max(1, ...data.map(d => Math.max(d.ing, d.gas)));
  const Y = (v: number) => base - v / max * (base - top);
  const aMin = Math.min(...accs), aMax = Math.max(...accs);
  const margen = (aMax - aMin) * .15 || Math.max(1, Math.abs(aMax) * .05);
  const YL = (v: number) => base - 14 - (v - aMin + margen) / (aMax - aMin + 2 * margen) * (base - top - 14);
  const zero = Y(0);
  for (let k = 0; k <= 3; k++) {
    const v = max * k / 3, y = Y(v);
    svgEl("line", { x1: l, y1: y, x2: r, y2: y, stroke: K.grid, "stroke-width": 1, "stroke-dasharray": k ? "2 4" : "" }, svg);
    label(svg, l - 6, y + 3, fmt(Math.round(v / 100) * 100), { "text-anchor": "end", "font-size": 9, class: "money" });
  }
  keys.forEach((k, i) => {
    const d = data[i], x = l + i * gw, sel = k === mesSel;
    const g = svgEl("g", { class: "col", "data-mes": k }, svg);
    svgEl("rect", { x, y: top - 8, width: gw, height: base - top + 30, fill: K.ph, "fill-opacity": sel ? .08 : 0, class: "hit" }, g);
    const hi = zero - Y(d.ing), hg = zero - Y(d.gas);
    if (hi > 0) svgEl("rect", { x: x + gw / 2 - bw - 1, y: zero - hi, width: bw, height: hi, fill: K.ph, "fill-opacity": sel ? 1 : .7, class: "grow", style: `--i:${i}` }, g);
    if (hg > 0) svgEl("rect", { x: x + gw / 2 + 1, y: zero - hg, width: bw, height: hg, fill: "url(#hatch)", stroke: K.text, "stroke-width": 1, class: "grow", style: `--i:${i}` }, g);
    label(g, x + gw / 2, base + 16, MESES[mesDe(k).getMonth()], { "text-anchor": "middle", "font-size": 9, fill: sel ? K.hi : K.grid });
    const t = svgEl("title", {}, g); t.textContent = `${mesNombre(k)} · ingresos ${eur(d.ing)} · gastos ${eur(d.gas)} · patrimonio ${eur(serie[i])}`;
  });
  const pts = accs.map((v, i) => [l + i * gw + gw / 2, YL(v)]);
  svgEl("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: K.hi, "stroke-width": 1.6, pathLength: 1, class: "draw glow" }, svg);
  const [lx, ly] = pts[pts.length - 1];
  svgEl("rect", { x: lx - 2.5, y: ly - 2.5, width: 5, height: 5, fill: K.hi, class: "fade" }, svg);
  label(svg, Math.min(lx, r - 34), ly - 9, eur(accs[accs.length - 1]), { "text-anchor": "middle", fill: K.hi, class: "fade money" });
  const [fx, fy] = pts[0];
  label(svg, fx + 2, fy - 9, eur(accs[0]), { "text-anchor": "start", fill: K.text, "font-size": 9, class: "fade money" });
}

function cats(m: Mes | undefined, media: Map<string, number>) {
  const el = $("cats");
  const rows = m ? [...m.cats].filter(([, v]) => Math.abs(v) >= .5).sort((a, b) => b[1] - a[1]) : [];
  if (!rows.length) { el.innerHTML = `<p class="muted">Sin gastos este mes.</p>`; return; }
  const max = Math.max(...rows.map(r => r[1]));
  el.innerHTML = rows.map(([c, v], i) => {
    const avg = media.get(c) ?? 0;
    const up = avg > 20 && v > avg * 1.5;
    return `<div class="cat"><span>${esc(c)}${up ? `<span class="up">↑${fmt(v / avg, 1)}×</span>` : ""}</span>
      <span class="track"><span class="fill${up ? " hl" : ""}" style="width:${Math.max(0, v / max * 100)}%;--i:${i}"></span></span>
      <span class="amt money">${eur(v)}</span></div>`;
  }).join("") + `<div class="cat total"><span>Total</span><span></span><span class="amt money">${eur(rows.reduce((s, r) => s + r[1], 0))}</span></div>`;
}

function movs(list: Mov[]) {
  const el = $("movs");
  const rows = list.filter(m => m.fecha.startsWith(mesSel ?? "-")).reverse();
  $("movs-n").textContent = rows.length ? `${rows.length} MOVIMIENTO${rows.length === 1 ? "" : "S"}` : "";
  if (!rows.length) { el.innerHTML = `<p class="muted">${list.length ? "Sin movimientos este mes." : "Importa el CSV de Revolut para ver tus movimientos."}</p>`; return; }
  el.innerHTML = rows.map(m => {
    const c = catOf(m);
    const opts = CATS.map(k => `<option${k === c ? " selected" : ""}>${k}</option>`).join("");
    const extra = [m.estado === "pendiente" ? "pendiente" : "", m.divisa !== "EUR" ? m.divisa : "", m.producto !== "cuenta" ? m.producto : ""].filter(Boolean).join(" · ");
    return `<div class="mov${c === "Interno" ? " int" : ""}">
      <span class="muted">${ddmm(fechaDe(m.fecha))}</span>
      <span class="ds" title="${esc(m.descripcion)}">${esc(m.descripcion)}${extra ? `<small>${esc(extra)}</small>` : ""}</span>
      <select data-comercio="${esc(m.comercio)}" aria-label="Categoría de ${esc(m.descripcion)}">${opts}</select>
      <span class="amt money${m.importe > 0 ? " pos" : ""}">${m.importe > 0 ? "+" : ""}${fmt(m.importe, 2)}${m.divisa === "EUR" ? " €" : ""}</span>
    </div>`;
  }).join("");
}

function subs(list: Sub[]) {
  const tot = list.reduce((s, x) => s + x.mensual, 0);
  $("subs").innerHTML = list.length
    ? list.map(s => `<tr><td>${esc(s.nombre)}<span class="note${s.sube ? " up" : ""}">${s.cada}${s.sube ? ` · ▲ sube ${fmt(s.sube, 2)} € en ${s.desde}` : ""}</span></td>
        <td class="r money">${fmt(s.importe, 2)} €</td></tr>`).join("")
      + `<tfoot><tr><td>Al mes · al año</td><td class="r money">${eur(tot, 2)} · ${eur(tot * 12)}</td></tr></tfoot>`
    : `<tr><td class="muted">${rvState.movimientos.length ? "No se ve ningún cargo que se repita." : "Sin datos."}</td></tr>`;
  const hoy = Date.now();
  const prox = list.filter(s => s.proximo.getTime() - hoy <= 30 * DIA).sort((a, b) => a.proximo.getTime() - b.proximo.getTime());
  $("proximos").innerHTML = prox.length
    ? prox.map(s => {
        const late = s.proximo.getTime() < hoy - DIA;
        return `<div class="row"><span>${ddmm(s.proximo)} · ${esc(s.nombre)}${late ? ' <span class="muted">(previsto)</span>' : ""}</span><span class="money">${fmt(s.importe, 2)} €</span></div>`;
      }).join("")
    : `<div class="row"><span class="muted">Nada previsto</span><span></span></div>`;
}

function briefDinero(lines: string[]) {
  const list = rvState.movimientos;
  if (!list.length) { lines.push(`<span class="off">Dinero: importa el CSV de Revolut en <b>F3</b>.</span>`); return; }
  const meses = porMes(list);
  const k = mesKey(new Date());
  const m = meses.get(k);
  const prev = [...meses.keys()].filter(x => x < k).sort().slice(-6);
  const media = prev.length ? prev.reduce((s, x) => s + meses.get(x)!.gas, 0) / prev.length : 0;
  if (m) {
    // Ritmo: lo gastado hasta hoy contra lo que llevabas al mismo día en los meses anteriores.
    const dia = new Date().getDate();
    const hastaDia = new Map<string, number>();
    for (const x of list) {
      const mk = x.fecha.slice(0, 7);
      if (!prev.includes(mk) || +x.fecha.slice(8, 10) > dia || !cuenta(x) || catOf(x) === "Ingresos") continue;
      hastaDia.set(mk, (hastaDia.get(mk) ?? 0) - x.importe + x.comision);
    }
    const ref = prev.length ? prev.reduce((s, k2) => s + (hastaDia.get(k2) ?? 0), 0) / prev.length : 0;
    const ritmo = ref ? m.gas / ref : 1;
    lines.push(`Este mes llevas <b class="money">${eur(m.gas)}</b> gastados${media ? ` y la media es <b class="money">${eur(media)}</b>` : ""}`
      + (media && ritmo > 1.15 ? `: <span class="hot">vas un ${fmt((ritmo - 1) * 100)} % por encima de tu ritmo</span>.` : "."));
  }
  const hoy = Date.now();
  const pronto = subsCache.filter(s => s.proximo.getTime() >= hoy - DIA && s.proximo.getTime() - hoy <= 7 * DIA);
  if (pronto.length) lines.push(`Cobros en 7 días: ${pronto.map(s => `<b>${esc(s.nombre)}</b> <span class="money">${fmt(s.importe, 2)} €</span> el ${ddmm(s.proximo)}`).join(" · ")}.`);
  const suben = subsCache.filter(s => s.sube);
  if (suben.length) lines.push(suben.map(s => `<span class="hot">${esc(s.nombre)} sube ${fmt(s.sube, 2)} €</span>`).join(" · ") + ".");
  const ultimo = list[list.length - 1];
  if (daysAgo(ultimo.fecha.slice(0, 10)) > 35) lines.push(`<span class="off">El último extracto acaba el ${ddmm(fechaDe(ultimo.fecha))}: importa uno nuevo.</span>`);
}

function renderDinero(d: Dinero) {
  rvState = d;
  const list = d.movimientos;
  subsCache = [];
  subsCache = detectarSubs(list);
  const meses = porMes(list);
  const now = mesKey(new Date());
  const conDatos = [...meses.keys()].sort();
  const ultimo = conDatos[conDatos.length - 1] ?? now;
  const fin = [now, ultimo].sort().pop()!;
  if (!mesSel) mesSel = meses.has(now) ? now : ultimo;
  if (mesSel > fin) mesSel = fin;
  if (conDatos.length && mesSel < conDatos[0]) mesSel = conDatos[0];
  const keys = Array.from({ length: 12 }, (_, i) => { const x = mesDe(fin); x.setMonth(x.getMonth() - 11 + i); return mesKey(x); });

  const m = meses.get(mesSel);
  const prev = conDatos.filter(k => k < mesSel!).slice(-6);
  const media = new Map<string, number>();
  let gMedia = 0, tMedia: number[] = [];
  for (const k of prev) {
    const x = meses.get(k)!;
    gMedia += x.gas / prev.length;
    if (x.ing > 0) tMedia.push((x.ing - x.gas) / x.ing * 100);
    for (const [c, v] of x.cats) media.set(c, (media.get(c) ?? 0) + v / prev.length);
  }
  const has = list.length > 0;
  const s = saldos(list, d.patrimonio ?? SIN_PATRIMONIO);
  const nombre = MESES[mesDe(mesSel).getMonth()];
  setM("saldo", s.hay ? eur(s.total) : "—");
  setM("saldo_d", s.hay ? [`cuenta ${eur(s.cuenta)}`, s.hucha ? `hucha ${s.hucha.estimado ? "≈" : ""}${eur(s.ahorro)}` : "", s.oroInfo ? `oro ${eur(s.oro)}` : ""].filter(Boolean).join(" · ") : has ? "el CSV no trae saldo" : "importa el CSV en F3");
  setM("ing_k", `Ingresos · ${nombre}`);
  setM("gas_k", `Gastos · ${nombre}`);
  setM("ing", has ? eur(m?.ing ?? 0) : "—");
  setM("gas", has ? eur(m?.gas ?? 0) : "—");
  const ingMedia = prev.reduce((a, k) => a + meses.get(k)!.ing, 0) / (prev.length || 1);
  setM("ing_d", prev.length ? `media ${eur(ingMedia)}` : "");
  setM("gas_d", prev.length ? `media ${eur(gMedia)}` : "");
  const tasa = m && m.ing > 0 ? (m.ing - m.gas) / m.ing * 100 : null;
  setM("tasa", tasa === null ? "—" : `${fmt(tasa)} %`, tasa !== null && tasa < 0);
  setM("tasa_d", tMedia.length ? `media 6 m: ${fmt(tMedia.reduce((a, b) => a + b, 0) / tMedia.length)} %` : "");
  const gas6 = conDatos.filter(k => k < now).slice(-6);
  const gasto6 = gas6.reduce((a, k) => a + meses.get(k)!.gas, 0) / (gas6.length || 1);
  const colchon = s.hay && gasto6 > 0 ? s.liquido / gasto6 : null;
  setM("colchon", colchon === null ? "—" : `${fmt(colchon, 1)} meses`, colchon !== null && colchon < 1);
  setM("cats_h", `Gasto por categoría · ${nombre}`);
  setM("movs_h", `Movimientos · ${nombre}`);
  $("m-label").textContent = mesNombre(mesSel);
  ($("m-next") as HTMLButtonElement).disabled = mesSel >= fin;
  ($("m-prev") as HTMLButtonElement).disabled = !has || mesSel <= (conDatos[0] ?? mesSel);

  patri(s);
  flow(meses, keys, seriePatrimonio(list, s, keys));
  cats(m, media);
  movs(list);
  subs(subsCache);

  const info = has ? `EXTRACTO ${d.importado ? stamp(d.importado) : ""} · ${fmt(list.length)} MOVIMIENTOS · ${ddmm(fechaDe(list[0].fecha))}.${list[0].fecha.slice(2, 4)} → ${ddmm(fechaDe(list[list.length - 1].fecha))}.${list[list.length - 1].fecha.slice(2, 4)}` : "SIN EXTRACTO · IMPORTA EL CSV DE REVOLUT";
  $("rv-info").textContent = info;
  const b = d.banco ?? SIN_BANCO;
  const dias = b.valido_hasta ? Math.floor((new Date(b.valido_hasta).getTime() - Date.now()) / DIA) : null;
  const renovar = b.conectado && dias !== null && dias <= 7;
  const src = $("src-revolut");
  src.className = "src" + (b.conectado ? (renovar || b.error ? " err" : " on") : has ? " on" : "");
  src.lastChild!.textContent = b.conectado
    ? (renovar ? (dias! < 0 ? "Revolut · permiso caducado" : `Revolut · renovar acceso en ${dias} d`) : b.error ? "Revolut · error" : "Revolut · banco")
    : has ? `Revolut · CSV ${ddmm(fechaDe(list[list.length - 1].fecha))}` : "Revolut · sin datos";
  $("rv-state").textContent = b.conectado ? `Conectado · ${b.cuentas} cuenta${b.cuentas === 1 ? "" : "s"}` : has ? `${fmt(list.length)} movimientos` : "Sin conectar";
  $("rv-state").className = "state" + (b.conectado ? (renovar || b.error ? " err" : " on") : has ? " on" : "");
  $("rv-off").hidden = !has;
  renderBanco(b, dias);
  brief();
}

function renderBanco(b: Banco, dias: number | null) {
  const st = $("rv-bank-state");
  st.className = "muted" + ((dias !== null && dias <= 7) || b.error ? " warn" : "");
  st.textContent = b.conectado
    ? `· ${dias !== null ? (dias < 0 ? "permiso caducado" : `permiso ${dias} d`) : "conectado"}${b.sincronizado ? ` · leído ${stamp(b.sincronizado)}` : ""}`
    : b.configurado ? "· aplicación guardada" : "";
  $("rv-bank-help").hidden = b.configurado;
  $("rv-bank-form").hidden = b.configurado;
  $("rv-bank-actions").hidden = !b.configurado;
  $("rv-bank-connect").textContent = b.conectado ? "Renovar acceso" : "Conectar con Revolut";
  $("rv-bank-sync").hidden = !b.conectado;
  $("rv-bank-off").textContent = b.conectado ? "Desconectar" : "Olvidar aplicación";
  if (b.error && !$("rv-bank-msg").textContent) bankMsg(b.error, "err");
}

const bankMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("rv-bank-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };

async function bancoAccion(btn: HTMLButtonElement, aviso: string, fn: () => Promise<Dinero | null>, ok: (d: Dinero) => string) {
  if (!TAURI) { bankMsg("En modo demo no se conecta nada: abre LIFE como app.", "err"); return; }
  btn.disabled = true; bankMsg(aviso);
  try {
    const d = await fn();
    if (!d) { bankMsg(""); return; }
    mesSel = null;
    renderDinero(d);
    bankMsg(ok(d), "ok");
  } catch (err) { bankMsg(String(err), "err"); }
  finally { btn.disabled = false; }
}

$("rv-bank-form").addEventListener("submit", e => {
  e.preventDefault();
  const id = $<HTMLInputElement>("rv-app-id");
  bancoAccion($<HTMLButtonElement>("rv-app-save"), "Elige el archivo .pem de Enable Banking…",
    () => invoke<Dinero | null>("banco_configurar", { appId: id.value }),
    () => { id.value = ""; return "Aplicación comprobada y guardada en las credenciales de Windows. Ya puedes borrar el .pem."; });
});
$("rv-bank-connect").addEventListener("click", () =>
  bancoAccion($<HTMLButtonElement>("rv-bank-connect"), "Autoriza en la ventana que se ha abierto (Revolut te pedirá confirmar en el móvil)…",
    () => invoke<Dinero>("banco_conectar"),
    d => `Conectado. ${fmt(d.movimientos.filter(m => m.fuente === "banco").length)} movimientos del banco.`));
$("rv-bank-sync").addEventListener("click", () =>
  bancoAccion($<HTMLButtonElement>("rv-bank-sync"), "Leyendo Revolut…",
    () => invoke<Dinero>("banco_sync"),
    () => "Sincronizado."));
$("rv-bank-off").addEventListener("click", () => {
  const todo = !rvState.banco.conectado;
  bancoAccion($<HTMLButtonElement>("rv-bank-off"), "",
    () => invoke<Dinero>("banco_desconectar", { todo }),
    () => todo ? "ID y clave de Enable Banking borrados de las credenciales." : "Permiso del banco quitado de LIFE. Los movimientos se quedan. Para revocarlo también en Revolut: Ajustes → Privacidad → Apps conectadas.");
});

function cambiarMes(delta: number) {
  if (!mesSel) return;
  const d = mesDe(mesSel); d.setMonth(d.getMonth() + delta);
  mesSel = mesKey(d);
  renderDinero(rvState);
  countUp($("v-dinero"));
}
$("m-prev").addEventListener("click", () => cambiarMes(-1));
$("m-next").addEventListener("click", () => cambiarMes(1));
$("flow").addEventListener("click", e => {
  const k = (e.target as Element).closest("[data-mes]")?.getAttribute("data-mes");
  if (k) { mesSel = k; renderDinero(rvState); }
});

const rvMsg = (text: string, kind: "ok" | "err" | "" = "") =>
  document.querySelectorAll<HTMLElement>("[data-import-msg]").forEach(m => { m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); });

$("movs").addEventListener("change", async e => {
  const sel = e.target as HTMLSelectElement;
  const comercio = sel.dataset.comercio;
  if (!comercio) return;
  const muestra = rvState.movimientos.find(m => m.comercio === comercio)!;
  const valor = sel.value === autoCat(muestra) ? "" : sel.value;
  const n = rvState.movimientos.filter(m => m.comercio === comercio).length;
  try {
    const d = TAURI
      ? await invoke<Dinero>("dinero_categoria", { comercio, categoria: valor })
      : { ...rvState, categorias: Object.fromEntries(Object.entries({ ...rvState.categorias, [comercio]: valor }).filter(([, v]) => v)) };
    renderDinero(d);
    rvMsg(`«${sel.value}» para ${n} movimiento${n === 1 ? "" : "s"} de ${muestra.descripcion}.`, "ok");
  } catch (err) { rvMsg(String(err), "err"); }
});

document.querySelectorAll<HTMLButtonElement>("[data-import]").forEach(b => b.addEventListener("click", async () => {
  if (!TAURI) { rvMsg("En modo demo no se importa nada: abre LIFE como app.", "err"); return; }
  const all = document.querySelectorAll<HTMLButtonElement>("[data-import]");
  all.forEach(x => (x.disabled = true));
  rvMsg("Elige el CSV del extracto…");
  try {
    const r = await invoke<Importe | null>("dinero_importar");
    if (!r) { rvMsg(""); return; }
    mesSel = null;
    renderDinero(r.vista);
    rvMsg(`${fmt(r.leidos)} leídos · ${fmt(r.nuevos)} nuevos · ${fmt(r.actualizados)} actualizados${r.solapados ? ` · ${fmt(r.solapados)} ya los da el banco` : ""}${r.ignorados ? ` · ${r.ignorados} revertidos o rechazados, fuera` : ""}${r.vista.patrimonio?.oro_onzas ? ` · oro: ${fmt(r.vista.patrimonio.oro_onzas, 6)} oz` : ""}.`, "ok");
    countUp($("v-dinero"));
  } catch (err) { rvMsg(String(err), "err"); }
  finally { all.forEach(x => (x.disabled = false)); }
}));

let borrarArmado = 0;
$("rv-off").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("rv-off");
  if (Date.now() - borrarArmado > 4000) {
    borrarArmado = Date.now();
    b.textContent = "¿Seguro? Pulsa otra vez";
    setTimeout(() => { b.textContent = "Borrar movimientos"; }, 4000);
    return;
  }
  borrarArmado = 0;
  b.textContent = "Borrar movimientos";
  if (!TAURI) { renderDinero({ movimientos: [], categorias: rvState.categorias, importado: null, archivo: null, banco: rvState.banco, patrimonio: rvState.patrimonio }); return; }
  try { renderDinero(await invoke<Dinero>("dinero_borrar")); rvMsg("Movimientos borrados de life.db. Las categorías que elegiste se conservan.", "ok"); }
  catch (err) { rvMsg(String(err), "err"); }
});

/* ---------- patrimonio: ajuste a mano ---------- */
const patriMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("patri-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };
$("patri-edit").addEventListener("click", () => {
  const f = $("patri-form");
  f.hidden = !f.hidden;
  if (f.hidden) return;
  const s = saldos(rvState.movimientos, rvState.patrimonio ?? SIN_PATRIMONIO);
  $<HTMLInputElement>("pf-hucha").value = s.hucha ? s.hucha.saldo.toFixed(2) : "";
  $<HTMLInputElement>("pf-oro").value = rvState.patrimonio?.oro_onzas?.toString() ?? "";
  $<HTMLInputElement>("pf-tin").value = rvState.patrimonio?.hucha_tin?.toString() ?? "";
  $<HTMLInputElement>("pf-hucha").focus();
});
$("pf-cancel").addEventListener("click", () => { $("patri-form").hidden = true; patriMsg(""); });
$("patri-form").addEventListener("submit", async e => {
  e.preventDefault();
  const num = (id: string) => { const v = $<HTMLInputElement>(id).value.trim().replace(",", "."); return v === "" ? null : Number(v); };
  const hucha = num("pf-hucha"), oro = num("pf-oro"), tin = num("pf-tin");
  if ((hucha !== null && !(hucha >= 0)) || (oro !== null && !(oro >= 0)) || (tin !== null && !(tin >= 0 && tin <= 20))) { patriMsg("Pon cifras positivas (el TIN, entre 0 y 20 %).", "err"); return; }
  const prev = saldos(rvState.movimientos, rvState.patrimonio ?? SIN_PATRIMONIO);
  // Solo se guarda lo que cambió: si la hucha sigue igual que la estimación, no se fija a mano.
  const huchaCambia = hucha !== null && (!prev.hucha || Math.abs(prev.hucha.saldo - hucha) >= .005);
  const oroCambia = oro !== null && oro !== rvState.patrimonio?.oro_onzas;
  const tinCambia = tin !== null && tin !== rvState.patrimonio?.hucha_tin;
  if (!huchaCambia && !oroCambia && !tinCambia) { $("patri-form").hidden = true; return; }
  if (!TAURI) {
    const now = new Date();
    renderDinero({ ...rvState, patrimonio: { ...rvState.patrimonio, ...(huchaCambia ? { hucha_saldo: hucha, hucha_fecha: `${mesKey(now)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:00` } : {}), ...(oroCambia ? { oro_onzas: oro } : {}), ...(tinCambia ? { hucha_tin: tin } : {}) } });
    $("patri-form").hidden = true; patriMsg("Guardado (modo demo).", "ok"); return;
  }
  const btn = $<HTMLButtonElement>("pf-save");
  btn.disabled = true; patriMsg("Guardando y consultando el precio del oro…");
  try {
    renderDinero(await invoke<Dinero>("patrimonio_ajustar", { oroOnzas: oroCambia ? oro : null, hucha: huchaCambia ? hucha : null, tin: tinCambia ? tin : null }));
    $("patri-form").hidden = true; patriMsg("Guardado.", "ok");
  } catch (err) { patriMsg(String(err), "err"); }
  finally { btn.disabled = false; }
});

/* ---------- datos de ejemplo fuera de la app ---------- */
function demoDinero(): Dinero {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const movimientos: Mov[] = [];
  const hoy = new Date();
  let saldo = 1800, hucha = 4200, n = 0;
  const add = (d: Date, descripcion: string, importe: number, tipo = "tarjeta", producto = "cuenta", interno = false) => {
    if (d > hoy) return;
    if (producto === "cuenta") saldo += importe; else hucha += importe;
    const f = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(9 + (n % 10))}:${pad(n % 60)}:00`;
    movimientos.push({
      id: String(n++), fecha: f, completada: f, tipo, producto, descripcion, interno, fuente: "banco",
      comercio: descripcion.toLowerCase().split("*")[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
      importe: Math.round(importe * 100) / 100, comision: 0, divisa: "EUR", estado: "completado",
      saldo: Math.round((producto === "cuenta" ? saldo : hucha) * 100) / 100,
    });
  };
  for (let i = 13; i >= 0; i--) {
    const y = hoy.getFullYear(), mo = hoy.getMonth() - i;
    const day = (d: number) => new Date(y, mo, d);
    add(day(1), "To Alquiler estudio", -650, "transferencia");
    add(day(2), "Payment from Estudio Lino", 1400 + Math.round(rnd() * 900), "transferencia");
    if (rnd() > .4) add(day(18), `Payment from ${["Café Ámbar", "Nora Ruiz", "Mar Cerámica", "Bruno y Sara"][i % 4]}`, 300 + Math.round(rnd() * 800), "transferencia");
    add(day(3), "Netflix.com", i <= 1 ? -13.99 : -12.99);
    add(day(5), "Spotify", -11.99);
    add(day(9), "Adobe *Creative Cloud", -24.19);
    add(day(12), "Apple.com/bill iCloud", -2.99);
    add(day(6), "Iberdrola", -38 - rnd() * 30, "transferencia");
    add(day(4), "Digi Mobil", -15);
    for (let w = 0; w < 4; w++) add(day(4 + w * 7), "Mercadona", -45 - rnd() * 40);
    for (let r = 0; r < 4; r++) add(day(8 + r * 5), ["Bar Lola", "Taberna El Sur", "Glovo*Pedido", "Sushi Kao"][r], -12 - rnd() * 35);
    add(day(14), "Renfe Viajeros", -8 - rnd() * 30);
    if (rnd() > .5) add(day(20), "Amazon.es*AB12CD", -20 - rnd() * 60);
    if (i === 1) add(day(22), "Fotocasion", -899);
    add(day(25), "To EUR Savings", -200, "transferencia", "cuenta", true);
    add(day(25), "From EUR Current", 200, "transferencia", "ahorro", true);
  }
  movimientos.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { movimientos, categorias: { "taberna el sur": "Restaurantes" }, importado: new Date().toISOString(), archivo: null,
    banco: { configurado: true, conectado: true, app_id: "demo", valido_hasta: new Date(Date.now() + 172 * DIA).toISOString(), sincronizado: new Date().toISOString(), cuentas: 2, error: null },
    patrimonio: { ...SIN_PATRIMONIO, oro_onzas: 0.124945, oro_coste: 500, oro_valor_resumen: 404.39, oro_fecha: "2026-11-20", oro_precio: 3203.39, oro_precio_fecha: new Date().toISOString(), hucha_tin: 1.15 } };
}

function demoGmail(): Gmail {
  const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const base = { uid: 0, asunto: "", telefono: "", empresa: "", web: "", idioma: "español", respondido: null as string | null };
  const e = (id: string, h: number, tipo: string, que: string, nombre: string, estado: string, extra: Partial<Encargo> = {}): Encargo =>
    ({ ...base, id, recibido: ago(h), tipo, que, nombre, correo: `${id}@example.com`, fecha: "", lugar: "", presupuesto: "", mensaje: "", estado, ...extra });
  return {
    connected: true, user: "ejemplo@gmail.com", synced_at: new Date().toISOString(),
    encargos: [
      e("lucia", 51, "Fotografía", "Retrato", "Lucía M.", "nuevo", { fecha: "2026-12-05", lugar: "Madrid", presupuesto: "300–600 €", mensaje: "Hola, me gustaría hacer unas fotos de retrato para mi web de ilustración.\n\nGracias." }),
      e("cafe", 6, "Fotografía", "Producto", "Café Ámbar", "nuevo", { empresa: "Café Ámbar", presupuesto: "600–1.200 €", mensaje: "Necesitamos fotos de la carta nueva." }),
      e("nora", 30, "Software", "Web", "Nora Ruiz", "respondido", { respondido: ago(26), fecha: "enero", presupuesto: "2.000–4.000 €" }),
      e("tomas", 24 * 9, "Fotografía", "Evento", "Tomás G.", "presupuesto", { respondido: ago(24 * 9 - 3), lugar: "Valencia" }),
      e("estudio", 24 * 16, "Software", "Tienda online", "Estudio Lino", "confirmado", { respondido: ago(24 * 16 - 5) }),
      e("ines", 24 * 34, "Fotografía", "Retrato", "Inés P.", "cobrado", { respondido: ago(24 * 34 - 2) }),
      e("bruno", 24 * 70, "Fotografía", "Boda", "Bruno y Sara", "cobrado", { respondido: ago(24 * 70 - 8) }),
      e("kei", 24 * 120, "Software", "App", "Kei", "descartado", { respondido: ago(24 * 119) }),
      e("mar", 24 * 200, "Fotografía", "Producto", "Mar Cerámica", "cobrado", { respondido: ago(24 * 199) }),
    ],
  };
}

function demo(): Status<GitHub> {
  let seed = 47;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const days: Day[] = [];
  const today = new Date();
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const lvl = rnd() < (i < 90 ? .75 : .45) ? Math.ceil(rnd() * 4) : 0;
    days.push({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, count: lvl * 3, level: i < 12 ? Math.max(1, lvl) : lvl });
  }
  const ago = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  return {
    connected: true,
    snapshot: {
      login: "ejemplo", name: null, total_year: 1184, last_90: 214, streak: 12, longest: 19, days,
      repos: [
        { name: "glutamato_cult", pushed_at: ago(0), private: false, language: "Astro" },
        { name: "life", pushed_at: ago(1), private: true, language: "Rust" },
        { name: "linear-peaks", pushed_at: ago(4), private: false, language: "TypeScript" },
        { name: "grimoire", pushed_at: ago(9), private: true, language: "TypeScript" },
        { name: "indra-ingenia", pushed_at: ago(23), private: true, language: null },
      ],
      open_prs: 1, open_issues: 3, synced_at: new Date().toISOString(),
    },
  };
}

/* ---------- conexiones ---------- */
const msg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("gh-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };

const gmMsg = (text: string, kind: "ok" | "err" | "" = "") => { const m = $("gm-msg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); };

async function load() {
  if (!TAURI) { renderDinero(demoDinero()); renderGmail(demoGmail()); renderInstagram(demoInstagram()); renderYouTube(demoYouTube()); render(demo()); return; }
  try { renderYouTube(await invoke<YtView>("youtube_status")); }
  catch (e) { ytMsg(String(e), "err"); }
  try { renderInstagram(await invoke<Status<Instagram>>("instagram_status")); }
  catch (e) { igMsg(String(e), "err"); }
  try { renderDinero(await invoke<Dinero>("dinero_status")); }
  catch (e) { rvMsg(String(e), "err"); }
  try { renderGmail(await invoke<Gmail>("gmail_status")); }
  catch (e) { gmMsg(String(e), "err"); }
  try { render(await invoke<Status<GitHub>>("github_status")); }
  catch (e) { msg(String(e), "err"); }
}

$("gm-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!TAURI) { gmMsg("En modo demo no se guarda nada.", "err"); return; }
  const user = $<HTMLInputElement>("gm-user"), pass = $<HTMLInputElement>("gm-pass");
  const btn = $<HTMLButtonElement>("gm-connect");
  btn.disabled = true; gmMsg("Comprobando con Gmail y leyendo los encargos…");
  try {
    const g = await invoke<Gmail>("gmail_connect", { user: user.value, password: pass.value });
    pass.value = "";
    gmMsg(`Conectado. ${g.encargos.length} encargo${g.encargos.length === 1 ? "" : "s"} leído${g.encargos.length === 1 ? "" : "s"}.`, "ok");
    renderGmail(g);
  } catch (err) { gmMsg(String(err), "err"); }
  finally { btn.disabled = false; }
});

$("gm-sync").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("gm-sync");
  btn.disabled = true; gmMsg("Leyendo Gmail…");
  try { renderGmail(await invoke<Gmail>("gmail_sync")); gmMsg("Sincronizado.", "ok"); }
  catch (err) { gmMsg(String(err), "err"); $("src-gmail").className = "src err"; }
  finally { btn.disabled = false; }
});

$("gm-off").addEventListener("click", async () => {
  try { renderGmail(await invoke<Gmail>("gmail_disconnect")); gmMsg("Contraseña borrada de las credenciales de Windows. Los encargos leídos se quedan en life.db."); }
  catch (err) { gmMsg(String(err), "err"); }
});

$("gh-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!TAURI) { msg("En modo demo no se guarda nada.", "err"); return; }
  const input = $<HTMLInputElement>("gh-token");
  const btn = $<HTMLButtonElement>("gh-connect");
  btn.disabled = true; msg("Comprobando el token con GitHub…");
  try {
    const snap = await invoke<GitHub>("github_connect", { token: input.value });
    input.value = "";
    msg(`Conectado como @${snap.login}.`, "ok");
    render({ connected: true, snapshot: snap });
  } catch (err) { msg(String(err), "err"); }
  finally { btn.disabled = false; }
});

$("gh-sync").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("gh-sync");
  btn.disabled = true; msg("Sincronizando…");
  try { render({ connected: true, snapshot: await invoke<GitHub>("github_sync") }); msg("Sincronizado.", "ok"); }
  catch (err) { msg(String(err), "err"); $("src-github").className = "src err"; }
  finally { btn.disabled = false; }
});

$("gh-off").addEventListener("click", async () => {
  try { await invoke("github_disconnect"); msg("Token borrado de las credenciales de Windows."); render({ connected: false, snapshot: null }); }
  catch (err) { msg(String(err), "err"); }
});

const auto = $<HTMLInputElement>("autostart");
if (TAURI) {
  isEnabled().then(v => (auto.checked = v)).catch(() => {});
  auto.addEventListener("change", async () => {
    try { auto.checked ? await enable() : await disable(); }
    catch { auto.checked = !auto.checked; }
  });
  listen<GitHub>("github-updated", e => render({ connected: true, snapshot: e.payload }));
  listen<Gmail>("gmail-updated", e => renderGmail(e.payload));
  listen<Dinero>("dinero-updated", e => renderDinero(e.payload));
  listen<YtView>("youtube-updated", e => renderYouTube(e.payload));
  listen<Instagram>("instagram-updated", e => renderInstagram({ connected: true, snapshot: e.payload }));
  // Las esperas («51 h») y el aviso de 48 h avanzan aunque no haya sincronización.
  setInterval(() => renderGmail(gmState), 5 * 60 * 1000);
} else {
  auto.disabled = true;
}

load();
