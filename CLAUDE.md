# LIFE

Panel de vida personal como app de escritorio para Windows. Propuesta aprobada: `docs/propuesta-v2.html` (artifact: https://claude.ai/artifact/QsGhvbs6cXpHsy9DQwe82h). `docs/propuesta-v0.html` es la variante naranja descartada.

## Reglas fijas

- Es una app de escritorio (Tauri 2). Nada de hosting, PWA ni servidor propio: los datos viven en el equipo.
- No se toca nada de `C:\proyects\glutamato_cult`. Los encargos salen solo de **leer** el Gmail (correos de `web@glutamatocult.com`, asunto `Encargo · Tipo · Qué · Nombre`, cuerpo en líneas `Clave: valor`).
- Todas las integraciones son de solo lectura.
- Tokens y claves solo en el Administrador de credenciales de Windows (`src-tauri/src/secrets.rs`). Nunca en archivos, Git ni la interfaz.

## Estética (fija)

- Toda la interfaz es una consola de radio en fósforo **verde azulado**: logo, menús, pestañas, gráficas y avisos. Referencia de lenguaje gráfico: `core-inspiration/` (artbook; no va a Git, no usar sus imágenes ni su nombre).
- Tokens en `src/styles/console.css` (`--bg --bg-2 --grid --ph --text --hi --alert`). No usar colores literales fuera de `:root`. Un solo tema oscuro.
- Una sola familia: IBM Plex Mono (Fontsource, empaquetada). Rótulos japoneses con la fuente del sistema.
- Recursos: celdas con esquinas marcadas, cabecera de celda en mayúsculas con brillo y rótulo japonés a la derecha, tramado de líneas, franja de barrido, parpadeo leve.
- Animaciones: barrido del radar, texto que se escribe, barras que crecen, líneas que se trazan, cifras que cuentan, alarmas que parpadean. Todo se apaga con `prefers-reduced-motion`.
- Alarmas en `--alert` (rojo coral). Las cifras de dinero llevan la clase `money` para el modo privado (tecla P).

## Stack

- Interfaz: Astro 7 estático + TypeScript estricto + CSS propio. `src/pages/index.astro` (estructura), `src/scripts/app.ts` (lógica, gráficas SVG, llamadas a Rust). Fuera de Tauri se pinta en modo demo con datos de ejemplo.
- Núcleo: Rust en `src-tauri/`. `lib.rs` (comandos, bandeja, arranque, sincronización periódica), `db.rs` (SQLite `life.db` en `%APPDATA%\com.glutamato.life`, migraciones añadidas al final de `MIGRATIONS`; cifrada en formato SQLCipher 4 con SQLite3 Multiple Ciphers que compila `build.rs`, sin OpenSSL; clave `db_key` en las credenciales de Windows), `github.rs`, `gmail.rs`, `movimiento.rs` (estructura de un movimiento), `banco.rs` (Revolut por Open Banking), `instagram.rs`, `youtube.rs`, `secrets.rs`. Iconos (app y bandeja): el 生 con marco, generados con `scripts/icono.ps1` (instrucciones dentro); bandeja en `src-tauri/icons/tray.png`.
- Ventana sin marco nativo (`decorations: false`): la barra de título es propia. Cerrar esconde en la bandeja; salir desde el menú de la bandeja. Ctrl+Alt+L (tauri-plugin-global-shortcut) la trae al frente o la esconde. Arranque con Windows opcional (`--bandeja`).
- Permisos de ventana y plugins en `src-tauri/capabilities/default.json`.

## Comandos

- `npm run app`: la app en modo desarrollo (arranca Astro en http://127.0.0.1:4321 y la ventana).
- `npm run dev`: solo la interfaz en el navegador, en modo demo.
- `npm run build`: `astro check` + build a `dist/`.
- `npm run app:build`: instalador NSIS en `src-tauri/target/release/bundle/nsis/`.
- `cargo test` en `src-tauri/`.

## Fases

0 Base (hecha) · 1 Encargos (Gmail, hecha) · 2 Dinero (Revolut por Open Banking, hecha; falta conciliar encargo ↔ cobro) · 3 Redes (Instagram hecha; YouTube montado pero oculto: `YOUTUBE = false` en `app.ts`) · 4 Parte del día y radar (hecha) · 5 Extras (atajo global Ctrl+Alt+L hecho; el resto, descartado por ahora).

## Notas

- Gmail va por IMAP con contraseña de aplicación (`gmail_user`, `gmail_app_password` en las credenciales). Solo `EXAMINE` y `BODY.PEEK[]`: nunca marcar, mover, etiquetar, borrar ni enviar. «Respondido» = hay un correo tuyo a la dirección del cliente. Los demás estados se marcan en LIFE y no se escriben en Gmail.
- Sincronización: Gmail cada 10 min, GitHub cada hora. Avisos de Windows: encargo nuevo y 48 h sin respuesta (una vez por encargo).
- Dinero: solo por Open Banking (la importación de CSV se quitó; en `life.db` quedan filas antiguas con `fuente = 'csv'`, entre ellas los intereses de la hucha, que dan su nombre). Huella por movimiento: volver a leer no duplica y pasa pendientes a completados. El concepto de Bizum y transferencias va en la columna `concepto` y cuenta para categorizar. Movimientos a la hucha, de otros productos o de cambio de divisa son «Interno» y no cuentan. Categorías automáticas por reglas en `app.ts` (`REGLAS`); la que eliges a mano se guarda por comercio en la tabla `categorias`. Suscripciones y cálculos de ingresos, gastos, ahorro y colchón se hacen en `app.ts`, solo en euros.
- Categorías: lo manual (tabla `categorias`) manda; después las reglas (`REGLAS` en `app.ts`, sobre descripción y concepto); y donde las reglas dan «Otros» o «Transferencias», la que propuso Claude Haiku (`categorizar_ia`, tabla `categorias_ia`; solo recibe comercio, concepto e importe típico; como mucho cada 30 min). En F3, «N sin categoría clara · revisar» filtra lo pendiente. Nómina: ingresos cuyo IBAN de origen es de Banco Sabadell (entidad 0081, `ENTIDAD_NOMINA` en `banco.rs`); se ven más iluminados.
- Tokens de Claude (F4): `tokens.rs` lee por partes los registros de Claude Code (`%USERPROFILE%\.claude\projects\**\*.jsonl`, un mensaje cuenta una vez por `message.id`) y suma las llamadas de LIFE; tablas `tokens_dia`, `tokens_archivos`, `tokens_vistos`. No hay datos de los chats de claude.ai ni de los límites del plan.
- Revolut por Open Banking: Enable Banking (aplicación propia en modo restringido, solo cuentas vinculadas; permiso AIS de solo lectura). ID de la aplicación (`eb_app_id`), clave PEM en trozos (`eb_key`, `eb_key_N`) y sesión (`eb_session`) en las credenciales. La autorización se abre en una ventana `banco` de LIFE que intercepta la vuelta a `https://localhost/life` (debe estar registrada así en Enable Banking). Sincroniza cada 6 h como mucho; aviso de Windows a 7 días de caducar el permiso. Lo del banco (`fuente = 'banco'`) sustituye a las filas antiguas de CSV del mismo producto desde su primera fecha. Internos: traspasos con la hucha (por su nombre o por `banco::HUCHA`: «cuenta con mejora», «vault»…) y cambios de divisa; lo que llega a tu nombre desde otro banco sí cuenta como ingreso. Diagnóstico local de la base real: `cargo test diagnostico_real -- --ignored --nocapture`.
- Patrimonio (F3): cuenta (banco) + hucha + oro. Open Banking no da la hucha ni el oro. Hucha ≈ último saldo conocido (ajuste a mano, `hucha_saldo`/`hucha_fecha`, o el que dejaron las filas antiguas) + traspasos internos posteriores + intereses estimados con su TIN (`hucha_tin`, neto del 19 % de retención) o, sin TIN, al ritmo del último mes (`huchaEstimada` en `app.ts`). Oro: onzas puestas a mano (`oro_onzas`, `oro_coste`) × precio en euros de `api.gold-api.com/price/XAU/EUR` (sin clave, cada hora). Colchón = cuenta + hucha, sin oro.
- Instagram: las apps nuevas de Meta solo ofrecen «Unified login» (token de usuario del sistema, graph.facebook.com/v24.0, permisos `instagram_basic` e `instagram_manage_insights`, la cuenta sale de `/me/assigned_instagram_accounts`; exige porfolio empresarial). También acepta tokens `IGAA…` del antiguo «Instagram Login» (graph.instagram.com, LIFE los renueva cada 7 días). Token en `ig_token` (credenciales). Sincroniza cada hora; los seguidores por día los guarda LIFE en `metricas_diarias` (Meta solo da el número actual). `instagram_abrir` solo abre enlaces de instagram.com.
- YouTube: YouTube Data API v3 + YouTube Analytics API, `youtube.readonly` y `yt-analytics.readonly`. OAuth de app de escritorio con PKCE: el navegador vuelve a `http://127.0.0.1:<puerto>` que LIFE escucha un momento. ID y secreto del cliente (`yt_client_id`, `yt_client_secret`) y token de renovación (`yt_refresh_token`) en las credenciales. La app de Google Cloud debe estar «publicada» o el permiso caduca a los 7 días. Sincroniza cada hora; suscriptores por día en `metricas_diarias`.
- Radar de vida (Hoy): seis ejes (trabajo, dinero, creación, cuerpo, gente, descanso) del 0 al 10, una fila por semana ISO en la tabla `radar`. Lo puntúa Claude (`radar_auto`, `SISTEMA_RADAR`) una vez al día tras el parte, con `contextoRadar()`; la nota guarda en JSON el resumen y un motivo por eje. Cuerpo, gente y descanso se deducen de señales indirectas. No hay puntuación manual.
- Claude (parte del día, parte semanal, preguntas): sin API; usa Claude Code de terminal (`%USERPROFILE%\.local\bin\claude.exe`, instalado con el instalador oficial) con la sesión de la suscripción del usuario (`claude auth login`). `claude.rs` lo llama con `-p --output-format json --tools \"\" --no-session-persistence --strict-mcp-config --setting-sources \"\"` desde una carpeta vacía (`%APPDATA%\com.glutamato.life\claude`). Los datos los arma `contexto()` en `app.ts`: cifras y estados, sin nombres, correos ni teléfonos de clientes. El parte se escribe a partir de las 7:30 (domingo, también el semanal) y se guarda en la tabla `partes`; si Claude falla, se ve el parte local.
- Sonidos: copia en `src-tauri/sonidos/` (en .gitignore: tienen derechos de autor y el repositorio es público), empaquetada en el instalador como recurso `sonidos/` (uso personal). El comando `sonido` los lee de los recursos, del ajuste `sonidos_dir` o de `core-inspiration/FX`. Pestaña: `0x09`; encargo nuevo: `0x10` (evento `encargo-nuevo`); animaciones de Dinero y Redes: `0x3A` (se apaga a 1,5 s); arranque: `0x7B`. Interruptor en F5 → Sistema. La ventana permite reproducir sin clic (`additionalBrowserArgs` en `tauri.conf.json`).

- El instalador (`LIFE_<versión>_x64-setup.exe`, NSIS, por usuario, sin permisos de administrador) no va a Git; se regenera con `npm run app:build`.
- Si se pierde la credencial `db_key`, `life.db` se aparta como `life.db.ilegible-<fecha>` y se empieza de cero: lo sincronizado se recupera, lo introducido a mano no.

## Convenciones

- Textos de interfaz y commits en español; commits en imperativo.
