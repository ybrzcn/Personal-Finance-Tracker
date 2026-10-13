use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::State;

use finans_core::db::{
    self, Account, AccountInput, Budget, Category, CategoryInput, RecurringItem, Transaction, TransactionInput,
};
use finans_core::store::{self, db_err};

pub struct AppState {
    pub conn: Mutex<Connection>,
    /// Kullanılan veritabanı dosyası (kullanıcı başka bir dosya seçebilir)
    pub db_path: Mutex<PathBuf>,
    /// Uygulama veri klasöründeki varsayılan veritabanı
    pub default_db_path: PathBuf,
    /// Seçilen veritabanı yolunun saklandığı ayar dosyası
    pub config_path: PathBuf,
    /// Seçili veritabanı açılışta bulunamadı/açılamadı ve varsayılana dönüldüyse o yol (kullanıcı uyarılır)
    pub fallback_from: Mutex<Option<String>>,
}

/// Uygulama ayar dosyası (veri klasöründe `config.json`).
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub database_path: Option<String>,
    /// Hesap ve veri yeri (sunucu adresi, oturum, mod)
    #[serde(default)]
    pub client: ClientConfig,
}

/// Masaüstü istemci durumu. Token düz metin olarak uygulama veri klasöründeki config.json'da durur.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_email: Option<String>,
    /// "local": veri bu cihazda, "server": veri sunucuda; boş: henüz seçilmedi
    #[serde(default)]
    pub mode: Option<String>,
}

pub fn read_config(path: &Path) -> AppConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(path: &Path, config: &AppConfig) -> CmdResult<()> {
    // Okunamayan (bozuk) dosyanın üzerine yazmadan önce kopyası saklanır: içindeki veritabanı yolu/hesap elle kurtarılabilsin
    if let Ok(existing) = std::fs::read_to_string(path) {
        if serde_json::from_str::<AppConfig>(&existing).is_err() {
            let _ = std::fs::copy(path, path.with_extension("json.bozuk"));
        }
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    // Oturum token'ı içerir: önce yalnız kullanıcıya açık (0600) geçici dosyaya yazılır, sonra yerine taşınır
    // (dosya hiçbir an başkalarına okunur izinle durmaz, yarım yazılmış dosya da kalmaz)
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| format!("Ayar dosyası yazılamadı: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        f.write_all(json.as_bytes()).map_err(|e| format!("Ayar dosyası yazılamadı: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Ayar dosyası yazılamadı: {e}"))?;
    Ok(())
}

fn db_path(state: &State<'_, AppState>) -> PathBuf {
    state.db_path.lock().map(|p| p.clone()).unwrap_or_else(|_| state.default_db_path.clone())
}

pub type CmdResult<T> = Result<T, String>;

fn lock<'a>(state: &'a State<'_, AppState>) -> CmdResult<MutexGuard<'a, Connection>> {
    state
        .conn
        .lock()
        .map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())
}

// ---------------------------------------------------------------------------
// Veri işlemleri (finans-core/store; burada yalnız kilit + çağrı)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_categories(state: State<'_, AppState>) -> CmdResult<Vec<Category>> {
    store::list_categories(&*lock(&state)?)
}

#[tauri::command]
pub fn create_category(state: State<'_, AppState>, input: CategoryInput) -> CmdResult<Category> {
    store::create_category(&*lock(&state)?, input)
}

#[tauri::command]
pub fn update_category(state: State<'_, AppState>, category: Category) -> CmdResult<Category> {
    store::update_category(&*lock(&state)?, category)
}

#[tauri::command]
pub fn delete_category(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    store::delete_category(&*lock(&state)?, &id)
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> CmdResult<Vec<Account>> {
    store::list_accounts(&*lock(&state)?)
}

#[tauri::command]
pub fn create_account(state: State<'_, AppState>, input: AccountInput) -> CmdResult<Account> {
    store::create_account(&*lock(&state)?, input)
}

#[tauri::command]
pub fn update_account(state: State<'_, AppState>, account: Account) -> CmdResult<Account> {
    store::update_account(&*lock(&state)?, account)
}

#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    store::delete_account(&*lock(&state)?, &id)
}

#[tauri::command]
pub fn list_transactions(state: State<'_, AppState>) -> CmdResult<Vec<Transaction>> {
    store::list_transactions(&*lock(&state)?)
}

#[tauri::command]
pub fn create_transaction(state: State<'_, AppState>, input: TransactionInput) -> CmdResult<Transaction> {
    store::create_transaction(&*lock(&state)?, input)
}

#[tauri::command]
pub fn update_transaction(state: State<'_, AppState>, transaction: Transaction) -> CmdResult<Transaction> {
    store::update_transaction(&*lock(&state)?, transaction)
}

#[tauri::command]
pub fn delete_transaction(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    store::delete_transaction(&*lock(&state)?, &id)
}

