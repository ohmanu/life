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
/** YouTube está montado pero oculto hasta que se conecte. Para volver a mostrarlo: true. */
const YOUTUBE = false;
if (!YOUTUBE) {
  document.querySelectorAll<HTMLElement>("[data-youtube]").forEach(n => n.remove());
  document.getElementById("ig-posts-cell")?.classList.replace("c-8", "c-12");
}
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
  // El sonido de cierre dura menos de un segundo: se espera a que acabe antes de esconder la ventana.
  $("w-close").addEventListener("click", async () => {
    const a = await sonar("cerrar", undefined, .6);
    if (a) await new Promise(r => { a.addEventListener("ended", r, { once: true }); setTimeout(r, 1100); });
    w.close();
  });
  $("app").addEventListener("dblclick", e => {
    if ((e.target as HTMLElement).closest("[data-tauri-drag-region]")) w.toggleMaximize();
  });
} else {
  $("demo").hidden = false;
}

/* ---------- cifras que cuentan ---------- */
/** Las cifras cuentan desde cero al cambiar de pestaña (`siempre`) o cuando cambian de valor;
 *  si una sincronización vuelve a pintar el mismo valor, no se repite la animación. */
function countUp(root: HTMLElement | null, siempre = false) {
  if (reduce || !root) return;
  root.querySelectorAll<HTMLElement>(".kpi .v").forEach(node => {
    // Si hay una animación a medias y nadie ha cambiado la cifra, el valor real es el que guardó.
    const texto = node.textContent ?? "";
    const original = node.dataset.anim && texto === node.dataset.frame ? node.dataset.final ?? texto : texto;
    if (node.dataset.anim) node.textContent = original;
    if (!siempre && node.dataset.visto === original) return;
    node.dataset.visto = original;
    const m = original.match(/\d[\d.]*(,\d+)?/);
    if (!m) return;
    const raw = m[0];
    const dec = (raw.split(",")[1] || "").length;
    const target = parseFloat(raw.replace(/\./g, "").replace(",", "."));
    const token = String(performance.now());
    node.dataset.anim = token;
    node.dataset.final = original;
    const t0 = performance.now();
    const step = (now: number) => {
      if (node.dataset.anim !== token) return; // otra animación la sustituyó
      const p = Math.min(1, (now - t0) / 950);
      const e = 1 - Math.pow(1 - p, 3);
      const f = p < 1 ? original.replace(raw, fmt(target * e, dec)) : original;
      node.textContent = f;
      node.dataset.frame = f;
      if (p < 1) requestAnimationFrame(step);
      else delete node.dataset.anim;
    };
    requestAnimationFrame(step);
  });
}

/* ---------- sonidos ---------- */
type Sonido = "pestana" | "encargo" | "graficas" | "inicio" | "error" | "radar" | "combo" | "cerrar" | "claude" | "hecho" | "eleccion";
const sonidosCache = new Map<Sonido, string>();
let sonidosOn = (() => { try { return localStorage.getItem("life-sonidos") !== "0"; } catch { return true; } })();

async function urlSonido(n: Sonido): Promise<string | null> {
  if (!TAURI) return null;
  const hecho = sonidosCache.get(n);
  if (hecho) return hecho;
  try {
    const buf = await invoke<ArrayBuffer>("sonido", { nombre: n });
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    sonidosCache.set(n, url);
    return url;
  } catch { return null; }
}

/** Reproduce un efecto. Con `max` (ms), se apaga suave al terminar las animaciones. */
async function sonar(n: Sonido, max?: number, volumen = .7) {
  if (!sonidosOn) return;
  const url = await urlSonido(n);
  if (!url) return;
  const a = new Audio(url);
  a.volume = volumen;
  a.play().catch(() => {});
  if (max) {
    setTimeout(() => {
      const paso = setInterval(() => {
        a.volume = Math.max(0, a.volume - .08);
        if (a.volume <= 0) { a.pause(); clearInterval(paso); }
      }, 30);
    }, max);
  }
  return a;
}
/** Las gráficas de dinero y de redes se animan ~1,6 s: el chaff suena mientras tanto. */
const sonarGraficas = () => sonar("graficas", 1500, .45);
/** La forma del radar entra a los 0,2 s (`radarIn`); suena con ella, una vez aunque se redibuje. */
let ultimoRadar = 0;
function sonarRadar() {
  if (Date.now() - ultimoRadar < 1500) return;
  ultimoRadar = Date.now();
  setTimeout(() => sonar("radar", undefined, .5), 200);
}

/* Error: un aviso que pasa a rojo (mensajes `.msg.err` y luces de fuente `.src.err`) o un «Desconectar». */
let ultimoError = 0;
function sonarError() {
  if (Date.now() - ultimoError < 1200) return;
  ultimoError = Date.now();
  sonar("error", undefined, .55);
}
new MutationObserver(rs => {
  for (const r of rs) {
    const el = r.target as Element;
    if (!el.classList.contains("err")) continue;
    // Los mensajes suenan cada vez que muestran un error; las luces, solo al pasar a error.
    if (el.classList.contains("msg") || (el.classList.contains("src") && !/\berr\b/.test(r.oldValue ?? ""))) { sonarError(); return; }
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
document.addEventListener("click", e => { if ((e.target as Element).closest?.('#v-conexiones button.danger[id$="-off"]')) sonarError(); });

/* Combos: suena al abrirse y al elegir. */
document.addEventListener("pointerdown", e => { if ((e.target as Element).closest?.("select:not(:disabled)")) sonar("combo", undefined, .5); });
document.addEventListener("keydown", e => {
  if (e.target instanceof HTMLSelectElement && (e.key === " " || e.key === "F4" || (e.altKey && e.key === "ArrowDown"))) sonar("combo", undefined, .5);
});
document.addEventListener("change", e => { if (e.target instanceof HTMLSelectElement) sonar("eleccion", undefined, .6); }, true);

/* Preguntar a LIFE y regenerar el parte: selección del códec. */
$("ask-form").addEventListener("submit", () => sonar("claude", undefined, .6), true);
$("parte-regen").addEventListener("click", () => sonar("claude", undefined, .6), true);

/* ---------- pestañas ---------- */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')];
function select(tab: HTMLButtonElement, silencio = false) {
  const vista = tab.getAttribute("aria-controls");
  const cambia = tab.getAttribute("aria-selected") !== "true";
  if (!silencio && cambia) {
    sonar("pestana", undefined, .6);
    if (vista === "v-dinero" || vista === "v-redes") sonarGraficas();
    if (vista === "v-hoy" && radarState.length) sonarRadar();
  }
  if (vista === "v-redes") cargarTokens();
  tabs.forEach(t => {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")!).hidden = !on;
  });
  countUp($(tab.getAttribute("aria-controls")!), true);
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
  heatGastos();
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

/* ---------- radar de vida ---------- */
type Semana = { semana: string; valores: Record<string, number>; nota: string; guardado: string };
const EJES: [string, string][] = [["trabajo", "TRABAJO"], ["dinero", "DINERO"], ["creacion", "CREACIÓN"], ["cuerpo", "CUERPO"], ["gente", "GENTE"], ["descanso", "DESCANSO"]];
let radarState: Semana[] = [];

/** Semana ISO («2026-W47») y sus lunes y domingo. */
function semanaIso(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dia);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DIA + 1) / 7);
  const lunes = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() || 7) - 1));
  const domingo = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + 6);
  return { id: `${y}-W${pad(w)}`, w, lunes, domingo };
}
const semanaPrevia = (id: string) => radarState.filter(s => s.semana < id).pop();

function dibujarRadar() {
  const svg = $("radar") as unknown as SVGSVGElement;
  svg.replaceChildren();
  const cx = 150, cy = 150, R = 105, n = EJES.length;
  const pt = (i: number, v: number) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 10, cy + Math.sin(a) * R * v / 10]; };
  const spin = svgEl("g", { class: "spin" }, svg);
  for (let d = 0; d < 360; d += 10) {
    const a = d * Math.PI / 180, r1 = R + 6, r2 = R + (d % 30 ? 9 : 13);
    svgEl("line", { x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1, x2: cx + Math.cos(a) * r2, y2: cy + Math.sin(a) * r2, stroke: K.grid, "stroke-width": 1 }, spin);
  }
  for (let k = 1; k <= 5; k++) svgEl("circle", { cx, cy, r: R * k / 5, fill: "none", stroke: K.grid, "stroke-width": k === 5 ? 1.2 : .7 }, svg);
  const actual = semanaIso().id;
  const cur = radarState.find(s => s.semana === actual) ?? radarState[radarState.length - 1];
  const prev = cur ? semanaPrevia(cur.semana) : undefined;
  EJES.forEach(([k, nombre], i) => {
    const [x, y] = pt(i, 10);
    svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: K.grid, "stroke-width": .7 }, svg);
    const [lx, ly] = pt(i, 13.4);
    const t = label(svg, lx, ly + 4, nombre, { "text-anchor": "middle", fill: K.text, "letter-spacing": 1, "data-rotulo": k });
    if (cur) {
      const v = cur.valores[k] ?? 0, p = prev?.valores[k];
      t.textContent = `${nombre} ${v}`;
      if (p !== undefined && v - p <= -2) t.setAttribute("fill", K.alert);
    }
    t.dataset.color = t.getAttribute("fill") ?? K.text;
  });
  const sw = svgEl("g", { class: "sweep" }, svg);
  const ex = cx - R * Math.sin(Math.PI / 5), ey = cy - R * Math.cos(Math.PI / 5);
  svgEl("path", { d: `M${cx} ${cy}L${cx} ${cy - R}A${R} ${R} 0 0 0 ${ex} ${ey}Z`, fill: K.ph, opacity: .14 }, sw);
  svgEl("line", { x1: cx, y1: cy, x2: cx, y2: cy - R, stroke: K.ph, "stroke-width": 1.2, opacity: .85 }, sw);
  if (!cur) {
    svgEl("circle", { cx, cy, r: 2.5, fill: K.ph }, svg);
    label(svg, cx, cy + 22, "SIN SEÑAL", { "text-anchor": "middle", fill: K.ph, class: "blink", "letter-spacing": 2 });
  } else {
    const poly = (s: Semana) => EJES.map(([k], i) => pt(i, s.valores[k] ?? 0).join(",")).join(" ");
    if (prev) svgEl("polygon", { points: poly(prev), fill: "none", stroke: K.text, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: .6 }, svg);
    const g = svgEl("g", { class: "radar-shape" }, svg);
    svgEl("polygon", { points: poly(cur), fill: K.ph, "fill-opacity": .22, stroke: K.ph, "stroke-width": 1.6, class: "glow" }, g);
    EJES.forEach(([k], i) => { const [x, y] = pt(i, cur.valores[k] ?? 0); svgEl("rect", { x: x - 2.5, y: y - 2.5, width: 5, height: 5, fill: K.hi }, g); });
    if (!$("v-hoy").hidden && document.visibilityState === "visible") sonarRadar();
    // Zonas invisibles por eje (encima de todo): al pasar el ratón o llegar con el tabulador, su motivo.
    EJES.forEach(([k, nombre], i) => {
      const a0 = -Math.PI / 2 + (i - .5) * 2 * Math.PI / n, a1 = -Math.PI / 2 + (i + .5) * 2 * Math.PI / n, RR = R * 1.55;
      svgEl("path", {
        d: `M${cx} ${cy}L${cx + Math.cos(a0) * RR} ${cy + Math.sin(a0) * RR}A${RR} ${RR} 0 0 1 ${cx + Math.cos(a1) * RR} ${cy + Math.sin(a1) * RR}Z`,
        fill: "transparent", "data-eje": k, tabindex: 0, class: "radar-eje", role: "button",
        "aria-label": `${nombre.toLowerCase()} ${cur.valores[k] ?? 0}: ${notaRadar(cur).razones[k] ?? "sin motivo guardado"}`,
      }, svg);
    });
  }
  svg.setAttribute("aria-label", cur ? `Radar de vida, ${cur.semana}: ` + EJES.map(([k, n]) => `${n.toLowerCase()} ${cur.valores[k]}`).join(", ") : "Radar de vida sin datos todavía");

  // Pie: semana mostrada y el eje que más cambió.
  const foot = $("radar-foot");
  if (!cur) { foot.textContent = "SIN SEÑAL · PUNTÚA TU SEMANA"; foot.className = ""; }
  else {
    const num = cur.semana.slice(6);
    let txt = `SEMANA ${+num}${cur.semana === actual ? "" : " · LA ÚLTIMA"}`;
    let alarma = false;
    if (prev) {
      const cambios = EJES.map(([k, nm]) => [nm, (cur.valores[k] ?? 0) - (prev.valores[k] ?? 0)] as [string, number]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      const [nm, d] = cambios[0];
      if (d) { txt += ` · ${nm} ${d > 0 ? "↑" : "↓"} ${Math.abs(d)}`; alarma = d <= -2; }
    }
    foot.textContent = txt;
    foot.className = alarma ? "alarm" : "";
  }
  $("radar-recalc").hidden = !(TAURI && clState?.sesion);
  if (!radarCalculando) {
    const n = notaRadar(cur);
    radarNotaBase = cur
      ? `${esc(n.resumen)}${n.resumen ? " " : ""}<span class="muted">· CLAUDE ${stamp(cur.guardado)}</span>`
      : TAURI && clState?.sesion ? `<span class="muted">CLAUDE PUNTUARÁ LA SEMANA TRAS EL PARTE DE HOY</span>` : `<span class="muted">NECESITA CLAUDE (F5)</span>`;
    $("radar-nota").innerHTML = radarNotaBase;
  }
  historial();
}

