//! Compila SQLite3 Multiple Ciphers (formato SQLCipher 4, AES-256) como `sqlite3.lib`.
//! rusqlite va sin `bundled` y enlaza con esta biblioteca: así `life.db` se cifra
//! sin depender de OpenSSL ni de Perl.

fn main() {
  let src = sqlite3mc_src::source_dir();
  cc::Build::new()
    .file(src.join(sqlite3mc_src::SOURCE_FILE))
    .include(src)
    .define("SQLITE_THREADSAFE", "1")
    .define("SQLITE_DQS", "0")
    .define("SQLITE_DEFAULT_FOREIGN_KEYS", "1")
    .define("SQLITE_ENABLE_FTS5", None)
    .define("SQLITE_TEMP_STORE", "2")
    .define("SQLITE_SECURE_DELETE", None)
    .define("SQLITE_OMIT_DEPRECATED", None)
    .warnings(false)
    .compile("sqlite3");
  println!("cargo:rerun-if-changed=build.rs");

  tauri_build::build()
}