#[tauri::command]
pub fn list_recurring(state: State<'_, AppState>) -> CmdResult<Vec<RecurringItem>> {
    store::list_recurring(&*lock(&state)?)
}

#[tauri::command]
pub fn create_recurring(state: State<'_, AppState>, item: RecurringItem) -> CmdResult<RecurringItem> {
    store::create_recurring(&*lock(&state)?, item)
}

#[tauri::command]
pub fn update_recurring(state: State<'_, AppState>, item: RecurringItem) -> CmdResult<RecurringItem> {
    store::update_recurring(&*lock(&state)?, item)
}

#[tauri::command]
pub fn delete_recurring(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    store::delete_recurring(&*lock(&state)?, &id)
}

#[tauri::command]
pub fn list_budgets(state: State<'_, AppState>) -> CmdResult<Vec<Budget>> {
    store::list_budgets(&*lock(&state)?)
}

#[tauri::command]
pub fn set_budget(state: State<'_, AppState>, category_id: String, amount: Option<f64>) -> CmdResult<()> {
    store::set_budget(&*lock(&state)?, &category_id, amount)
}

#[tauri::command]
pub fn restore_data(state: State<'_, AppState>, categories: Vec<Category>, accounts: Vec<Account>, transactions: Vec<Transaction>, recurring: Vec<RecurringItem>, budgets: Vec<Budget>) -> CmdResult<()> {
    store::restore_data(&mut *lock(&state)?, categories, accounts, transactions, recurring, budgets)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<serde_json::Map<String, serde_json::Value>> {
    store::get_settings(&*lock(&state)?)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    store::set_setting(&*lock(&state)?, &key, value)
}

/// Hesap ve veri yeri bilgileri (sunucu adresi, oturum, mod).
#[tauri::command]
pub fn get_client_config(state: State<'_, AppState>) -> ClientConfig {
    read_config(&state.config_path).client
}

#[tauri::command]
pub fn set_client_config(state: State<'_, AppState>, config: ClientConfig) -> CmdResult<()> {
    if !matches!(config.mode.as_deref(), None | Some("local") | Some("server")) {
        return Err("Geçersiz mod.".into());
    }
    if let Some(url) = config.server_url.as_deref().filter(|u| !u.is_empty()) {
        if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 2048 {
            return Err("Geçersiz sunucu adresi.".into());
        }
    }
    let mut all = read_config(&state.config_path);
    all.client = config;
    write_config(&state.config_path, &all)
}

/// Veritabanının tutarlı bir kopyasını (VACUUM INTO) veri klasörüne alır; dosya yolunu döner.
#[tauri::command]
pub fn backup_database(state: State<'_, AppState>) -> CmdResult<String> {
    let conn = lock(&state)?;
    let stamp: String = conn
        .query_row("SELECT strftime('%Y%m%d-%H%M%S', 'now', 'localtime')", [], |r| r.get(0))
        .map_err(db_err)?;
    let path = db_path(&state).with_file_name(format!("finans.db.sifirlama-oncesi-{stamp}.bak"));
    conn.execute("VACUUM INTO ?1", [path.display().to_string()])
        .map_err(|e| format!("Yedek alınamadı: {e}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn data_location(state: State<'_, AppState>) -> String {
    db_path(&state).display().to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    path: String,
    is_default: bool,
    /// Seçili veritabanı açılışta açılamadığı için varsayılan kullanılıyorsa seçili olan yol
    fallback_from: Option<String>,
}

#[tauri::command]
pub fn database_info(state: State<'_, AppState>) -> DatabaseInfo {
    let path = db_path(&state);
    let fallback_from = state.fallback_from.lock().ok().and_then(|f| f.clone());
    DatabaseInfo { is_default: path == state.default_db_path, path: path.display().to_string(), fallback_from }
}

fn check_db_extension(path: &Path) -> CmdResult<()> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("db") | Some("sqlite") | Some("sqlite3") => Ok(()),
        _ => Err("Veritabanı dosyası .db, .sqlite veya .sqlite3 uzantılı olmalıdır.".into()),
    }
}

/// İki yol aynı dosyayı mı gösteriyor (macOS'ta büyük/küçük harf, sembolik bağlar dahil)?
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        // Hedef henüz yoksa klasörü çözülür, dosya adı harf duyarsız karşılaştırılır
        _ => {
            let dir = |p: &Path| p.parent().and_then(|d| std::fs::canonicalize(d).ok());
            let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
            dir(a).is_some() && dir(a) == dir(b) && name(a) == name(b)
        }
    }
}

