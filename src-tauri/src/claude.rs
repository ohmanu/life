//! Claude a través de Claude Code (la versión de terminal), con la sesión de tu suscripción.
//! LIFE lo llama sin herramientas, sin MCP, sin ajustes ni sesiones guardadas, desde una carpeta
//! vacía: solo recibe un texto con los datos de la tarea y devuelve texto. Nunca le llegan tokens.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Dónde está `claude.exe`: el instalador oficial lo pone en %USERPROFILE%\.local\bin.
pub fn ejecutable() -> Option<PathBuf> {
    let local = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".local").join("bin").join("claude.exe"));
    if let Some(p) = local.filter(|p| p.exists()) {
        return Some(p);
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|d| d.join("claude.exe")).find(|p| p.exists())
    })
}

fn comando(exe: &Path, dir: &Path) -> Command {
    let mut c = Command::new(exe);
    c.current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin consola parpadeando
    }
    c
}

#[derive(Serialize, Clone, Debug)]
pub struct Estado {
    pub instalado: bool,
    pub sesion: bool,
    pub metodo: Option<String>,
}

pub fn estado(dir: &Path) -> Estado {
    let Some(exe) = ejecutable() else { return Estado { instalado: false, sesion: false, metodo: None } };
    let out = comando(&exe, dir).args(["auth", "status"]).stdin(Stdio::null()).output();
    let v: Value = out.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null);
    Estado {
        instalado: true,
        sesion: v["loggedIn"].as_bool().unwrap_or(false),
        metodo: v["authMethod"].as_str().filter(|m| *m != "none").map(str::to_string),
    }
}

/// Pregunta a Claude (bloqueante). `sistema` fija el tono y el formato; `texto` lleva los datos.
pub fn preguntar(dir: &Path, modelo: &str, sistema: &str, texto: &str, limite: Duration) -> Result<String, String> {
    let exe = ejecutable().ok_or("Claude Code no está instalado (F5 → Claude).")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut hijo = comando(&exe, dir)
        .args([
            "-p",
            "--output-format",
            "json",
            "--model",
            modelo,
            "--tools",
            "",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--system-prompt",
            sistema,
        ])
        .spawn()
        .map_err(|e| format!("No se pudo abrir Claude Code: {e}"))?;
    if let Some(mut stdin) = hijo.stdin.take() {
        stdin.write_all(texto.as_bytes()).map_err(|e| e.to_string())?;
    }
    let inicio = Instant::now();
    loop {
        match hijo.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if inicio.elapsed() > limite => {
                let _ = hijo.kill();
                return Err("Claude tardó demasiado en responder.".into());
            }
            None => std::thread::sleep(Duration::from_millis(150)),
        }
    }
    let out = hijo.wait_with_output().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        format!("Claude Code no respondió bien. {}", err.lines().next().unwrap_or(""))
    })?;
    let res = v["result"].as_str().unwrap_or("").trim().to_string();
    if v["is_error"].as_bool() == Some(true) {
        let low = res.to_lowercase();
        return Err(if low.contains("authenticate") || low.contains("login") || low.contains("oauth") {
            "Claude Code no tiene la sesión iniciada: en una terminal, claude auth login.".into()
        } else if low.contains("limit") {
            format!("Has llegado al límite de tu plan de Claude por ahora. {res}")
        } else {
            format!("Claude respondió con un error. {res}")
        });
    }
    if res.is_empty() {
        return Err("Claude devolvió una respuesta vacía.".into());
    }
    Ok(res)
}

/// Tono y formato del parte. Los datos van aparte, en el texto.
pub const SISTEMA_PARTE: &str = "Eres el parte del día de LIFE, un panel personal en una consola de radio. \
Escribe en español de España, tuteando, frases cortas y concretas, sin saludos ni despedidas ni relleno. \
Devuelve SOLO entre 4 y 7 líneas, una idea por línea, sin viñetas ni numeración ni encabezados. \
Ordena por lo que más pide atención hoy. Usa **así** para resaltar cifras o nombres clave y empieza con ! la línea \
que sea una alarma (por ejemplo un encargo sin responder más de 48 h o un gasto muy por encima de lo normal). \
Usa solo los datos que te dan; si algo no está, no lo inventes ni lo menciones. No des consejos financieros.";

pub const SISTEMA_SEMANA: &str = "Eres el parte semanal de LIFE, un panel personal en una consola de radio. \
Escribe en español de España, tuteando, frases cortas, sin saludos ni relleno. Resume la semana que acaba: \
qué cambió en encargos, dinero, redes, código y el radar de vida, comparando con la semana anterior cuando haya datos. \
Devuelve SOLO entre 5 y 8 líneas, una idea por línea, sin viñetas ni encabezados. Usa **así** para resaltar y \
empieza con ! lo que se esté descompensando. Usa solo los datos que te dan. No des consejos financieros.";

pub const SISTEMA_PREGUNTA: &str = "Eres LIFE, un panel personal. Respondes preguntas con los datos del usuario que \
vienen en el mensaje (JSON). Español de España, tuteando, directo y breve (como mucho 6 líneas). Haz las cuentas \
con cuidado y di de qué datos sale la cifra. Si los datos no bastan para responder, dilo y explica qué faltaría. \
No inventes. Puedes usar **así** para resaltar. No des consejos financieros personalizados.";
