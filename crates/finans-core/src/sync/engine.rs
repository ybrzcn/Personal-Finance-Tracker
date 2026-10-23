//! Eşitleme turu: sunucudaki şifreli anlık görüntüyü indir, bu cihazınkiyle birleştir, sonucu buraya uygula ve
//! sunucuya yaz (sürüm tutmazsa baştan). Durum ve son ortak sürüm uygulama veri klasöründe (`sync.json`,
//! `sync-base.json`); ikisi de veritabanı kadar korunur (veri anahtarı da `sync.json`'da).

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::crypto::{self, DataKey};
use super::merge::{self, MergeReport};
use super::remote::{Put, Remote};
use super::snapshot::{self, Snapshot};
use crate::{sqlite, CoreResult};

/// Anlık görüntü biçimi. Satır yapıları (hesap, işlem…) değişince artırılır: eski uygulama yeni biçimi
/// anlamadan yazıp yeni alanları silmesin diye eşitlemeyi durdurur.
pub const SCHEMA: u32 = 1;

pub const ERR_NOT_LINKED: &str = "Bu cihazda eşitleme açık değil.";
pub const ERR_KEY_CHANGED: &str = "Eşitleme başka bir cihazdan sıfırlanmış ya da kapatılmış; bu cihazı yeniden bağlayın.";

/// Sunucuya yüklenip anlık görüntüye girmemiş dosyalar bu kadar eskiyse silinir (başka cihaz yükleme ortasında olabilir)
const FILE_GRACE_SECS: i64 = 24 * 3600;

pub struct Ctx<'a> {
    pub conn: &'a Mutex<Connection>,
    /// Uygulama veri klasörü
    pub dir: &'a Path,
    /// Kullanılan veritabanı dosyası: eşitleme o dosyaya bağlıdır
    pub db_path: &'a str,
    pub user_id: &'a str,
    pub server_url: &'a str,
    pub token: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    user_id: String,
    server_url: String,
    db_path: String,
    key_id: String,
    key: String,
    /// Tabanın sunucudaki sürümü
    version: i64,
    #[serde(default)]
    last_sync: Option<String>,
    /// Bağlarken "sunucudakini indir" seçildi; sunucudaki veri ilk kez uygulanana kadar geçerli
    #[serde(default)]
    pending_replace: bool,
    /// Kaydı eşitlenmiş ama içeriği henüz indirilemeyen ekler: yerelde silinmiş sayılmaz, her turda yeniden istenir
    #[serde(default)]
    missing: BTreeSet<String>,
}

/// Şifreli zarf. `seq` yazıldığı sunucu sürümüdür ve şifrenin içinde doğrulanır: sunucu eski bir sürümü yeniymiş gibi
/// sunarsa (verileri geri almak için) fark edilir.
#[derive(Serialize, Deserialize)]
struct Envelope {
    schema: u32,
    seq: i64,
    snapshot: Snapshot,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Bu cihazda değişen satır sayısı
    pub pulled: usize,
    /// Sunucuya giden değişiklik sayısı
    pub pushed: usize,
    pub conflicts: usize,
    /// İçeriği henüz indirilemeyen ek sayısı (sonraki turda yeniden denenir)
    pub missing_files: usize,
    pub last_sync: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub linked: bool,
    pub last_sync: Option<String>,
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join("sync.json")
}

fn base_path(dir: &Path) -> PathBuf {
    dir.join("sync-base.json")
}

/// Atomik yazma: yarıda kalan yazma durumu bozmasın
fn write_json<T: Serialize>(path: &Path, v: &T) -> CoreResult<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| format!("Eşitleme durumu yazılamadı: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Eşitleme durumu yazılamadı: {e}"))
}

/// Bu kullanıcı, sunucu ve veritabanı için durum; başka birine aitse yok sayılır
fn load_state(ctx: &Ctx) -> Option<State> {
    let st: State = serde_json::from_slice(&std::fs::read(state_path(ctx.dir)).ok()?).ok()?;
    (st.user_id == ctx.user_id && st.server_url == ctx.server_url && st.db_path == ctx.db_path).then_some(st)
}

/// İndirilen ek içerikleri uygulanana kadar burada bekler (çok sayıda ekte ilerleme kaybolmasın)
fn cache_dir(dir: &Path) -> PathBuf {
    dir.join("sync-files")
}

fn cache_path(dir: &Path, id: &str) -> Option<PathBuf> {
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).then(|| cache_dir(dir).join(id))
}

