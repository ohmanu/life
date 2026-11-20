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

function brief(gh: GitHub | null, connected: boolean) {
  const lines: string[] = [];
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
  lines.push(`<span class="off">Encargos: se conectan en la fase 1 (Gmail).</span>`);
  lines.push(`<span class="off">Dinero: fase 2 (Revolut).</span>`);
  const ul = $("brief");
  ul.innerHTML = lines.map((l, i) => `<li data-k="${pad(i + 1)}" style="--i:${i}"><span>${l}</span></li>`).join("");
  $("brief-time").textContent = gh ? `ACTUALIZADO ${stamp(gh.synced_at)}` : "";
}

function render(st: Status<GitHub>) {
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
  brief(gh, st.connected);

  $("gh-state").textContent = st.connected ? `Conectado${gh ? ` · @${gh.login}` : ""}` : "Sin conectar";
  $("gh-state").className = "state" + (st.connected ? " on" : "");
  $("gh-form").hidden = st.connected;
  $("gh-help").hidden = st.connected;
  $("gh-sync").hidden = !st.connected;
  $("gh-off").hidden = !st.connected;
  const active = tabs.find(t => t.getAttribute("aria-selected") === "true");
  if (active) countUp($(active.getAttribute("aria-controls")!));
}

/* ---------- datos de ejemplo fuera de la app ---------- */
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

async function load() {
  if (!TAURI) { render(demo()); return; }
  try { render(await invoke<Status<GitHub>>("github_status")); }
  catch (e) { msg(String(e), "err"); }
}

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
} else {
  auto.disabled = true;
}

load();