/** Línea bajo el radar cuando no hay ningún eje señalado (resumen de la semana). */
let radarNotaBase = "";
/** Motivo de un eje bajo el radar, con su rótulo iluminado; sin eje, vuelve el resumen. */
function mostrarEje(k: string | null) {
  document.querySelectorAll<SVGTextElement>("#radar [data-rotulo]").forEach(t => t.setAttribute("fill", t.dataset.rotulo === k ? K.hi : t.dataset.color ?? K.text));
  if (!k || radarCalculando) { $("radar-nota").innerHTML = radarNotaBase; return; }
  const actual = semanaIso().id;
  const cur = radarState.find(s => s.semana === actual) ?? radarState[radarState.length - 1];
  if (!cur) return;
  const prev = semanaPrevia(cur.semana);
  const nombre = EJES.find(([e]) => e === k)?.[1] ?? k;
  const v = cur.valores[k] ?? 0, d = prev ? v - (prev.valores[k] ?? 0) : 0;
  const razon = notaRadar(cur).razones[k];
  $("radar-nota").innerHTML = `<b class="${d <= -2 ? "alarm" : ""}">${nombre} ${v}${d ? ` ${d > 0 ? "↑" : "↓"}${Math.abs(d)}` : ""}</b> · ${razon ? esc(razon) : `<span class="muted">sin motivo guardado</span>`}`;
}
{
  const svgR = $("radar");
  const eje = (e: Event) => (e.target as Element).closest?.("[data-eje]")?.getAttribute("data-eje") ?? null;
  svgR.addEventListener("pointerover", e => mostrarEje(eje(e)));
  svgR.addEventListener("pointerleave", () => mostrarEje(null));
  svgR.addEventListener("focusin", e => mostrarEje(eje(e)));
  svgR.addEventListener("focusout", () => mostrarEje(null));
}

/** La forma de las últimas 8 semanas, en pequeño. */
function historial() {
  const svg = $("radar-hist") as unknown as SVGSVGElement;
  svg.replaceChildren();
  const ult = radarState.slice(-8);
  if (!ult.length) return;
  const w = 300 / 8, r = 15;
  ult.forEach((s, j) => {
    const cx = (8 - ult.length + j) * w + w / 2, cy = 20;
    const g = svgEl("g", {}, svg);
    svgEl("circle", { cx, cy, r, fill: "none", stroke: K.grid, "stroke-width": .6 }, g);
    const pts = EJES.map(([k], i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / EJES.length, v = (s.valores[k] ?? 0) / 10; return `${cx + Math.cos(a) * r * v},${cy + Math.sin(a) * r * v}`; }).join(" ");
    svgEl("polygon", { points: pts, fill: K.ph, "fill-opacity": j === ult.length - 1 ? .5 : .2, stroke: K.ph, "stroke-width": .8 }, g);
    label(g, cx, 43, `S${+s.semana.slice(6)}`, { "text-anchor": "middle", "font-size": 7.5 });
    g.appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: `${s.semana}: ${EJES.map(([k, n]) => `${n.toLowerCase()} ${s.valores[k]}`).join(", ")}${s.nota ? ` · ${s.nota}` : ""}` }));
  });
}

/** Resumen y motivos que guardó Claude en la nota de la semana. */
function notaRadar(s: Semana | undefined): { resumen: string; razones: Record<string, string> } {
  if (!s?.nota) return { resumen: "", razones: {} };
  try {
    const v = JSON.parse(s.nota);
    return { resumen: typeof v.resumen === "string" ? v.resumen : "", razones: v.razones && typeof v.razones === "object" ? v.razones : {} };
  } catch { return { resumen: s.nota, razones: {} }; }
}

/** Datos extra para puntuar la semana: actividad por día y gasto de 7 días por categoría. */
function contextoRadar() {
  const base = JSON.parse(contexto());
  const gh = ghState.snapshot;
  const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const actividad = gh?.days.slice(-14).map(d => ({ fecha: d.date, dia: dias[new Date(d.date + "T00:00:00").getDay()], contribuciones: d.count }));
  const g7: Record<string, number> = {};
  for (const m of rvState.movimientos) {
    if (Date.now() - fechaDe(m.fecha).getTime() > 7 * DIA || !cuenta(m) || m.importe >= 0) continue;
    const c = catOf(m);
    g7[c] = r1((g7[c] ?? 0) - m.importe);
  }
  return JSON.stringify({ ...base, actividad_github_14d: actividad, gastos_7d_por_categoria: g7 });
}

let radarCalculando = false;
async function radarAuto() {
  if (!TAURI || radarCalculando) return;
  radarCalculando = true;
  const b = $<HTMLButtonElement>("radar-recalc");
  b.disabled = true;
  $("radar-nota").innerHTML = `<span class="blink">CLAUDE PUNTUANDO LA SEMANA…</span>`;
  try { radarState = await invoke<Semana[]>("radar_auto", { contexto: contextoRadar() }); }
  catch (err) { clError = String(err); ultimoFallo = Date.now(); }
  finally { radarCalculando = false; b.disabled = false; dibujarRadar(); brief(); }
}
$("radar-recalc").addEventListener("click", radarAuto);

function briefRadar(lines: string[]) {
  const cur = radarState[radarState.length - 1];
  const prev = cur ? semanaPrevia(cur.semana) : undefined;
  if (!cur || !prev) return;
  const bajan = EJES.filter(([k]) => (cur.valores[k] ?? 0) - (prev.valores[k] ?? 0) <= -2).map(([, n]) => n.toLowerCase());
  if (bajan.length) lines.push(`Radar: <span class="alarm">${bajan.join(" y ")} ${bajan.length === 1 ? "baja" : "bajan"}</span> 2 puntos o más respecto a la semana anterior.`);
}

function demoRadar(): Semana[] {
  const out: Semana[] = [];
  const hoy = new Date();
  for (let i = 7; i >= 1; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - i * 7);
    const f = (b: number, a: number) => Math.max(0, Math.min(10, Math.round(b + Math.sin(i * a) * 2)));
    out.push({ semana: semanaIso(d).id, valores: { trabajo: f(7, 1.3), dinero: f(6, .7), creacion: f(6, 2.1), cuerpo: f(4, 1.7), gente: f(5, .9), descanso: f(i === 1 ? 6 : 5, 2.5) }, nota: "", guardado: d.toISOString() });
  }
  out[out.length - 1].valores.descanso = 3;
  out[out.length - 1].nota = JSON.stringify({
    resumen: "Semana de mucho código y encargos, con poco descanso.",
    razones: { trabajo: "Racha de 12 días y dos encargos en marcha.", dinero: "Ahorras un 28 % este mes.", creacion: "Dos publicaciones con buen alcance.", cuerpo: "Sin señales de deporte.", gente: "Dos cenas fuera.", descanso: "Código también el fin de semana." },
  });
  return out;
}

/* ---------- GitHub: pintar ---------- */
function setText(key: string, value: string) {
  document.querySelectorAll<HTMLElement>(`[data-k="${key}"]`).forEach(n => (n.textContent = value));
}

/** Cuadrícula de un año por días (como la de GitHub). `tip` da el texto de cada cuadro. */
function heat(days: Day[], id = "heat", vacio = "SIN DATOS · CONECTA GITHUB EN F5", tip: (d: Day) => string = d => `${d.date} · ${d.count}`) {
  const svg = $(id) as unknown as SVGSVGElement;
  svg.replaceChildren();
  const s = 12, g = 2, x0 = 30, y0 = 18, op = [0, .25, .5, .75, 1];
  if (!days.length) { label(svg, x0, 60, vacio, { fill: K.grid }); return; }
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
    }, svg).appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: tip(d) }));
  });
  const n = days.length - 1 + offset;
  svgEl("rect", { x: x0 + Math.floor(n / 7) * (s + g) - 1.5, y: y0 + (n % 7) * (s + g) - 1.5, width: s + 3, height: s + 3, fill: "none", stroke: K.hi, "stroke-width": 1.5, class: "blink" }, svg);
}