fn load_base(dir: &Path) -> Snapshot {
    std::fs::read(base_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn key_of(st: &State) -> CoreResult<DataKey> {
    crypto::unb64(&st.key)?.try_into().map_err(|_| "Eşitleme anahtarı bozuk; bu cihazı yeniden bağlayın.".to_string())
}

fn encode(key: &DataKey, key_id: &str, seq: i64, snap: &Snapshot) -> Vec<u8> {
    let json = serde_json::to_vec(&Envelope { schema: SCHEMA, seq, snapshot: snap.clone() }).expect("anlık görüntü JSON");
    crypto::seal(key, key_id, "data", &crypto::compress(&json))
}

const ERR_ROLLBACK: &str = "Sunucudaki eşitleme verisi daha eski bir sürüme dönmüş görünüyor; veri korunmak için eşitleme durduruldu.";

/// `version`: sunucunun bildirdiği sürüm; `last`: bu cihazın gördüğü son sürüm
fn decode(key: &DataKey, key_id: &str, blob: &[u8], version: i64, last: i64) -> CoreResult<Snapshot> {
    let json = crypto::decompress(&crypto::open(key, key_id, "data", blob)?)?;
    #[derive(Deserialize)]
    struct Head {
        schema: u32,
    }
    let head: Head = serde_json::from_slice(&json).map_err(|_| "Eşitleme verisi okunamadı.".to_string())?;
    if head.schema > SCHEMA {
        return Err("Sunucudaki veri Finans'ın daha yeni bir sürümüyle eşitlenmiş; eşitlemeye devam etmek için uygulamayı güncelleyin.".into());
    }
    let env: Envelope = serde_json::from_slice(&json).map_err(|e| format!("Eşitleme verisi okunamadı: {e}"))?;
    if env.seq != version || version < last {
        return Err(ERR_ROLLBACK.into());
    }
    snapshot::check_known_fields(&env.snapshot)?;
    Ok(env.snapshot)
}

fn file_purpose(id: &str) -> String {
    format!("file:{id}")
}

/// Süreçler arası kilit: aynı veri klasörünü kullanan iki uygulama penceresi aynı anda eşitlemesin
/// (durum ve taban dosyalarını birbirinin üzerine yazmasın). Dönen dosya kapanınca kilit kalkar.
fn exclusive(dir: &Path) -> CoreResult<std::fs::File> {
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("sync.lock"))
        .map_err(|e| format!("Eşitleme kilidi açılamadı: {e}"))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err("Eşitleme başka bir Finans penceresinde sürüyor; biraz sonra tekrar deneyin.".into()),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("Eşitleme kilidi alınamadı: {e}")),
    }
}

pub fn status(ctx: &Ctx) -> Status {
    let st = load_state(ctx);
    Status { linked: st.is_some(), last_sync: st.and_then(|s| s.last_sync) }
}

/// Bu cihazdaki eşitleme durumu silinir (veri ve sunucu değişmez).
pub fn unlink(dir: &Path) {
    let _ = std::fs::remove_file(state_path(dir));
    let _ = std::fs::remove_file(base_path(dir));
    let _ = std::fs::remove_dir_all(cache_dir(dir));
}

fn link_state(ctx: &Ctx, key: &DataKey, key_id: &str, pending_replace: bool) -> CoreResult<()> {
    unlink(ctx.dir);
    write_json(
        &state_path(ctx.dir),
        &State {
            user_id: ctx.user_id.into(),
            server_url: ctx.server_url.into(),
            db_path: ctx.db_path.into(),
            key_id: key_id.into(),
            key: crypto::b64(key),
            version: 0,
            last_sync: None,
            pending_replace,
            missing: BTreeSet::new(),
        },
    )
}

/// Hesapta eşitlemeyi ilk kez açar: yeni anahtar, parolayla sarılıp sunucuya; bu cihazın verisi ilk turda yüklenir.
pub fn enable(ctx: &Ctx, passphrase: &str) -> CoreResult<Report> {
    crypto::check_passphrase(passphrase)?;
    let _lock = exclusive(ctx.dir)?;
    let remote = Remote::new(ctx.server_url, ctx.token);
    if let Some(kr) = remote.meta()?.keyring {
        // Bu cihazın açtığı ama ilk turu yarıda kalmış eşitleme: devam edilir
        if load_state(ctx).is_some_and(|st| st.key_id == kr.key_id) {
            return run_locked(ctx);
        }
        return Err("Bu hesapta eşitleme zaten açık; bu cihazı eşitleme parolasıyla bağlayın.".into());
    }
    let (key, key_id) = (crypto::new_key(), crypto::new_key_id());
    remote.put_keyring(&crypto::make_keyring(passphrase, &key, &key_id)?)?;
    link_state(ctx, &key, &key_id, false)?;
    run_locked(ctx)
}

