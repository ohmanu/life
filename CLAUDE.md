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
- Núcleo: Rust en `src-tauri/`. `lib.rs` (comandos, bandeja, arranque, sincronización periódica), `db.rs` (SQLite `life.db` en `%APPDATA%\com.glutamato.life`, migraciones añadidas al final de `MIGRATIONS`; cifrada en formato SQLCipher 4 con SQLite3 Multiple Ciphers que compila `build.rs`, sin OpenSSL; clave `db_key` en las credenciales de Windows), `github.rs`, `gmail.rs`, `secrets.rs`.
- Ventana sin marco nativo (`decorations: false`): la barra de título es propia. Cerrar esconde en la bandeja; salir desde el menú de la bandeja. Arranque con Windows opcional (`--bandeja`).
- Permisos de ventana y plugins en `src-tauri/capabilities/default.json`.

## Comandos

- `npm run app`: la app en modo desarrollo (arranca Astro en http://127.0.0.1:4321 y la ventana).
- `npm run dev`: solo la interfaz en el navegador, en modo demo.
- `npm run build`: `astro check` + build a `dist/`.
- `npm run app:build`: instalador NSIS en `src-tauri/target/release/bundle/nsis/`.
- `cargo test` en `src-tauri/`.

## Fases

0 Base (hecha) · 1 Encargos (Gmail, hecha) · 2 Dinero (Revolut: CSV, luego Open Banking) · 3 Redes (Instagram, YouTube) · 4 Parte del día y radar (Claude) · 5 Extras.

## Notas

- Gmail va por IMAP con contraseña de aplicación (`gmail_user`, `gmail_app_password` en las credenciales). Solo `EXAMINE` y `BODY.PEEK[]`: nunca marcar, mover, etiquetar, borrar ni enviar. «Respondido» = hay un correo tuyo a la dirección del cliente. Los demás estados se marcan en LIFE y no se escriben en Gmail.
- Sincronización: Gmail cada 10 min, GitHub cada hora. Avisos de Windows: encargo nuevo y 48 h sin respuesta (una vez por encargo).

- El instalador (`LIFE_<versión>_x64-setup.exe`, NSIS, por usuario, sin permisos de administrador) no va a Git; se regenera con `npm run app:build`.
- Si se pierde la credencial `db_key`, `life.db` se aparta como `life.db.ilegible-<fecha>` y se empieza de cero: lo sincronizado se recupera, lo introducido a mano no.

## Convenciones

- Textos de interfaz y commits en español; commits en imperativo.