/** Los últimos 365 días (fecha local AAAA-MM-DD), del más antiguo a hoy. */
function ultimoAno() {
  const hoy = new Date();
  return Array.from({ length: 365 }, (_, i) => {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 364 + i);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
}
/** Nivel 1–4 por cuartiles de los días con actividad (0 = nada). */
function niveles(valores: number[]) {
  const nz = valores.filter(v => v > 0).sort((a, b) => a - b);
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const [q1, q2, q3] = nz.length ? [q(.25), q(.5), q(.75)] : [0, 0, 0];
  return valores.map(v => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4));
}
const fechaLarga = (f: string) => new Date(f + "T00:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** Gastos por día del último año: color por total gastado, con número de gastos y total. */
function heatGastos() {
  const list = rvState.movimientos;
  const foot = $("heat-gas-foot");
  if (!list.length) { heat([], "heat-gas", "SIN DATOS · CONECTA REVOLUT EN F5"); foot.textContent = ""; return; }
  const dias = ultimoAno();
  const por = new Map<string, { n: number; total: number }>();
  for (const m of list) {
    if (m.importe >= 0 || !cuenta(m) || esIngreso(catOf(m))) continue;
    const f = m.fecha.slice(0, 10);
    const x = por.get(f) ?? por.set(f, { n: 0, total: 0 }).get(f)!;
    x.n++; x.total += -m.importe + m.comision;
  }
  const tot = dias.map(f => por.get(f)?.total ?? 0);
  const lv = niveles(tot);
  const ver = $("app").classList.contains("private");
  heat(dias.map((f, i) => ({ date: f, count: por.get(f)?.n ?? 0, level: lv[i] })), "heat-gas", "", d => {
    const x = por.get(d.date);
    return x ? `${fechaLarga(d.date)} · ${x.n} gasto${x.n === 1 ? "" : "s"} · ${ver ? "•••" : eur(x.total, 2)}` : `${fechaLarga(d.date)} · sin gastos`;
  });
  const conGasto = dias.filter(f => por.has(f)).length;
  foot.textContent = `${conGasto} DÍAS CON GASTOS DE 365`;
}

/** Publicaciones e historias de Instagram por día del último año. */
function heatPublicaciones() {
  const ig = igState.snapshot;
  const foot = $("heat-ig-foot");
  if (!ig) { heat([], "heat-ig", igState.connected ? "SINCRONIZANDO…" : "SIN DATOS · CONECTA INSTAGRAM EN F5"); foot.textContent = ""; return; }
  const por = new Map((ig.actividad ?? []).map(d => [d.fecha, d]));
  const dias = ultimoAno();
  const n = dias.map(f => { const x = por.get(f); return x ? x.posts + x.historias : 0; });
  const lv = niveles(n);
  heat(dias.map((f, i) => ({ date: f, count: n[i], level: lv[i] })), "heat-ig", "", d => {
    const x = por.get(d.date);
    if (!x || !d.count) return `${fechaLarga(d.date)} · nada publicado`;
    return `${fechaLarga(d.date)} · ${[x.posts ? `${x.posts} publicaci${x.posts === 1 ? "ón" : "ones"}` : "", x.historias ? `${x.historias} historia${x.historias === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}`;
  });
  const posts = dias.reduce((s, f) => s + (por.get(f)?.posts ?? 0), 0);
  const hist = dias.reduce((s, f) => s + (por.get(f)?.historias ?? 0), 0);
  foot.textContent = `${posts} PUBLICACIONES · ${hist} HISTORIAS EN 365 DÍAS`;
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

function briefGitHub(lines: string[]) {
  const gh = ghState.snapshot;
  if (!gh) {
    lines.push(ghState.connected ? "GitHub conectado. Sincronizando…" : `GitHub sin conectar. Ve a <b>F5 · Conexiones</b> y pega un token de solo lectura.`);
    return;
  }
  const last = gh.repos[0];
  lines.push(`GitHub: racha de <b>${gh.streak} ${gh.streak === 1 ? "día" : "días"}</b> y <b>${fmt(gh.last_90)}</b> contribuciones en 90 días.`
    + (last ? ` Último push en <b>${last.name}</b> ${rel(last.pushed_at)}.` : ""));
  const extra: string[] = [];
  if (gh.open_prs || gh.open_issues) extra.push(`<span class="hot">${gh.open_prs} PR${gh.open_prs === 1 ? "" : "s"} y ${gh.open_issues} issue${gh.open_issues === 1 ? "" : "s"}</span> abiertos`);
  const dormant = gh.repos.filter(r => daysAgo(r.pushed_at) > 21).slice(0, 2);
  if (dormant.length) extra.push(dormant.map(r => `<b>${r.name}</b> lleva <span class="hot">${daysAgo(r.pushed_at)} días</span> sin tocarse`).join(" · "));
  if (extra.length) lines.push(extra.join(" · ") + ".");
}

/** El parte se pinta una vez por vuelta y solo si cambia (si no, la animación de escritura se reinicia). */
let briefPendiente = false;
let briefHtml = "";
function brief() {
  if (briefPendiente) return;
  briefPendiente = true;
  queueMicrotask(() => {
    briefPendiente = false;
    const lines: string[] = [];
    briefEncargos(lines);
    briefDinero(lines);
    briefInstagram(lines);
    if (YOUTUBE) briefYouTube(lines);
    briefRadar(lines);
    briefGitHub(lines);
    // El parte de Claude manda si está activo y es de hoy; si no, el parte local de siempre.
    const p = parteActual();
    const vistas = p ? lineasClaude(p.texto) : lines;
    const html = vistas.map((l, i) => `<li data-k="${pad(i + 1)}" style="--i:${i}"><span>${l}</span></li>`).join("");
    if (html !== briefHtml) { $("brief").innerHTML = html; briefHtml = html; }
    const last = [ghState.snapshot?.synced_at, gmState.synced_at, igState.snapshot?.synced_at, rvState.banco?.sincronizado].filter(Boolean).sort().pop();
    if (!generando) {
      $("parte-origen").textContent = p
        ? `CLAUDE · ${(clState?.modelo ?? "sonnet").toUpperCase()}${p.tipo === "semanal" ? " · SEMANA" : ""}`
        : clState?.activo && clState.sesion && clError ? "GENERADO EN LOCAL · CLAUDE NO RESPONDIÓ" : "GENERADO EN LOCAL";
    }
    $("brief-time").textContent = p ? `ESCRITO ${stamp(p.generado)}` : last ? `ACTUALIZADO ${stamp(last!)}` : "";
  });
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
  const desc = list.filter(e => e.estado === "descartado").length;
  if (!desc) verDescartados = false;
  el.classList.toggle("con-desc", verDescartados);
  el.innerHTML = [...COLUMNAS, ...(verDescartados ? ["descartado"] : [])].map(col => {
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
  $("enc-foot").textContent = `GMAIL · SOLO LECTURA · CADA 10 MIN${desc ? ` · ${desc} DESCARTADO${desc === 1 ? "" : "S"}` : ""}`;
  const b = $<HTMLButtonElement>("enc-desc");
  b.hidden = !desc;
  b.textContent = verDescartados ? "Ocultar descartados" : "Ver descartados";
  b.setAttribute("aria-pressed", String(verDescartados));
}
/** Los descartados no tienen columna fija: «Ver descartados» la añade al final del tablero. */
let verDescartados = false;
$("enc-desc").addEventListener("click", () => { verDescartados = !verDescartados; board(gmState.encargos); });

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
    <div class="estados"><button type="button" class="btn" id="enc-open">Abrir en Gmail</button><button type="button" class="btn danger" id="enc-del">Borrar</button><span class="msg" id="enc-msg"></span></div>`;
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
  if (t.id === "enc-del") {
    // Dos pasos: el primer clic pide confirmar.
    if (t.dataset.confirmar !== "1") {
      t.dataset.confirmar = "1";
      t.textContent = "Sí, borrar para siempre";
      encMsg("Se borra de LIFE (en Gmail no se toca nada) y no se vuelve a leer.", "err");
      setTimeout(() => { if (t.isConnected) { delete t.dataset.confirmar; t.textContent = "Borrar"; encMsg(""); } }, 6000);
      return;
    }
    selected = null;
    if (!TAURI) { renderGmail({ ...gmState, encargos: gmState.encargos.filter(x => x.id !== id) }); return; }
    try { renderGmail(await invoke<Gmail>("encargo_borrar", { id })); }
    catch (err) { selected = id; encMsg(String(err), "err"); }
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
  online: number[]; historia: IgDia[]; actividad?: { fecha: string; posts: number; historias: number }[]; synced_at: string;
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
  heatPublicaciones();
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
  const actividad = Array.from({ length: 365 }, (_, i) => ({ fecha: dia(364 - i), posts: rnd() < .1 ? 1 + Math.floor(rnd() * 2) : 0, historias: i > 300 && rnd() < .35 ? 1 + Math.floor(rnd() * 5) : 0 }))
    .filter(d => d.posts || d.historias);
  return {
    connected: true,
    snapshot: {
      username: "ejemplo", name: "Ejemplo", followers: 1222, follows: 310, media_count: 214, posts, reach,
      reach_30: 9840, views_30: 31200, engaged_30: 612, interactions_30: 1890, online, historia, actividad, synced_at: new Date().toISOString(),
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

$("yt-videos")?.addEventListener("click", async e => {
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
$("yt-form")?.addEventListener("submit", e => {
  e.preventDefault();
  const id = $<HTMLInputElement>("yt-id"), secret = $<HTMLInputElement>("yt-secret");
  ytAccion($<HTMLButtonElement>("yt-save"), "Guardando…", () => invoke<YtView>("youtube_configurar", { clientId: id.value, secret: secret.value }),
    () => { id.value = ""; secret.value = ""; return "Cliente guardado en las credenciales de Windows. Ahora pulsa Conectar con YouTube."; });
});
$("yt-connect")?.addEventListener("click", () =>
  ytAccion($<HTMLButtonElement>("yt-connect"), "Da permiso en el navegador que se ha abierto (Google avisará de que la app no está verificada: es la tuya)…",
    () => invoke<YtView>("youtube_conectar"), v => `Conectado${v.snapshot ? ` · ${v.snapshot.channel}` : ""}.`));
$("yt-sync-btn")?.addEventListener("click", () =>
  ytAccion($<HTMLButtonElement>("yt-sync-btn"), "Leyendo YouTube…", () => invoke<YtView>("youtube_sync"), () => "Sincronizado."));
$("yt-off")?.addEventListener("click", () => {
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

/* ---------- claude: parte y preguntas ---------- */
type Parte = { fecha: string; tipo: string; texto: string; generado: string };
type ClaudeView = { instalado: boolean; sesion: boolean; metodo: string | null; activo: boolean; modelo: string; diario: Parte | null; semanal: Parte | null };
let clState: ClaudeView | null = null;
let parteVista: "diario" | "semanal" = "diario";
let datosListos = false;
let generando = false;
let ultimoFallo = 0;
let clError = "";

const hoyStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const r1 = (n: number) => Math.round(n * 100) / 100;

/** Lo que se le cuenta a Claude: cifras y estados, sin nombres, correos ni teléfonos de clientes. */
function contexto() {
  const ahora = new Date();
  const enc = gmState.encargos;
  const encargos = {
    sin_responder: enc.filter(sinResponder).map(e => ({ tipo: e.tipo, que: e.que, horas_esperando: Math.round(hoursSince(e.recibido)), presupuesto: e.presupuesto || undefined })),
    abiertos_por_estado: Object.fromEntries(COLUMNAS.map(c => [c, enc.filter(e => e.estado === c).length])),
    este_mes: enc.filter(e => e.recibido.slice(0, 7) === mesKey(ahora)).length,
    ultimos_12_meses: enc.filter(e => Date.now() - new Date(e.recibido).getTime() < 365 * DIA).length,
  };
  let dinero: Record<string, unknown> | undefined;
  if (rvState.movimientos.length) {
    const meses = porMes(rvState.movimientos);
    const keys = [...meses.keys()].sort().slice(-13);
    const s = saldos(rvState.movimientos, rvState.patrimonio ?? SIN_PATRIMONIO);
    const mes = mesKey(ahora);
    const gastosMes = rvState.movimientos
      .filter(m => m.fecha.startsWith(mes) && cuenta(m) && !esIngreso(catOf(m)) && m.importe < 0)
      .sort((a, b) => a.importe - b.importe).slice(0, 15)
      .map(m => ({ fecha: m.fecha.slice(0, 10), comercio: m.descripcion, importe: r1(-m.importe), categoria: catOf(m) }));
    // Comercios del último año con la categoría que usa LIFE (la tuya si la elegiste a mano).
    const desde = Date.now() - 365 * DIA;
    const porComercio = new Map<string, { comercio: string; categoria: string; veces: number; total: number; ultimo: string }>();
    for (const m of rvState.movimientos) {
      if (!cuenta(m) || fechaDe(m.fecha).getTime() < desde) continue;
      const c = porComercio.get(m.comercio) ?? porComercio.set(m.comercio, { comercio: m.descripcion, categoria: catOf(m), veces: 0, total: 0, ultimo: "" }).get(m.comercio)!;
      c.veces++; c.total += m.importe; c.ultimo = m.fecha.slice(0, 10);
    }
    const comercios = [...porComercio.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 150)
      .map(c => ({ ...c, total: r1(c.total) }));
    const manual = Object.entries(rvState.categorias).map(([k, categoria]) => {
      const [com, concepto] = k.split(SEP_CONCEPTO);
      return { comercio: rvState.movimientos.find(m => m.comercio === com)?.descripcion ?? com, ...(concepto ? { solo_con_concepto: concepto } : {}), categoria };
    });
    dinero = {
      moneda: "EUR",
      nota_categorias: "La categoría de cada movimiento es la que usa LIFE: la que el usuario eligió a mano manda; si no, reglas automáticas. Usa estas categorías (por ejemplo, «Suscripciones») tal cual.",
      categorias_elegidas_a_mano: manual,
      comercios_ultimo_ano: comercios,
      suscripciones_cobradas_por_mes: keys.map(k => {
        const ms = subsDelMes(rvState.movimientos, k);
        return { mes: k, total: r1(ms.reduce((s, m) => s - m.importe, 0)), cargos: ms.map(m => ({ fecha: m.fecha.slice(0, 10), nombre: nombreSub(m), importe: r1(-m.importe) })) };
      }),
      patrimonio: { total: r1(s.total), cuenta: r1(s.cuenta), hucha_estimada: r1(s.ahorro), oro: r1(s.oro) },
      por_mes: keys.map(k => { const m = meses.get(k)!; return { mes: k, ingresos: r1(m.ing), gastos: r1(m.gas), por_categoria: Object.fromEntries([...m.cats].map(([c, v]) => [c, r1(v)])) }; }),
      gastos_mayores_este_mes: gastosMes,
      suscripciones_activas: subsCache.map(x => ({ nombre: x.nombre, cada: x.cada, importe: r1(x.importe), proximo_cobro: `${x.proximo.getFullYear()}-${pad(x.proximo.getMonth() + 1)}-${pad(x.proximo.getDate())}`, subida: x.sube ? r1(x.sube) : undefined })),
    };
  }
  const ig = igState.snapshot;
  const instagram = ig ? {
    seguidores: ig.followers, historia_seguidores: ig.historia.slice(-30), alcance_30d: ig.reach_30, visualizaciones_30d: ig.views_30,
    interacciones_30d: ig.interactions_30, cuentas_que_interactuan_30d: ig.engaged_30,
    publicaciones: ig.posts.slice(0, 15).map(p => ({ fecha: p.timestamp.slice(0, 10), tipo: p.product, texto: p.caption.slice(0, 80), alcance: p.reach, vistas: p.views, me_gusta: p.likes, comentarios: p.comments, guardados: p.saved, compartidos: p.shares })),
  } : undefined;
  const gh = ghState.snapshot;
  const github = gh ? {
    racha_dias: gh.streak, record_racha: gh.longest, contribuciones_90d: gh.last_90, contribuciones_ano: gh.total_year,
    contribuciones_7d: gh.days.slice(-7).reduce((s, d) => s + d.count, 0), prs_abiertos: gh.open_prs, issues_abiertos: gh.open_issues,
    repos: gh.repos.map(r => ({ nombre: r.name, ultimo_push: r.pushed_at.slice(0, 10) })),
  } : undefined;
  const radar = radarState.slice(-8).map(s => ({ semana: s.semana, ...s.valores, nota: s.nota || undefined }));
  return JSON.stringify({ encargos, dinero, instagram, github, radar_vida: radar.length ? radar : undefined });
}

/** Texto de Claude → líneas del parte: **negrita** y «!» al principio para alarmas. */
function lineasClaude(texto: string) {
  return texto.split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "").trim()).filter(Boolean).slice(0, 9).map(l => {
    const alarma = l.startsWith("!");
    const html = esc(alarma ? l.slice(1).trim() : l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    return alarma ? `<span class="alarm">${html}</span>` : html;
  });
}

/** El parte que toca enseñar, si Claude está activo y lo hay. */
function parteActual(): Parte | null {
  if (!clState?.activo) return null;
  if (parteVista === "semanal" && clState.semanal) return clState.semanal;
  const d = clState.diario;
  return d && d.fecha === hoyStr() ? d : null;
}

function renderParteControles() {
  const s = clState;
  const semanalReciente = !!s?.activo && !!s.semanal && Date.now() - new Date(s.semanal.fecha + "T00:00:00").getTime() < 2 * DIA;
  $("parte-tabs").hidden = !semanalReciente;
  if (!semanalReciente && parteVista === "semanal") parteVista = "diario";
  document.querySelectorAll<HTMLElement>("[data-parte]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.parte === parteVista)));
  $("parte-h").textContent = parteVista === "semanal" ? "Parte de la semana" : "Parte del día";
  $("parte-regen").hidden = !(TAURI && s?.sesion && s.activo);
}

async function generarParte(tipo: "diario" | "semanal", aMano = false) {
  if (!TAURI || generando) return;
  generando = true;
  $("parte-origen").textContent = "CLAUDE ESCRIBIENDO…";
  if (aMano) { const b = $<HTMLButtonElement>("parte-regen"); b.disabled = true; }
  try {
    const p = await invoke<Parte>("parte_generar", { tipo, contexto: contexto() });
    if (clState) clState = { ...clState, [tipo]: p };
    if (tipo === "semanal") parteVista = "semanal";
    clError = "";
  } catch (err) {
    clError = String(err);
    ultimoFallo = Date.now();
  } finally {
    generando = false;
    $<HTMLButtonElement>("parte-regen").disabled = false;
    renderParteControles();
    brief();
    renderClaude();
  }
}

/** Cada minuto: a partir de las 7:30, el parte del día (y el domingo, el semanal) si aún no está. */
async function programarParte() {
  const s = clState;
  if (!TAURI || !datosListos || generando || !s?.sesion || !s.activo) return;
  if (Date.now() - ultimoFallo < 30 * 60 * 1000) return;
  const ahora = new Date();
  if (ahora.getHours() * 60 + ahora.getMinutes() < 7 * 60 + 30) return;
  const hoy = hoyStr();
  if (s.diario?.fecha !== hoy) { await generarParte("diario"); return; }
  if (ahora.getDay() === 0 && s.semanal?.fecha !== hoy) { await generarParte("semanal"); return; }
  // Radar: Claude puntúa la semana en curso una vez al día, después del parte.
  const sem = radarState.find(x => x.semana === semanaIso().id);
  const hoyRadar = sem ? (() => { const g = new Date(sem.guardado); return `${g.getFullYear()}-${pad(g.getMonth() + 1)}-${pad(g.getDate())}`; })() : "";
  if (hoyRadar !== hoy) await radarAuto();
}

function renderClaude() {
  const s = clState;
  const st = $("cl-state");
  st.textContent = !s ? "Comprobando…" : !s.instalado ? "No instalado" : !s.sesion ? "Sin sesión" : s.activo ? "Activo" : "En pausa";
  st.className = "state" + (s?.sesion && s.activo ? " on" : s && (!s.instalado || !s.sesion) ? " err" : "");
  $<HTMLInputElement>("cl-activo").checked = !!s?.activo;
  $<HTMLSelectElement>("cl-modelo").value = s?.modelo ?? "sonnet";
  $<HTMLButtonElement>("cl-probar").disabled = !s?.sesion;
  if (clError) { const m = $("cl-msg"); m.textContent = clError; m.className = "msg err"; }
  // Preguntas
  const listo = !!s?.sesion;
  $<HTMLButtonElement>("ask-go").disabled = !listo;
  $<HTMLInputElement>("ask-q").disabled = !listo;
  $("ask-foot").textContent = !TAURI ? "EN MODO DEMO NO SE PREGUNTA A CLAUDE" : listo ? "CLAUDE RESPONDE CON TUS DATOS DE LIFE · NO GUARDA LA PREGUNTA" : "INICIA SESIÓN EN CLAUDE CODE (F5 → CLAUDE) PARA PREGUNTAR";
  const src = document.getElementById("src-claude");
  if (src) { src.className = "src" + (s?.sesion && s.activo ? " on" : TAURI && s && !s.sesion ? " err" : ""); src.title = s?.sesion ? "Claude Code con sesión" : "Claude Code sin sesión"; }
}

async function cargarClaude() {
  if (!TAURI) { renderClaude(); return; }
  try { clState = await invoke<ClaudeView>("claude_status"); }
  catch (err) { clError = String(err); }
  renderParteControles();
  renderClaude();
  brief();
}

document.querySelectorAll<HTMLButtonElement>("[data-parte]").forEach(b => b.addEventListener("click", () => {
  parteVista = b.dataset.parte as "diario" | "semanal";
  renderParteControles();
  brief();
}));
$("parte-regen").addEventListener("click", () => generarParte(parteVista, true));

const clMsg = (t: string, k: "ok" | "err" | "" = "") => { const m = $("cl-msg"); m.textContent = t; m.className = "msg" + (k ? " " + k : ""); };
async function guardarAjustesClaude() {
  if (!TAURI) return;
  try { clState = await invoke<ClaudeView>("claude_ajustes", { activo: $<HTMLInputElement>("cl-activo").checked, modelo: $<HTMLSelectElement>("cl-modelo").value }); clMsg("Guardado.", "ok"); }
  catch (err) { clMsg(String(err), "err"); }
  renderParteControles(); renderClaude(); brief();
}
$("cl-activo").addEventListener("change", guardarAjustesClaude);
$("cl-modelo").addEventListener("change", guardarAjustesClaude);
$("cl-probar").addEventListener("click", async () => {
  clMsg("Claude está escribiendo el parte…");
  parteVista = "diario";
  await generarParte("diario", true);
  if (!clError) clMsg("Parte escrito: míralo en Hoy.", "ok");
});

$("ask-form").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $<HTMLInputElement>("ask-q").value.trim();
  if (!q || !TAURI) return;
  const out = $("ask-out"), a = $("ask-a"), btn = $<HTMLButtonElement>("ask-go");
  out.hidden = false;
  a.innerHTML = `<span class="wait blink">Pensando con tus datos…</span>`;
  btn.disabled = true;
  try {
    const r = await invoke<string>("preguntar", { pregunta: q, contexto: contexto() });
    a.innerHTML = esc(r).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  } catch (err) { a.innerHTML = `<span class="alarm">${esc(String(err))}</span>`; }
  finally { btn.disabled = false; }
});

/* ---------- tokens de claude ---------- */
type TkFila = { fecha: string; modelo: string; proyecto: string; entrada: number; salida: number; cache_creacion: number; cache_lectura: number; mensajes: number };
type TokensView = { filas: TkFila[]; leido: string | null };

/** Tokens procesados: entrada + escritura de caché + salida (la caché leída va aparte: es mucho y barata). */
const tkTot = (f: TkFila) => f.entrada + f.cache_creacion + f.salida;
const tkNombre = (m: string) => {
  const r = m.replace(/^claude-/, "").match(/^([a-z]+)-(\d+)-(\d+)/);
  return r ? `${r[1][0].toUpperCase()}${r[1].slice(1)} ${r[2]}.${r[3]}` : m;
};
const tkCifra = (n: number) => n >= 1e9 ? `${fmt(n / 1e9, 1)} G` : n >= 1e6 ? `${fmt(n / 1e6, 1)} M` : n >= 1e4 ? `${fmt(n / 1e3, 0)} k` : fmt(n);
const setT = (k: string, v: string) => document.querySelectorAll<HTMLElement>(`[data-t="${k}"]`).forEach(n => (n.textContent = v));
const diaStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function renderTokens(t: TokensView | null) {

  const filas = t?.filas ?? [];
  const hoy = diaStr(new Date());
  const desde = (n: number) => diaStr(new Date(Date.now() - (n - 1) * DIA));
  const suma = (fs: TkFila[]) => fs.reduce((s, f) => s + tkTot(f), 0);
  const en = (n: number) => filas.filter(f => f.fecha >= desde(n));
  const f30 = en(30);
  setT("hoy", filas.length ? tkCifra(suma(filas.filter(f => f.fecha === hoy))) : "—");
  setT("hoy_d", filas.length ? `${fmt(filas.filter(f => f.fecha === hoy).reduce((s, f) => s + f.mensajes, 0))} mensajes` : "");
  setT("d7", filas.length ? tkCifra(suma(en(7))) : "—");
  setT("d7_d", filas.length ? `caché leída ${tkCifra(en(7).reduce((s, f) => s + f.cache_lectura, 0))}` : "");
  setT("d30", filas.length ? tkCifra(suma(f30)) : "—");
  setT("d30_d", filas.length ? `${fmt(f30.reduce((s, f) => s + f.mensajes, 0))} mensajes` : "");
  const life = f30.filter(f => f.proyecto === "LIFE");
  setT("life", filas.length ? tkCifra(suma(life)) : "—");
  setT("life_d", filas.length ? `${fmt(life.reduce((s, f) => s + f.mensajes, 0))} llamadas · parte, radar, preguntas` : "");

  // Modelos por uso, para colores y tablas.
  const porModelo = new Map<string, number>();
  for (const f of f30) porModelo.set(f.modelo, (porModelo.get(f.modelo) ?? 0) + tkTot(f));
  const modelos = [...porModelo].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const grupo = (m: string) => Math.min(modelos.indexOf(m), 3);

  // Gráfica: barras apiladas por día y modelo, 30 días.
  const svg = $("tk-chart") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!filas.length) { label(svg, 10, 75, "SIN DATOS DE CLAUDE CODE TODAVÍA", { fill: K.grid }); }
  else {
    const defs = svgEl("defs", {}, svg);
    const pat = svgEl("pattern", { id: "tk-hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: K.text, "stroke-width": 1.2 }, pat);
    const fill = [K.ph, K.hi, "url(#tk-hatch)", K.grid];
    const dias = Array.from({ length: 30 }, (_, i) => desde(30 - i));
    const pila = dias.map(d => { const g = [0, 0, 0, 0]; for (const f of f30) if (f.fecha === d) g[grupo(f.modelo)] += tkTot(f); return g; });
    const max = Math.max(1, ...pila.map(g => g[0] + g[1] + g[2] + g[3]));
    const l = 46, r = 552, top = 12, base = 122, gw = (r - l) / 30, bw = gw * .7;
    for (let k = 0; k <= 2; k++) {
      const v = max * k / 2, y = base - v / max * (base - top);
      svgEl("line", { x1: l, y1: y, x2: r, y2: y, stroke: K.grid, "stroke-width": 1, "stroke-dasharray": k ? "2 4" : "" }, svg);
      label(svg, l - 6, y + 3, tkCifra(v), { "text-anchor": "end", "font-size": 9 });
    }
    pila.forEach((g, i) => {
      let y = base;
      const x = l + i * gw + (gw - bw) / 2;
      g.forEach((v, j) => {
        if (!v) return;
        const h = v / max * (base - top);
        y -= h;
        svgEl("rect", { x, y, width: bw, height: h, fill: fill[j], stroke: j === 2 ? K.text : "none", "stroke-width": j === 2 ? .8 : 0, class: "grow", style: `--i:${i}` }, svg)
          .appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: `${dias[i]} · ${tkCifra(v)}` }));
      });
      if ((i % 7 === 0 && 29 - i >= 4) || i === 29) label(svg, x + bw / 2, base + 14, ddmm(new Date(dias[i] + "T00:00:00")), { "text-anchor": "middle", "font-size": 9 });
    });
  }
  $("tk-legend").innerHTML = modelos.slice(0, 4).map((m, i) => `<span><i class="tk-${Math.min(i, 3)}"></i>${esc(i === 3 && modelos.length > 4 ? "Otros" : tkNombre(m))}</span>`).join("");

  // Tablas: por modelo y por proyecto (30 días).
  const fila = (k: string, v: number, extra = "") => `<div class="row"><span>${esc(k)}${extra ? ` <span class="lang">${extra}</span>` : ""}</span><span>${tkCifra(v)}</span></div>`;
  $("tk-modelos").innerHTML = `<div class="row"><span class="muted">POR MODELO · 30 D</span><span class="muted">TOKENS</span></div>`
    + (modelos.length ? modelos.map(m => fila(tkNombre(m), porModelo.get(m)!, `caché leída ${tkCifra(f30.filter(f => f.modelo === m).reduce((s, f) => s + f.cache_lectura, 0))}`)).join("") : `<div class="row"><span class="muted">—</span><span></span></div>`);
  const porProy = new Map<string, number>();
  for (const f of f30) porProy.set(f.proyecto, (porProy.get(f.proyecto) ?? 0) + tkTot(f));
  $("tk-proyectos").innerHTML = `<div class="row"><span class="muted">POR PROYECTO · 30 D</span><span class="muted">TOKENS</span></div>`
    + ([...porProy].sort((a, b) => b[1] - a[1]).map(([p, v]) => fila(p, v)).join("") || `<div class="row"><span class="muted">—</span><span></span></div>`);
  $("tk-foot").textContent = t?.leido ? `LEÍDO ${stamp(t.leido)}` : TAURI ? "LEYENDO…" : "MODO DEMO";
}

let tkCargando = false;
async function cargarTokens(forzar = false) {
  if (!TAURI || tkCargando) return;
  tkCargando = true;
  try { renderTokens(await invoke<TokensView>("tokens_status", { forzar })); }
  catch (err) { $("tk-foot").textContent = String(err); }
  finally { tkCargando = false; }
}

function demoTokens(): TokensView {
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const filas: TkFila[] = [];
  for (let i = 29; i >= 0; i--) {
    const fecha = diaStr(new Date(Date.now() - i * DIA));
    filas.push({ fecha, modelo: "claude-opus-5-5", proyecto: i % 3 ? "life" : "glutamato-cult", entrada: Math.round(rnd() * 3e5), salida: Math.round(rnd() * 8e4), cache_creacion: Math.round(rnd() * 2e5), cache_lectura: Math.round(rnd() * 9e6), mensajes: Math.round(20 + rnd() * 80) });
    filas.push({ fecha, modelo: "claude-sonnet-5-5", proyecto: "LIFE", entrada: 4000, salida: 900, cache_creacion: 0, cache_lectura: 0, mensajes: 3 });
    if (rnd() > .6) filas.push({ fecha, modelo: "claude-haiku-5-5", proyecto: "LIFE", entrada: 9000, salida: 1200, cache_creacion: 0, cache_lectura: 0, mensajes: 1 });
  }
  return { filas, leido: new Date().toISOString() };
}

/* ---------- dinero ---------- */
const CATS = ["Nómina", "Ingresos", "Casa y facturas", "Súper", "Restaurantes", "Transporte", "Suscripciones", "Compras", "Equipo",
  "Ocio", "Salud", "Viajes", "Impuestos", "Comisiones", "Efectivo", "Transferencias", "Otros", "Interno"] as const;
/** Reglas automáticas por descripción. Lo que corriges a mano manda sobre ellas. */
const REGLAS: [string, RegExp][] = [
  ["Casa y facturas", /alquiler|\brent\b|iberdrola|endesa|naturgy|holaluz|octopus|canal de isabel|aguas? de|comunidad de prop|vodafone|orange|yoigo|masmovil|pepephone|lowi|simyo|digi\b|o2\b|seguro hogar/],
  ["Súper", /mercadona|carrefour|lidl|aldi|\bdia\b|eroski|alcampo|consum|hipercor|supercor|ahorramas|bonpreu|caprabo|condis|spar\b|supermercado|super ?mercado|froiz|gadis|\bbm\b|covir[aá]n|masymas|mas ?y ?mas|alimerka|supeco|family cash|hiber|lupa\b|simply|primaprix|el arbol|claudio|vegalsa|dinosol|hiperdino|tu ?super|coaliment|plusfresc|sorli|mercat|fruter[ií]a|carnicer[ií]a|pescader[ií]a|panader[ií]a|ultramarinos|alimentaci[oó]n|groceries/],
  ["Restaurantes", /restaurante|restaurant|\brest\b|\bbar\b|caf[eé]|cafeter|burger|mcdonald|kfc|telepizza|domino|just ?eat|glovo|deliveroo|uber ?eats|starbucks|tapas|pizz|cervecer|taberna|bodega|sushi|kebab|asador|mes[oó]n|braser|tasca|churrer|helader|gastrobar|vinoteca|sidrer[ií]a|marisquer|pollos|poke|ramen|wok|tacos|100 montaditos|vips|goiko|five guys|foster|tgb|rodilla|granier|manolo bakes|\bplk\b|popeyes|tim hortons|honest greens|la tagliatella|ginos|cena|comida|almuerzo|desayuno|vermut/],
  ["Transporte", /\buber\b|cabify|bolt|renfe|metro|\bemt\b|\btmb\b|taxi|repsol|cepsa|\bbp\b|galp|shell|gasolin|petrol|carburante|suministros petrol|parking|aparcamiento|telpark|empark|bicing|free ?now|blablacar|ouigo|iryo|alsa|peaje|autopista|audasa|aucalsa|itv|lavado/],
  ["Viajes", /ryanair|vueling|iberia|easyjet|booking|airbnb|hotel|expedia|aena|trainline|hostel/],
  ["Suscripciones", /\byt ?premium|youtube premium|suscripci|cuota mensual|netflix|spotify|hbo|\bmax\b|disney|prime video|amazon prime|apple\.com|itunes|icloud|google (one|storage|play)|youtube|adobe|github|openai|anthropic|claude|chatgpt|filmin|dazn|notion|figma|dropbox|microsoft|xbox|playstation|patreon|midjourney|canva/],
  ["Equipo", /fotocasion|fotoprix|fujifilm|canon|nikon|sony|leica|bhphoto|b&h|adorama|calumet|apple store|pccomponentes|mediamarkt|coolmod/],
  ["Compras", /amazon|aliexpress|zara|h&m|ikea|decathlon|corte ingl|primark|fnac|shein|wallapop|vinted|uniqlo|leroy|massimo ?dutti|pull ?&? ?bear|bershka|stradivarius|mango|oysho|zalando|carhartt|primor|druni|sephora|kiko|tiger|action\b|normal\b|miniso|sklum|conforama|bricomart|bauhaus|centro comercial|c\. ?comercial|\bcc\b|milbby/],
  ["Salud", /farmacia|cl[ií]nica|dental|dentist|hospital|[oó]ptica|sanitas|adeslas|fisio|gimnasio|\bgym\b|basic-?fit|holmes|anytime|mcfit|altafit|dir\b|crossfit|piscina|deporte|parafarmacia|m[eé]dico|psic[oó]log/],
  ["Ocio", /cine|yelmo|cinesa|kinepolis|teatro|concierto|ticketmaster|entradas|eventbrite|fever|steam|nintendo|epic games|museo|librer|casa del libro|escape|bolera|karaoke|discoteca|pub\b|copas|festival|camping|parque|zoo|acuario/],
  ["Impuestos", /agencia tributaria|aeat|hacienda|seguridad social|tgss|ayuntamiento|\bdgt\b|impuesto|tasa municipal/],
  ["Comisiones", /\bfee\b|comisi[oó]n|plan (premium|metal|plus)|revolut (premium|metal|plus)/],
];

type Mov = {
  id: string; fecha: string; completada: string | null; tipo: string; producto: string; descripcion: string; comercio: string;
  importe: number; comision: number; divisa: string; estado: string; saldo: number | null; interno: boolean; fuente: string;
  concepto?: string | null;
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
type Dinero = { movimientos: Mov[]; categorias: Record<string, string>; categorias_ia?: Record<string, string>; banco: Banco; patrimonio: Patrimonio };
const SIN_BANCO: Banco = { configurado: false, conectado: false, app_id: null, valido_hasta: null, sincronizado: null, cuentas: 0, error: null };
type Sub = {
  comercio: string; nombre: string; cada: "semanal" | "mensual" | "anual"; dias: number; importe: number; mensual: number;
  ultimo: Date; proximo: Date; sube: number; desde: string;
  /** Deducida de la categoría con pocos cobros (no de una repetición ya vista): la cadencia es una suposición. */
  supuesta?: boolean;
};

let rvState: Dinero = { movimientos: [], categorias: {}, banco: SIN_BANCO, patrimonio: SIN_PATRIMONIO };
let mesSel: string | null = null;  // AAAA-MM
let subsCache: Sub[] = [];
/** Suscripciones que se cobraban y ya no (sin cobro reciente). */
let subsViejas: Sub[] = [];

/** Lo que está en la categoría Suscripciones pero aún no se repite lo bastante para detectarlo:
 *  servicios nuevos (un cobro reciente), anuales (un cobro en el último año) y los que ya no se cobran. */
function subsPorCategoria(list: Mov[], detectadas: Sub[]) {
  const por = new Map<string, Mov[]>();
  for (const m of list) {
    if (m.divisa !== "EUR" || m.importe >= 0 || m.interno || detectadas.some(s => s.comercio === m.comercio)) continue;
    if (catOf(m) !== "Suscripciones") continue;
    (por.get(m.comercio) ?? por.set(m.comercio, []).get(m.comercio)!).push(m);
  }
  const activas: Sub[] = [], viejas: Sub[] = [];
  const hoy = Date.now();
  for (const [comercio, ms] of por) {
    ms.sort((a, b) => a.fecha.localeCompare(b.fecha));
    const amts = ms.map(m => -m.importe);
    const med = mediana(amts.slice(-3));
    if (amts.slice(-3).some(a => Math.abs(a - med) / med > .3)) continue; // importes que bailan: no es una cuota
    const t = ms.map(m => fechaDe(m.fecha).getTime());
    const g = t.length > 1 ? mediana(t.slice(1).map((x, i) => (x - t[i]) / DIA)) : 0;
    const anual = g >= 300 || (ms.length === 1 && amts[0] >= 30);
    const cada: Sub["cada"] = anual ? "anual" : g >= 6 && g <= 8 ? "semanal" : "mensual";
    const dias = cada === "anual" ? 365 : cada === "semanal" ? 7 : 30;
    const ultimo = new Date(t[t.length - 1]);
    const importe = amts[amts.length - 1];
    const s: Sub = {
      comercio, nombre: ms[ms.length - 1].concepto && /premium|suscrip/i.test(ms[ms.length - 1].concepto!) ? ms[ms.length - 1].concepto! : ms[ms.length - 1].descripcion,
      cada, dias, importe, mensual: cada === "anual" ? importe / 12 : cada === "semanal" ? importe * 52 / 12 : importe,
      ultimo, proximo: new Date(ultimo.getTime() + dias * DIA), sube: 0, desde: "", supuesta: true,
    };
    const activa = (hoy - ultimo.getTime()) / DIA <= (cada === "anual" ? 380 : cada === "semanal" ? 14 : 45);
    (activa ? activas : viejas).push(s);
  }
  return { activas, viejas };
}

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
  // El concepto de un Bizum o una transferencia («YT Premium», «cena») manda sobre la persona.
  const c = (m.concepto ?? "").toLowerCase();
  if (c && m.importe < 0) for (const [cat, re] of REGLAS) if (re.test(c)) return cat;
  if (m.tipo === "nomina") return "Nómina";
  if (m.importe > 0 && m.tipo !== "reembolso") return "Ingresos";
  const d = `${m.descripcion} ${c}`.toLowerCase();
  for (const [cat, re] of REGLAS) if (re.test(d)) return cat;
  if (m.tipo === "transferencia") return "Transferencias";
  return "Otros";
}
/* Categoría a mano por concepto: en transferencias y Bizum con concepto, la que eliges se guarda
 * para «comercio | concepto» (sin cifras ni meses, para que «Alquiler noviembre» y «Alquiler
 * diciembre» vayan juntos) y no para todo lo que llega de esa persona. En la tabla `categorias`
 * conviven ambas claves; la del concepto manda sobre la del comercio. */
const MESES_RE = /\b(ene(ro)?|feb(rero)?|mar(zo)?|abr(il)?|may(o)?|jun(io)?|jul(io)?|ago(sto)?|sep(t(iembre)?)?|set(iembre)?|oct(ubre)?|nov(iembre)?|dic(iembre)?)\b/g;
const SEP_CONCEPTO = " | ";
function claveConcepto(m: Mov): string | null {
  if (!m.concepto) return null;
  const n = m.concepto.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}]+/gu, " ").replace(MESES_RE, " ").replace(/\s+/g, " ").trim();
  return n ? m.comercio + SEP_CONCEPTO + n : null;
}
function manualDe(m: Mov): string {
  const k = claveConcepto(m);
  return (k && rvState.categorias[k]) || rvState.categorias[m.comercio] || "";
}
/** Categoría: la que elegiste a mano; si no, las reglas; y donde las reglas no saben (Otros o
 *  Transferencias), la que propuso Claude. */
function catOf(m: Mov): string {
  const manual = manualDe(m);
  if (manual) return manual;
  const a = autoCat(m);
  if (a === "Otros" || a === "Transferencias") {
    const ia = rvState.categorias_ia?.[m.comercio];
    if (ia && ia !== "Otros" && !(ia === "Transferencias" && a === "Otros")) return ia;
  }
  return a === "Otros" && subsCache.some(s => s.comercio === m.comercio) ? "Suscripciones" : a;
}
/** Comercios de gasto que ni las reglas ni Claude ni tú habéis categorizado aún. */
function sinCategoria(list: Mov[]) {
  const vistos = new Map<string, Mov[]>();
  for (const m of list) {
    if (m.importe >= 0 || m.interno || m.divisa !== "EUR" || manualDe(m)) continue;
    const a = autoCat(m);
    if (a !== "Otros" && a !== "Transferencias") continue;
    (vistos.get(m.comercio) ?? vistos.set(m.comercio, []).get(m.comercio)!).push(m);
  }
  return vistos;
}
let categorizando = false;
let categorizadoEn = 0;
/** Tras leer el banco: Claude (Haiku) propone categoría para los comercios nuevos que las reglas no reconocen. */
async function categorizarConClaude() {
  if (!TAURI || categorizando || !clState?.sesion || Date.now() - categorizadoEn < 30 * 60 * 1000) return;
  const pend = [...sinCategoria(rvState.movimientos)].filter(([k]) => !(k in (rvState.categorias_ia ?? {}))).slice(0, 120);
  if (!pend.length) return;
  categorizando = true;
  categorizadoEn = Date.now();
  const lista = pend.map(([comercio, ms]) => ({
    comercio, descripcion: ms[ms.length - 1].descripcion,
    concepto: ms.map(m => m.concepto).find(Boolean) ?? undefined,
    importe_tipico: r1(mediana(ms.map(m => -m.importe))), veces: ms.length,
  }));
  try {
    const ia = await invoke<Record<string, string>>("categorizar_ia", { comercios: JSON.stringify(lista), categorias: CATS.filter(c => !esIngreso(c) && c !== "Interno") });
    renderDinero({ ...rvState, categorias_ia: ia });
  } catch (err) { console.warn("categorizar:", err); }
  finally { categorizando = false; }
}
/** Solo euros y nada interno: lo que cuenta para ingresos y gastos. */
const cuenta = (m: Mov) => m.divisa === "EUR" && catOf(m) !== "Interno";

/** Cargos de la categoría Suscripciones en un mes (AAAA-MM), del más antiguo al más reciente. */
function subsDelMes(list: Mov[], k: string) {
  return list.filter(m => m.fecha.startsWith(k) && m.importe < 0 && cuenta(m) && catOf(m) === "Suscripciones");
}
const nombreSub = (m: Mov) => m.concepto && /premium|suscrip/i.test(m.concepto) ? m.concepto : m.descripcion;

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

type Mes = { ing: number; nom: number; gas: number; cats: Map<string, number> };
/** Nómina e ingresos cuentan como dinero que entra. */
const esIngreso = (c: string) => c === "Ingresos" || c === "Nómina";
function porMes(list: Mov[]) {
  const map = new Map<string, Mes>();
  for (const m of list) {
    if (!cuenta(m)) continue;
    const k = m.fecha.slice(0, 7);
    const r = map.get(k) ?? map.set(k, { ing: 0, nom: 0, gas: 0, cats: new Map() }).get(k)!;
    const c = catOf(m);
    if (esIngreso(c)) { r.ing += m.importe; if (c === "Nómina") r.nom += m.importe; }
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
  if (!s.hay) { el.innerHTML = `<p class="muted">Sin datos. Conecta Revolut en F5.</p>`; $("patri-foot").textContent = ""; return; }
  const h = s.hucha, o = s.oroInfo;
  const pct = (a: number, b: number) => `${a >= 0 ? "+" : ""}${fmt(a / b * 100, 1)} %`;
  el.innerHTML = `
    <div><span class="k">Cuenta</span><span class="v money">${eur(s.cuenta, 2)}</span>
      <span class="d muted">${s.fecha ? `saldo a ${ddmm(fechaDe(s.fecha))} · ${rvState.banco.conectado ? "banco" : "sin conexión"}` : "sin saldo"}</span></div>
    <div><span class="k">Hucha${h?.estimado ? " ≈" : ""}</span><span class="v money">${h ? eur(h.saldo, 2) : "—"}</span>
      <span class="d muted">${h ? `${h.base.manual ? "puesto a mano" : "último saldo conocido"} el ${ddmm(fechaDe(h.base.fecha))}: <span class="money">${eur(h.base.saldo, 2)}</span>` : "ajústala a mano"}</span>
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
  if (!meses.size) { label(svg, 20, 110, "SIN DATOS · CONECTA REVOLUT EN F5", { fill: K.grid }); return; }
  const defs = svgEl("defs", {}, svg);
  const pat = svgEl("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: K.text, "stroke-width": 1.2 }, pat);
  const l = 46, r = 552, top = 18, base = 190, gw = (r - l) / keys.length, bw = gw * .3;
  const data = keys.map(k => meses.get(k) ?? { ing: 0, nom: 0, gas: 0, cats: new Map() });
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
    // Ingresos: el resto, más claro, encima; la nómina, abajo en verde fósforo.
    if (hi > 0) svgEl("rect", { x: x + gw / 2 - bw - 1, y: zero - hi, width: bw, height: hi, fill: K.hi, "fill-opacity": sel ? 1 : .75, class: "grow", style: `--i:${i}` }, g);
    const hn = zero - Y(d.nom ?? 0);
    if (hn > 0) svgEl("rect", { x: x + gw / 2 - bw - 1, y: zero - hn, width: bw, height: hn, fill: K.ph, "fill-opacity": sel ? 1 : .85, class: "grow", style: `--i:${i}` }, g);
    if (hg > 0) svgEl("rect", { x: x + gw / 2 + 1, y: zero - hg, width: bw, height: hg, fill: "url(#hatch)", stroke: K.text, "stroke-width": 1, class: "grow", style: `--i:${i}` }, g);
    label(g, x + gw / 2, base + 16, MESES[mesDe(k).getMonth()], { "text-anchor": "middle", "font-size": 9, fill: sel ? K.hi : K.grid });
    const t = svgEl("title", {}, g); t.textContent = `${mesNombre(k)} · ingresos ${eur(d.ing)} · gastos ${eur(d.gas)} · patrimonio ${eur(serie[i])}`;
  });
  // Punto álgido: la barra más alta de los 12 meses, con su cantidad.
  let pico = { v: 0, i: -1, ing: true };
  data.forEach((d, i) => {
    if (d.ing > pico.v) pico = { v: d.ing, i, ing: true };
    if (d.gas > pico.v) pico = { v: d.gas, i, ing: false };
  });
  if (pico.i >= 0 && pico.v > 0) {
    const y = Y(pico.v);
    const x = l + pico.i * gw + gw / 2 + (pico.ing ? -bw / 2 - 1 : bw / 2 + 1);
    svgEl("line", { x1: l, y1: y, x2: r, y2: y, stroke: K.hi, "stroke-width": .8, "stroke-dasharray": "4 3", opacity: .7, class: "fade" }, svg);
    svgEl("rect", { x: x - 3, y: y - 3, width: 6, height: 6, fill: "none", stroke: K.alert, class: "ping" }, svg);
    svgEl("rect", { x: x - 2.5, y: y - 2.5, width: 5, height: 5, fill: K.alert, class: "fade" }, svg);
    const ax = Math.min(Math.max(x, l + 60), r - 60);
    label(svg, ax, y - 6, `MÁX ${eur(pico.v)} · ${pico.ing ? "INGRESOS" : "GASTOS"} ${MESES[mesDe(keys[pico.i]).getMonth()]}`, { "text-anchor": "middle", "font-size": 9, fill: K.hi, class: "fade money" });
  }
  const pts = accs.map((v, i) => [l + i * gw + gw / 2, YL(v)]);
  svgEl("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: K.hi, "stroke-width": 1.6, pathLength: 1, class: "draw glow" }, svg);
  const [lx, ly] = pts[pts.length - 1];
  svgEl("rect", { x: lx - 2.5, y: ly - 2.5, width: 5, height: 5, fill: K.hi, class: "fade" }, svg);
  // Máximo de patrimonio de los 12 meses: punto y cifra sobre la línea.
  const iMax = accs.reduce((m, v, i) => (v > accs[m] ? i : m), 0);
  const esUltimo = iMax === accs.length - 1;
  if (esUltimo) {
    svgEl("rect", { x: lx - 3.5, y: ly - 3.5, width: 7, height: 7, fill: "none", stroke: K.alert, class: "ping" }, svg);
    svgEl("rect", { x: lx - 3, y: ly - 3, width: 6, height: 6, fill: K.alert, class: "fade glow" }, svg);
  }
  label(svg, Math.min(lx, r - 34), ly - 9, `${esUltimo ? "MÁX " : ""}${eur(accs[accs.length - 1])}`, { "text-anchor": "middle", fill: K.hi, class: "fade money" });
  const [fx, fy] = pts[0];
  if (iMax !== 0) label(svg, fx + 2, fy - 9, eur(accs[0]), { "text-anchor": "start", fill: K.text, "font-size": 9, class: "fade money" });
  if (!esUltimo) {
    const [mx, my] = pts[iMax];
    svgEl("rect", { x: mx - 3.5, y: my - 3.5, width: 7, height: 7, fill: "none", stroke: K.alert, class: "ping" }, svg);
    svgEl("rect", { x: mx - 3, y: my - 3, width: 6, height: 6, fill: K.alert, class: "fade glow" }, svg);
    label(svg, Math.min(Math.max(mx, l + 50), r - 50), my - 10, `MÁX ${eur(accs[iMax])} · ${MESES[mesDe(keys[iMax]).getMonth()]}`, { "text-anchor": "middle", fill: K.hi, "font-size": 9.5, class: "fade money" });
  }
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

let soloSinCategoria = false;
/** Las categorías se ven como texto; el botón «Editar categorías» las cambia por combos. */
let editandoCats = false;
function movs(list: Mov[]) {
  const el = $("movs");
  const btn = $<HTMLButtonElement>("movs-edit");
  btn.textContent = editandoCats ? "Hecho" : "Editar categorías";
  btn.setAttribute("aria-pressed", String(editandoCats));
  el.classList.toggle("editando", editandoCats);
  const rows = soloSinCategoria
    ? list.filter(m => { if (!sinCategoria([m]).size) return false; const ia = rvState.categorias_ia?.[m.comercio]; return !ia || ia === "Otros"; }).reverse()
    : list.filter(m => m.fecha.startsWith(mesSel ?? "-")).reverse();
  $("movs-h").textContent = soloSinCategoria ? "Movimientos sin categoría clara · todos los meses" : `Movimientos · ${MESES[mesDe(mesSel ?? mesKey(new Date())).getMonth()]}`;
  $("movs-n").textContent = rows.length ? `${rows.length} MOVIMIENTO${rows.length === 1 ? "" : "S"}` : "";
  if (!rows.length) { el.innerHTML = `<p class="muted">${list.length ? "Sin movimientos este mes." : "Conecta Revolut en F5 para ver tus movimientos."}</p>`; return; }
  el.innerHTML = rows.map(m => {
    const c = catOf(m);
    const cat = editandoCats
      ? `<select data-id="${esc(m.id)}" aria-label="Categoría de ${esc(m.descripcion)}">${CATS.map(k => `<option${k === c ? " selected" : ""}>${k}</option>`).join("")}</select>`
      : `<span class="cat-v">${esc(c)}</span>`;
    const extra = [m.concepto ? `«${m.concepto}»` : "", m.estado === "pendiente" ? "pendiente" : "", m.divisa !== "EUR" ? m.divisa : "", m.producto !== "cuenta" ? m.producto : ""].filter(Boolean).join(" · ");
    return `<div class="mov${c === "Interno" ? " int" : c === "Nómina" ? " nomina" : ""}">
      <span class="muted">${ddmm(fechaDe(m.fecha))}</span>
      <span class="ds" title="${esc(m.descripcion)}">${esc(m.descripcion)}${extra ? `<small>${esc(extra)}</small>` : ""}</span>
      ${cat}
      <span class="amt money${m.importe > 0 ? " pos" : ""}">${m.importe > 0 ? "+" : ""}${fmt(m.importe, 2)}${m.divisa === "EUR" ? " €" : ""}</span>
    </div>`;
  }).join("");
}

/** Lo que ya se ha cobrado en Suscripciones en el mes elegido. */
function subsMes(list: Mov[]) {
  const k = mesSel ?? mesKey(new Date());
  const ms = subsDelMes(list, k);
  const tot = ms.reduce((s, m) => s - m.importe, 0);
  $("subs-mes-h").textContent = `Suscripciones pagadas · ${MESES[mesDe(k).getMonth()]}`;
  // En lo que va de año: del 1 de enero hasta el final del mes elegido.
  const ano = k.slice(0, 4);
  const delAno = list.filter(m => m.fecha.startsWith(ano) && m.fecha.slice(0, 7) <= k && m.importe < 0 && cuenta(m) && catOf(m) === "Suscripciones");
  const totAno = delAno.reduce((s, m) => s - m.importe, 0);
  const cargos = (n: number) => `${n} cargo${n === 1 ? "" : "s"}`;
  const filaAno = `<tr><td>En lo que va de ${ano} · ${cargos(delAno.length)}</td><td class="r money">${eur(totAno, 2)}</td></tr>`;
  $("subs-mes").innerHTML = !list.length ? `<tr><td class="muted">Sin datos.</td></tr>`
    : (ms.length
      ? ms.map(m => `<tr><td>${esc(nombreSub(m))}<span class="note">${ddmm(fechaDe(m.fecha))}${m.estado === "pendiente" ? " · pendiente" : ""}</span></td><td class="r money">${fmt(-m.importe, 2)} €</td></tr>`).join("")
      : `<tr><td class="muted">Ningún cargo de suscripciones este mes.</td><td></td></tr>`)
      + `<tfoot>${ms.length ? `<tr><td>Total del mes · ${cargos(ms.length)}</td><td class="r money">${eur(tot, 2)}</td></tr>` : ""}${filaAno}</tfoot>`;
}

function subs(list: Sub[]) {
  const tot = list.reduce((s, x) => s + x.mensual, 0);
  $("subs").innerHTML = list.length
    ? list.map(s => `<tr><td>${esc(s.nombre)}<span class="note${s.sube ? " up" : ""}">${s.cada}${s.supuesta ? " (supuesto) · desde " + ddmm(s.ultimo) : ""}${s.sube ? ` · ▲ sube ${fmt(s.sube, 2)} € en ${s.desde}` : ""}</span></td>
        <td class="r money">${fmt(s.importe, 2)} €</td></tr>`).join("")
      + (subsViejas.length ? `<tr class="vieja-h"><td colspan="2">SIN COBROS RECIENTES</td></tr>` + subsViejas.map(s => `<tr class="vieja"><td>${esc(s.nombre)}<span class="note">último cobro ${ddmm(s.ultimo)}.${s.ultimo.getFullYear() % 100}</span></td><td class="r money">${fmt(s.importe, 2)} €</td></tr>`).join("") : "")
      + `<tfoot><tr><td>Al mes · al año (activas)</td><td class="r money">${eur(tot, 2)} · ${eur(tot * 12)}</td></tr></tfoot>`
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
  if (!list.length) { lines.push(`<span class="off">Dinero: conecta Revolut en <b>F5 · Conexiones</b>.</span>`); return; }
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
      if (!prev.includes(mk) || +x.fecha.slice(8, 10) > dia || !cuenta(x) || esIngreso(catOf(x))) continue;
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
  if (daysAgo(ultimo.fecha.slice(0, 10)) > 35) lines.push(`<span class="off">El último movimiento del banco es del ${ddmm(fechaDe(ultimo.fecha))}: revisa la conexión en F5.</span>`);
}

function renderDinero(d: Dinero) {
  rvState = d;
  const list = d.movimientos;
  subsCache = [];
  subsCache = detectarSubs(list);
  const extra = subsPorCategoria(list, subsCache);
  subsCache = [...subsCache, ...extra.activas].sort((a, b) => b.mensual - a.mensual);
  subsViejas = extra.viejas.sort((a, b) => b.ultimo.getTime() - a.ultimo.getTime());
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
  setM("ing_d", [m?.nom ? `nómina ${eur(m.nom)}` : "", prev.length ? `media ${eur(ingMedia)}` : ""].filter(Boolean).join(" · "));
  setM("gas_d", prev.length ? `media ${eur(gMedia)}` : "");
  const tasa = m && m.ing > 0 ? (m.ing - m.gas) / m.ing * 100 : null;
  setM("tasa", tasa === null ? "—" : `${fmt(tasa)} %`, tasa !== null && tasa < 0);
  setM("tasa_d", tMedia.length ? `media 6 m: ${fmt(tMedia.reduce((a, b) => a + b, 0) / tMedia.length)} %` : "");
  const gas6 = conDatos.filter(k => k < now).slice(-6);
  const gasto6 = gas6.reduce((a, k) => a + meses.get(k)!.gas, 0) / (gas6.length || 1);
  const colchon = s.hay && gasto6 > 0 ? s.liquido / gasto6 : null;
  setM("colchon", colchon === null ? "—" : `${fmt(colchon, 1)} meses`, colchon !== null && colchon < 1);
  setM("cats_h", `Gasto por categoría · ${nombre}`);
  $("m-label").textContent = mesNombre(mesSel);
  ($("m-next") as HTMLButtonElement).disabled = mesSel >= fin;
  ($("m-prev") as HTMLButtonElement).disabled = !has || mesSel <= (conDatos[0] ?? mesSel);

  patri(s);
  flow(meses, keys, seriePatrimonio(list, s, keys));
  cats(m, media);
  movs(list);
  subsMes(list);
  subs(subsCache);
  heatGastos();
  // Revisión: comercios de gasto sin categoría clara (ni reglas, ni Claude, ni tú).
  const pendientes = [...sinCategoria(list).keys()].filter(k => { const ia = rvState.categorias_ia?.[k]; return !ia || ia === "Otros"; }).length;
  const rev = $<HTMLButtonElement>("revisar");
  rev.hidden = !pendientes && !soloSinCategoria;
  rev.textContent = soloSinCategoria ? "Volver al mes" : `${pendientes} sin categoría clara · revisar`;
  if (datosListos) categorizarConClaude();

  const rango = has ? `${ddmm(fechaDe(list[0].fecha))}.${list[0].fecha.slice(2, 4)} → ${ddmm(fechaDe(list[list.length - 1].fecha))}.${list[list.length - 1].fecha.slice(2, 4)}` : "";
  const origen = d.banco?.conectado
    ? `BANCO${d.banco.sincronizado ? ` · LEÍDO ${stamp(d.banco.sincronizado)}` : ""}`
    : "BANCO SIN CONEXIÓN";
  const info = has ? `${origen} · ${fmt(list.length)} MOVIMIENTOS · ${rango}` : "SIN DATOS · CONECTA REVOLUT EN F5";
  $("rv-info").textContent = info;
  const b = d.banco ?? SIN_BANCO;
  const dias = b.valido_hasta ? Math.floor((new Date(b.valido_hasta).getTime() - Date.now()) / DIA) : null;
  const renovar = b.conectado && dias !== null && dias <= 7;
  const src = $("src-revolut");
  src.className = "src" + (b.conectado ? (renovar || b.error ? " err" : " on") : has ? " on" : "");
  src.lastChild!.textContent = b.conectado
    ? (renovar ? (dias! < 0 ? "Revolut · permiso caducado" : `Revolut · renovar acceso en ${dias} d`) : b.error ? "Revolut · error" : "Revolut · banco")
    : "Revolut · sin conectar";
  $("rv-state").textContent = b.conectado ? `Conectado · ${b.cuentas} cuenta${b.cuentas === 1 ? "" : "s"}` : has ? `${fmt(list.length)} movimientos` : "Sin conectar";
  $("rv-state").className = "state" + (b.conectado ? (renovar || b.error ? " err" : " on") : has ? " on" : "");
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
  sonarGraficas();
  if (!mesSel) return;
  const d = mesDe(mesSel); d.setMonth(d.getMonth() + delta);
  mesSel = mesKey(d);
  renderDinero(rvState);
  countUp($("v-dinero"));
}
$("revisar").addEventListener("click", () => {
  soloSinCategoria = !soloSinCategoria;
  renderDinero(rvState);
  if (soloSinCategoria) $("movs").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
});
$("m-prev").addEventListener("click", () => cambiarMes(-1));
$("m-next").addEventListener("click", () => cambiarMes(1));
$("flow").addEventListener("click", e => {
  const k = (e.target as Element).closest("[data-mes]")?.getAttribute("data-mes");
  if (k) { sonarGraficas(); mesSel = k; renderDinero(rvState); }
});

const rvMsg = (text: string, kind: "ok" | "err" | "" = "") =>
  document.querySelectorAll<HTMLElement>("[data-rv-msg]").forEach(m => { m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); });

$("movs-edit").addEventListener("click", () => { if (editandoCats) sonar("hecho", undefined, .6); editandoCats = !editandoCats; movs(rvState.movimientos); });
$("movs").addEventListener("change", async e => {
  const sel = e.target as HTMLSelectElement;
  const muestra = rvState.movimientos.find(m => m.id === sel.dataset.id);
  if (!muestra) return;
  // Con concepto (transferencias, Bizum), la elección vale solo para ese concepto, y la que hubiera
  // para todo el comercio se quita: así se separan, p. ej., la nómina de otras transferencias de la misma persona.
  const kc = claveConcepto(muestra);
  const cambios: [string, string][] = kc
    ? [...(rvState.categorias[muestra.comercio] ? [[muestra.comercio, ""] as [string, string]] : []), [kc, sel.value === autoCat(muestra) ? "" : sel.value]]
    : [[muestra.comercio, sel.value === autoCat(muestra) ? "" : sel.value]];
  const n = rvState.movimientos.filter(m => kc ? claveConcepto(m) === kc : m.comercio === muestra.comercio).length;
  try {
    let d: Dinero = rvState;
    for (const [comercio, categoria] of cambios) {
      d = TAURI
        ? await invoke<Dinero>("dinero_categoria", { comercio, categoria })
        : { ...d, categorias: Object.fromEntries(Object.entries({ ...d.categorias, [comercio]: categoria }).filter(([, v]) => v)) };
    }
    renderDinero(d);
    rvMsg(`«${sel.value}» para ${n} movimiento${n === 1 ? "" : "s"} de ${muestra.descripcion}${kc ? ` con concepto «${muestra.concepto}»` : ""}.`, "ok");
  } catch (err) { rvMsg(String(err), "err"); }
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
    add(day(2), "MI NOMBRE · SABADELL", 1400 + Math.round(rnd() * 900), "nomina");
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
  return { movimientos, categorias: { "taberna el sur": "Restaurantes" },
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

/** Dinero desde life.db. Si llega «conectado» pero sin movimientos (no debería), se vuelve a pedir. */
async function cargarDinero(intento = 0): Promise<void> {
  try {
    const d = await invoke<Dinero>("dinero_status");
    renderDinero(d);
    if (!d.movimientos.length && d.banco?.conectado && intento < 6) setTimeout(() => cargarDinero(intento + 1), 1500);
  } catch (e) {
    if (intento < 6) setTimeout(() => cargarDinero(intento + 1), 1500);
    else rvMsg(String(e), "err");
  }
}

/** Al volver a la ventana (desde la bandeja o de otra app), se refrescan los datos guardados. */
let refrescadoEn = 0;
async function refrescar() {
  if (!TAURI || !datosListos || document.visibilityState !== "visible" || Date.now() - refrescadoEn < 20_000) return;
  refrescadoEn = Date.now();
  await cargarDinero(6);
  try { renderGmail(await invoke<Gmail>("gmail_status")); } catch { /* sigue lo que había */ }
  try { renderInstagram(await invoke<Status<Instagram>>("instagram_status")); } catch { /* idem */ }
  try { render(await invoke<Status<GitHub>>("github_status")); } catch { /* idem */ }
}
document.addEventListener("visibilitychange", refrescar);
window.addEventListener("focus", refrescar);

async function load() {
  if (!TAURI) { radarState = demoRadar(); dibujarRadar(); renderDinero(demoDinero()); renderGmail(demoGmail()); renderInstagram(demoInstagram()); if (YOUTUBE) renderYouTube(demoYouTube()); render(demo()); renderClaude(); renderTokens(demoTokens()); return; }
  if (YOUTUBE) {
    try { renderYouTube(await invoke<YtView>("youtube_status")); }
    catch (e) { ytMsg(String(e), "err"); }
  }
  try { renderInstagram(await invoke<Status<Instagram>>("instagram_status")); }
  catch (e) { igMsg(String(e), "err"); }
  try { radarState = await invoke<Semana[]>("radar_status"); } catch { radarState = []; }
  dibujarRadar();
  await cargarDinero();
  try { renderGmail(await invoke<Gmail>("gmail_status")); }
  catch (e) { gmMsg(String(e), "err"); }
  try { render(await invoke<Status<GitHub>>("github_status")); }
  catch (e) { msg(String(e), "err"); }
  datosListos = true;
  cargarTokens();
  setInterval(() => cargarTokens(), 30 * 60 * 1000);
  await cargarClaude();
  categorizarConClaude();
  programarParte();
  setInterval(programarParte, 60 * 1000);
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
  listen<number>("encargo-nuevo", () => sonar("encargo"));
  if (YOUTUBE) listen<YtView>("youtube-updated", e => renderYouTube(e.payload));
  listen<Instagram>("instagram-updated", e => renderInstagram({ connected: true, snapshot: e.payload }));
  // Las esperas («51 h») y el aviso de 48 h avanzan aunque no haya sincronización.
  setInterval(() => renderGmail(gmState), 5 * 60 * 1000);
} else {
  auto.disabled = true;
}

load();

// Sonido de arranque: al abrir LIFE, o la primera vez que se muestra si arrancó en la bandeja.
if (TAURI) {
  let arrancado = false;
  const alArrancar = () => { if (!arrancado && document.visibilityState === "visible") { arrancado = true; sonar("inicio", undefined, .6); } };
  alArrancar();
  document.addEventListener("visibilitychange", alArrancar);
}
const sonidosBox = $<HTMLInputElement>("sonidos");
sonidosBox.checked = sonidosOn;
sonidosBox.disabled = !TAURI;
sonidosBox.addEventListener("change", () => {
  sonidosOn = sonidosBox.checked;
  try { localStorage.setItem("life-sonidos", sonidosOn ? "1" : "0"); } catch { /* sin almacenamiento: dura esta sesión */ }
  if (sonidosOn) sonar("pestana");
});