/// Açık eşitlemeye bu cihazı bağlar. `replace`: bu cihazın verisi sunucudakiyle değiştirilir; değilse iki taraf
/// birleştirilir. `prepare` parola doğrulandıktan sonra, veriye dokunmadan önce çağrılır (ör. yerel yedek).
pub fn link(ctx: &Ctx, passphrase: &str, replace: bool, prepare: impl FnOnce() -> CoreResult<()>) -> CoreResult<Report> {
    let _lock = exclusive(ctx.dir)?;
    let remote = Remote::new(ctx.server_url, ctx.token);
    let kr = remote.meta()?.keyring.ok_or("Bu hesapta eşitleme açık değil.")?;
    let key = crypto::open_keyring(passphrase, &kr)?;
    prepare()?;
    link_state(ctx, &key, &kr.key_id, replace)?;
    run_locked(ctx)
}

/// Eşitleme parolasını değiştirir (veri anahtarı aynı kalır; öbür cihazlar etkilenmez).
pub fn change_passphrase(ctx: &Ctx, passphrase: &str) -> CoreResult<()> {
    let _lock = exclusive(ctx.dir)?;
    let st = load_state(ctx).ok_or(ERR_NOT_LINKED)?;
    let remote = Remote::new(ctx.server_url, ctx.token);
    remote.put_keyring(&crypto::make_keyring(passphrase, &key_of(&st)?, &st.key_id)?)
}

/// Sunucudaki şifreli veriyi siler ve bu cihazı ayırır (öbür cihazlar sonraki turda durur; verileri yerinde kalır).
pub fn delete_remote(ctx: &Ctx, password: &str) -> CoreResult<()> {
    let _lock = exclusive(ctx.dir)?;
    Remote::new(ctx.server_url, ctx.token).delete_all(password)?;
    unlink(ctx.dir);
    Ok(())
}

fn local_attachment_ids(conn: &Mutex<Connection>) -> CoreResult<HashSet<String>> {
    let mut c = conn.lock().unwrap_or_else(|e| e.into_inner());
    sqlite::run(&mut c, |s| Ok(snapshot::list_attachments(s)?.into_iter().map(|a| a.id).collect()))
}

fn save(ctx: &Ctx, st: &State, base: &Snapshot) -> CoreResult<()> {
    write_json(&base_path(ctx.dir), base)?;
    write_json(&state_path(ctx.dir), st)
}

/// Bir eşitleme turu.
pub fn run(ctx: &Ctx) -> CoreResult<Report> {
    let _lock = exclusive(ctx.dir)?;
    run_locked(ctx)
}