/// Seçilen konuma veritabanının tutarlı bir kopyasını kaydeder (dosya varsa üzerine yazılır).
#[tauri::command]
pub fn save_database_copy(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let target = PathBuf::from(&path);
    check_db_extension(&target)?;
    let conn = lock(&state)?;
    if same_file(&target, &db_path(&state)) {
        return Err("Yedek, kullanılan veritabanının üzerine kaydedilemez.".into());
    }
    // VACUUM INTO var olan dosyaya yazmaz: önce geçici dosyaya yazılır, sonra hedefin üzerine taşınır
    // (kaydet penceresi üzerine yazma onayını zaten aldı; eski dosya ancak yedek başarılıysa değişir)
    let tmp = target.with_extension("finans-tmp");
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
        .map_err(|e| format!("Yedek alınamadı: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Yedek kaydedilemedi: {e}")
    })?;
    Ok(())
}

/// Dosyanın Finans veritabanı (veya boş) olduğunu doğrular.
fn check_finans_database(path: &Path) -> CmdResult<()> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Dosya açılamadı: {e}"))?;
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .map_err(|_| "Bu dosya bir SQLite veritabanı değil.".to_string())?;
    if !tables.is_empty() && !(tables.iter().any(|t| t == "categories") && tables.iter().any(|t| t == "transactions")) {
        return Err("Bu dosya bir Finans veritabanı değil.".into());
    }
    Ok(())
}

fn switch_to(state: &State<'_, AppState>, path: PathBuf) -> CmdResult<DatabaseInfo> {
    let new_conn = db::open(&path).map_err(|e| format!("Veritabanı açılamadı: {e}"))?;
    let mut conn = lock(state)?;
    *conn = new_conn;
    if let Ok(mut p) = state.db_path.lock() {
        *p = path.clone();
    }
    let is_default = path == state.default_db_path;
    // Yalnız veritabanı yolu değişir; hesap bilgileri korunur
    let mut config = read_config(&state.config_path);
    config.database_path = if is_default { None } else { Some(path.display().to_string()) };
    write_config(&state.config_path, &config)?;
    if let Ok(mut f) = state.fallback_from.lock() {
        *f = None;
    }
    Ok(DatabaseInfo { path: path.display().to_string(), is_default, fallback_from: None })
}

/// Var olan bir Finans veritabanına (`create = false`) ya da yeni boş bir veritabanına (`create = true`) geçer.
/// Seçim `config.json`'a kaydedilir ve sonraki açılışlarda kullanılır.
#[tauri::command]
pub fn open_database(state: State<'_, AppState>, path: String, create: bool) -> CmdResult<DatabaseInfo> {
    let target = PathBuf::from(&path);
    check_db_extension(&target)?;
    if create {
        if target.exists() {
            return Err("Bu konumda zaten bir dosya var. Var olan veritabanını açmak için \"Veritabanı aç\"ı kullanın.".into());
        }
    } else {
        if !target.exists() {
            return Err("Dosya bulunamadı.".into());
        }
        check_finans_database(&target)?;
    }
    switch_to(&state, target)
}

/// Uygulama veri klasöründeki varsayılan veritabanına döner.
#[tauri::command]
pub fn use_default_database(state: State<'_, AppState>) -> CmdResult<DatabaseInfo> {
    let path = state.default_db_path.clone();
    switch_to(&state, path)
}

// ---------------------------------------------------------------------------
// Banka ekstresi dosyaları (CSV / TXT / Excel / PDF)
// ---------------------------------------------------------------------------

/// Ekstre dosyasını içerikten okur (masaüstü ve mobil). Dosyayı arayüz, kullanıcının seçtiği yoldan fs eklentisiyle
/// (mobilde dosya seçiciyle) okur; Rust'a yol değil bayt gelir. Baytlar IPC'ye ham gövde olarak gelir, dosya adı
/// `x-file-name` başlığında (URL kodlu).
#[tauri::command]
pub async fn parse_statement_bytes(request: tauri::ipc::Request<'_>) -> CmdResult<finans_core::statement::StatementFile> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dosya okunamadı.".into());
    };
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Dosya çok büyük (en fazla 25 MB).".into());
    }
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    finans_core::statement::parse(&name, bytes)
}

/// encodeURIComponent'in tersi (yalnız dosya adı için; geçersiz dizilerde olduğu gibi bırakır).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Mobil: dışa aktarılan dosyayı uygulamanın Belgeler klasörüne yazar (iOS'ta Dosyalar uygulamasında "Finans"
/// altında görünür); tam yolu döner.
#[tauri::command]
pub fn save_export(app: tauri::AppHandle, name: String, contents: String) -> CmdResult<String> {
    use tauri::Manager;
    let name: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':')).collect();
    if name.trim().is_empty() {
        return Err("Geçersiz dosya adı.".into());
    }
    let dir = app.path().document_dir().map_err(|e| format!("Belgeler klasörü bulunamadı: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    // Aynı adda dosya varsa üzerine yazılmaz: "ad (2).json"
    let mut path = dir.join(&name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut n = 2;
    while path.exists() && n < 1000 {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, contents).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    Ok(path.display().to_string())
}

