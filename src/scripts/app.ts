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
  lines.push(`<span class="off">Dinero: fase 2 (Revolut).</span>`);
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
  setE("cobrados_d", has ? `en ${now.getFullYear()} · importes en la fase 2` : "");

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

/* ---------- datos de ejemplo fuera de la app ---------- */
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
  if (!TAURI) { renderGmail(demoGmail()); render(demo()); return; }
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
  // Las esperas («51 h») y el aviso de 48 h avanzan aunque no haya sincronización.
  setInterval(() => renderGmail(gmState), 5 * 60 * 1000);
} else {
  auto.disabled = true;
}

load();