fn run_locked(ctx: &Ctx) -> CoreResult<Report> {
    let mut st = load_state(ctx).ok_or(ERR_NOT_LINKED)?;
    let key = key_of(&st)?;
    let remote = Remote::new(ctx.server_url, ctx.token);
    let mut base = load_base(ctx.dir);
    let cache = cache_dir(ctx.dir);
    for _ in 0..4 {
        let meta = remote.meta()?;
        if meta.keyring.as_ref().map(|k| &k.key_id) != Some(&st.key_id) {
            return Err(ERR_KEY_CHANGED.into());
        }
        if meta.version < st.version {
            return Err(ERR_ROLLBACK.into());
        }
        let (rv, r, has_remote) = if meta.version == st.version && !st.pending_replace {
            (st.version, base.clone(), st.version > 0)
        } else {
            match remote.get_data()? {
                Some((v, blob)) => (v, decode(&key, &st.key_id, &blob, v, st.version)?, true),
                None if st.version > 0 => return Err(ERR_ROLLBACK.into()),
                None => (0, Snapshot::default(), false),
            }
        };
        // Sunucuda veri yokken "indir" seçilse de bu cihazın verisi silinmez
        let replace = st.pending_replace && has_remote;

        // Ek içerikleri kilit dışında, diske indirilir: bu cihazda olmayan ve burada silinmemiş olanlar.
        // Ağ hatası ya da istek sınırında kalanlar eksik sayılır, sonraki turda devam edilir.
        let have = local_attachment_ids(ctx.conn)?;
        for id in r.attachment_ids() {
            let deleted_here = !replace
                && !st.missing.contains(id)
                && base.row("attachments", id).is_some()
                && base.row("attachments", id) == r.row("attachments", id);
            let Some(path) = cache_path(ctx.dir, id) else { continue };
            if have.contains(id) || deleted_here || path.exists() {
                continue;
            }
            match remote.get_file(id) {
                Ok(Some(blob)) => {
                    // Açılamayan (bozuk) dosya turu durdurmaz; eksik kalır
                    if let Ok(plain) = crypto::open(&key, &st.key_id, &file_purpose(id), &blob) {
                        let _ = std::fs::create_dir_all(&cache);
                        let tmp = path.with_extension("tmp");
                        if std::fs::write(&tmp, &plain).is_ok() {
                            let _ = std::fs::rename(&tmp, &path);
                        }
                    }
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }

        // Birleştirme ve uygulama tek veritabanı işleminde (arada yapılan değişiklik kaybolmasın)
        let (m, rep, missing) = {
            let mut c = ctx.conn.lock().unwrap_or_else(|e| e.into_inner());
            sqlite::run(&mut c, |s| {
                let real = snapshot::read(s)?;
                // İçeriği gelmemiş ekler burada silinmiş sayılmasın (işlemi duruyorsa)
                let mut l = real.clone();
                for id in &st.missing {
                    let row = base.row("attachments", id).cloned();
                    let tx = row.as_ref().and_then(|v| v.get("transactionId")).and_then(|v| v.as_str()).map(str::to_string);
                    if let (Some(row), Some(tx)) = (row, tx) {
                        if real.row("transactions", &tx).is_some() {
                            l.tables.entry("attachments".into()).or_default().entry(id.clone()).or_insert(row);
                        }
                    }
                }
                let (m, rep) = if replace {
                    (r.clone(), MergeReport { local_changes: merge::diff(&real, &r), remote_changes: 0, conflicts: 0 })
                } else {
                    merge::merge(&base, &l, &r)
                };
                if m != l {
                    snapshot::apply_changes(s, &real, &m)?;
                }
                let content = |id: &str| cache_path(ctx.dir, id).and_then(|p| std::fs::read(p).ok());
                let missing = if m != real { snapshot::apply_attachments(s, &m, &content)? } else { HashSet::new() };
                Ok((m, rep, missing))
            })?
        };

        // Bu cihaz artık sunucunun `rv` sürümünü içeriyor: taban hemen o olur. Yükleme başarısız olursa bu cihazdaki
        // (henüz gitmemiş) değişiklikler sonraki turda yine yerel değişiklik sayılır; sunucudan gelenler sayılmaz.
        base = r.clone();
        st.version = rv;
        st.pending_replace = false;
        st.missing = missing.iter().cloned().collect();
        save(ctx, &st, &base)?;
        if let Ok(entries) = std::fs::read_dir(&cache) {
            for e in entries.flatten() {
                if !missing.contains(e.file_name().to_string_lossy().as_ref()) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }

        // Sunucuda olmayan ekler yüklenir (anlık görüntüden önce: öbür cihaz bulamazsa diye)
        let server_files = remote.list_files()?;
        let on_server: HashSet<&str> = server_files.iter().map(|f| f.id.as_str()).collect();
        for id in m.attachment_ids() {
            if on_server.contains(id.as_str()) || missing.contains(id) {
                continue;
            }
            let content = {
                let mut c = ctx.conn.lock().unwrap_or_else(|e| e.into_inner());
                sqlite::run(&mut c, |s| s.get_attachment(id))?
            };
            if let Some((_, data)) = content {
                remote.put_file(&st.key_id, id, &crypto::seal(&key, &st.key_id, &file_purpose(id), &data))?;
            }
        }

        if m != r {
            match remote.put_data(&st.key_id, rv, &encode(&key, &st.key_id, rv + 1, &m))? {
                Put::Ok(v) => {
                    base = m.clone();
                    st.version = v;
                }
                Put::Conflict => continue,
            }
        }
        let now = crate::backup::now_iso();
        st.last_sync = Some(now.clone());
        save(ctx, &st, &base)?;

        // Artık hiçbir kayda bağlı olmayan eski dosyalar sunucudan silinir
        let cutoff = crate::fx::time::unix_now() - FILE_GRACE_SECS;
        let referenced: HashSet<&String> = m.attachment_ids().collect();
        for f in &server_files {
            if !referenced.contains(&f.id) && f.created_at < cutoff {
                let _ = remote.delete_file(&f.id);
            }
        }

        return Ok(Report {
            pulled: rep.local_changes,
            pushed: if m != r { rep.remote_changes } else { 0 },
            conflicts: rep.conflicts,
            missing_files: missing.len(),
            last_sync: now,
        });
    }
    Err("Eşitleme sırasında sunucudaki veri sürekli değişti; biraz sonra tekrar deneyin.".into())
}
