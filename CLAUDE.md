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
- Núcleo: Rust en `src-tauri/`. `lib.rs` (comandos, bandeja, arranque, sincronización periódica), `db.rs` (SQLite `life.db` en `%APPDATA%\com.glutamato.life`, migraciones añadidas al final de `MIGRATIONS`; cifrada en formato SQLCipher 4 con SQLite3 Multiple Ciphers que compila `build.rs`, sin OpenSSL; clave `db_key` en las credenciales de Windows), `github.rs`, `gmail.rs`, `revolut.rs` (CSV), `banco.rs` (Open Banking), `instagram.rs`, `youtube.rs`, `secrets.rs`. Iconos (app y bandeja): el 生 con marco, generados con `scripts/icono.ps1` (instrucciones dentro); bandeja en `src-tauri/icons/tray.png`.
- Ventana sin marco nativo (`decorations: false`): la barra de título es propia. Cerrar esconde en la bandeja; salir desde el menú de la bandeja. Arranque con Windows opcional (`--bandeja`).
- Permisos de ventana y plugins en `src-tauri/capabilities/default.json`.

## Comandos

- `npm run app`: la app en modo desarrollo (arranca Astro en http://127.0.0.1:4321 y la ventana).
- `npm run dev`: solo la interfaz en el navegador, en modo demo.
- `npm run build`: `astro check` + build a `dist/`.
- `npm run app:build`: instalador NSIS en `src-tauri/target/release/bundle/nsis/`.
- `cargo test` en `src-tauri/`.

## Fases

0 Base (hecha) · 1 Encargos (Gmail, hecha) · 2 Dinero (Revolut por CSV y Open Banking hecha; falta conciliar encargo ↔ cobro) · 3 Redes (Instagram hecha; YouTube montado pero oculto: `YOUTUBE = false` en `app.ts`) · 4 Parte del día y radar (Claude) · 5 Extras.

## Notas

- Gmail va por IMAP con contraseña de aplicación (`gmail_user`, `gmail_app_password` en las credenciales). Solo `EXAMINE` y `BODY.PEEK[]`: nunca marcar, mover, etiquetar, borrar ni enviar. «Respondido» = hay un correo tuyo a la dirección del cliente. Los demás estados se marcan en LIFE y no se escriben en Gmail.
- Sincronización: Gmail cada 10 min, GitHub cada hora. Avisos de Windows: encargo nuevo y 48 h sin respuesta (una vez por encargo).
- Revolut: se importa el CSV del extracto (inglés o español, coma o punto y coma) o el «Resumen del ejercicio» (movimientos de las cuentas corrientes, intereses de la hucha sumados por mes y saldo de cierre de la hucha; no mezclar los dos formatos para el mismo periodo: las huellas no coinciden) con el diálogo de archivos; huella por movimiento, reimportar no duplica y pasa pendientes a completados. Movimientos a la hucha, de otros productos o de cambio de divisa son «Interno» y no cuentan. Categorías automáticas por reglas en `app.ts` (`REGLAS`); la que eliges a mano se guarda por comercio en la tabla `categorias`. Suscripciones y cálculos de ingresos, gastos, ahorro y colchón se hacen en `app.ts`, solo en euros.
- Revolut por Open Banking: Enable Banking (aplicación propia en modo restringido, solo cuentas vinculadas; permiso AIS de solo lectura). ID de la aplicación (`eb_app_id`), clave PEM en trozos (`eb_key`, `eb_key_N`) y sesión (`eb_session`) en las credenciales. La autorización se abre en una ventana `banco` de LIFE que intercepta la vuelta a `https://localhost/life` (debe estar registrada así en Enable Banking). Sincroniza cada 6 h como mucho; aviso de Windows a 7 días de caducar el permiso. Lo del banco (`fuente = 'banco'`) sustituye al CSV del mismo producto desde su primera fecha. Internos: traspasos con la hucha (por su nombre o por `banco::HUCHA`: «cuenta con mejora», «vault»…) y cambios de divisa; lo que llega a tu nombre desde otro banco sí cuenta como ingreso. Diagnóstico local de la base real: `cargo test diagnostico_real -- --ignored --nocapture`.
- Patrimonio (F3): cuenta (banco) + hucha + oro. Open Banking no da la hucha ni el oro. Hucha ≈ último saldo conocido (resumen del ejercicio o ajuste a mano, ajustes `hucha_saldo`/`hucha_fecha`) + traspasos internos posteriores + intereses estimados con su TIN (`hucha_tin`, neto del 19 % de retención) o, sin TIN, al ritmo del último mes (`huchaEstimada` en `app.ts`). Oro: onzas del resumen (`oro_onzas`, `oro_coste`) × precio en euros de `api.gold-api.com/price/XAU/EUR` (sin clave, cada hora). Colchón = cuenta + hucha, sin oro.
- Instagram: las apps nuevas de Meta solo ofrecen «Unified login» (token de usuario del sistema, graph.facebook.com/v24.0, permisos `instagram_basic` e `instagram_manage_insights`, la cuenta sale de `/me/assigned_instagram_accounts`; exige porfolio empresarial). También acepta tokens `IGAA…` del antiguo «Instagram Login» (graph.instagram.com, LIFE los renueva cada 7 días). Token en `ig_token` (credenciales). Sincroniza cada hora; los seguidores por día los guarda LIFE en `metricas_diarias` (Meta solo da el número actual). `instagram_abrir` solo abre enlaces de instagram.com.
- YouTube: YouTube Data API v3 + YouTube Analytics API, `youtube.readonly` y `yt-analytics.readonly`. OAuth de app de escritorio con PKCE: el navegador vuelve a `http://127.0.0.1:<puerto>` que LIFE escucha un momento. ID y secreto del cliente (`yt_client_id`, `yt_client_secret`) y token de renovación (`yt_refresh_token`) en las credenciales. La app de Google Cloud debe estar «publicada» o el permiso caduca a los 7 días. Sincroniza cada hora; suscriptores por día en `metricas_diarias`.

- El instalador (`LIFE_<versión>_x64-setup.exe`, NSIS, por usuario, sin permisos de administrador) no va a Git; se regenera con `npm run app:build`.
- Si se pierde la credencial `db_key`, `life.db` se aparta como `life.db.ilegible-<fecha>` y se empieza de cero: lo sincronizado se recupera, lo introducido a mano no.

## Convenciones

- Textos de interfaz y commits en español; commits en imperativo.
