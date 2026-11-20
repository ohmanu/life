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
type Dinero = { movimientos: Mov[]; categorias: Record<string, string>; importado: string | null; archivo: string | null; banco: Banco };
const SIN_BANCO: Banco = { configurado: false, conectado: false, app_id: null, valido_hasta: null, sincronizado: null, cuentas: 0, error: null };
type Importe = { nuevos: number; actualizados: number; ignorados: number; leidos: number; vista: Dinero };
type Sub = { comercio: string; nombre: string; cada: "semanal" | "mensual" | "anual"; dias: number; importe: number; mensual: number; ultimo: Date; proximo: Date; sube: number; desde: string };

let rvState: Dinero = { movimientos: [], categorias: {}, importado: null, archivo: null, banco: SIN_BANCO };
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
function saldos(list: Mov[]) {
  const last = new Map<string, Mov>();
  for (const m of list) if (m.saldo !== null && m.divisa === "EUR") last.set(m.producto, m);
  const cuentaS = last.get("cuenta")?.saldo ?? 0;
  let ahorro = 0;
  for (const [p, m] of last) if (p !== "cuenta") ahorro += m.saldo ?? 0;
  const fecha = [...last.values()].map(m => m.fecha).sort().pop() ?? null;
  return { total: cuentaS + ahorro, cuenta: cuentaS, ahorro, fecha, hay: last.size > 0 };
}

const setM = (key: string, value: string, alarm = false) =>
  document.querySelectorAll<HTMLElement>(`[data-m="${key}"]`).forEach(n => { n.textContent = value; n.classList.toggle("alarm", alarm); });

function flow(meses: Map<string, Mes>, keys: string[]) {
  const svg = $("flow") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!meses.size) { label(svg, 20, 110, "SIN DATOS · IMPORTA EL CSV DE REVOLUT", { fill: K.grid }); return; }
  const defs = svgEl("defs", {}, svg);
  const pat = svgEl("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: K.text, "stroke-width": 1.2 }, pat);
  const l = 46, r = 552, top = 18, base = 190, gw = (r - l) / keys.length, bw = gw * .3;
  const data = keys.map(k => meses.get(k) ?? { ing: 0, gas: 0, cats: new Map() });
  let acc = 0;
  const accs = data.map(d => (acc += d.ing - d.gas));
  // Barras en su escala; la línea del ahorro acumulado, en la suya (su cifra va en la etiqueta).
  const max = Math.max(1, ...data.map(d => Math.max(d.ing, d.gas)));
  const Y = (v: number) => base - v / max * (base - top);
  const aMin = Math.min(0, ...accs), aMax = Math.max(1, ...accs);
  const YL = (v: number) => base - (v - aMin) / (aMax - aMin || 1) * (base - top);
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
    const t = svgEl("title", {}, g); t.textContent = `${mesNombre(k)} · ingresos ${eur(d.ing)} · gastos ${eur(d.gas)}`;
  });
  const pts = accs.map((v, i) => [l + i * gw + gw / 2, YL(v)]);
  svgEl("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: K.hi, "stroke-width": 1.6, pathLength: 1, class: "draw glow" }, svg);
  const [lx, ly] = pts[pts.length - 1];
  svgEl("rect", { x: lx - 2.5, y: ly - 2.5, width: 5, height: 5, fill: K.hi, class: "fade" }, svg);
  label(svg, Math.min(lx, r - 30), ly - 9, `${acc >= 0 ? "+" : ""}${eur(acc)}`, { "text-anchor": "middle", fill: K.hi, class: "fade money" });
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
  const s = saldos(list);
  const nombre = MESES[mesDe(mesSel).getMonth()];
  setM("saldo", s.hay ? eur(s.total) : "—");
  setM("saldo_d", s.hay ? (s.ahorro ? `cuenta ${eur(s.cuenta)} · hucha ${eur(s.ahorro)}` : `a ${ddmm(fechaDe(s.fecha!))}`) : has ? "el CSV no trae saldo" : "importa el CSV en F3");
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
  const colchon = s.hay && gasto6 > 0 ? s.total / gasto6 : null;
  setM("colchon", colchon === null ? "—" : `${fmt(colchon, 1)} meses`, colchon !== null && colchon < 1);
  setM("cats_h", `Gasto por categoría · ${nombre}`);
  setM("movs_h", `Movimientos · ${nombre}`);
  $("m-label").textContent = mesNombre(mesSel);
  ($("m-next") as HTMLButtonElement).disabled = mesSel >= fin;
  ($("m-prev") as HTMLButtonElement).disabled = !has || mesSel <= (conDatos[0] ?? mesSel);

  flow(meses, keys);
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
    rvMsg(`${fmt(r.leidos)} leídos · ${fmt(r.nuevos)} nuevos · ${fmt(r.actualizados)} actualizados${r.ignorados ? ` · ${r.ignorados} revertidos o rechazados, fuera` : ""}.`, "ok");
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
  if (!TAURI) { renderDinero({ movimientos: [], categorias: rvState.categorias, importado: null, archivo: null, banco: rvState.banco }); return; }
  try { renderDinero(await invoke<Dinero>("dinero_borrar")); rvMsg("Movimientos borrados de life.db. Las categorías que elegiste se conservan.", "ok"); }
  catch (err) { rvMsg(String(err), "err"); }
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
    banco: { configurado: true, conectado: true, app_id: "demo", valido_hasta: new Date(Date.now() + 172 * DIA).toISOString(), sincronizado: new Date().toISOString(), cuentas: 2, error: null } };
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
  if (!TAURI) { renderDinero(demoDinero()); renderGmail(demoGmail()); render(demo()); return; }
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
  // Las esperas («51 h») y el aviso de 48 h avanzan aunque no haya sincronización.
  setInterval(() => renderGmail(gmState), 5 * 60 * 1000);
} else {
  auto.disabled = true;
}

load();
