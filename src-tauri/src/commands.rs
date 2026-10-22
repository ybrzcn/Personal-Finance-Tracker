use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::State;

use finans_core::db::{
    self, Account, AccountInput, Budget, Category, CategoryInput, Goal, RecurringItem, Tag, Transaction, TransactionInput,
};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::sqlite::{self, db_err};
use finans_core::store;

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
    /// TCMB EVDS API anahtarı (TÜFE); yalnız bu cihazda, sunucuya ve yedeğe gitmez
    #[serde(default)]
    pub evds_api_key: Option<String>,
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

pub(crate) fn lock<'a>(state: &'a State<'_, AppState>) -> CmdResult<MutexGuard<'a, Connection>> {
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
    sqlite::run(&mut *lock(&state)?, |s| store::list_categories(s))
}

#[tauri::command]
pub fn create_category(state: State<'_, AppState>, input: CategoryInput) -> CmdResult<Category> {
    sqlite::run(&mut *lock(&state)?, |s| store::create_category(s, input))
}

#[tauri::command]
pub fn update_category(state: State<'_, AppState>, category: Category) -> CmdResult<Category> {
    sqlite::run(&mut *lock(&state)?, |s| store::update_category(s, category))
}

#[tauri::command]
pub fn delete_category(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_category(s, &id))
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> CmdResult<Vec<Account>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_accounts(s))
}

#[tauri::command]
pub fn create_account(state: State<'_, AppState>, input: AccountInput) -> CmdResult<Account> {
    sqlite::run(&mut *lock(&state)?, |s| store::create_account(s, input))
}

#[tauri::command]
pub fn update_account(state: State<'_, AppState>, account: Account) -> CmdResult<Account> {
    sqlite::run(&mut *lock(&state)?, |s| store::update_account(s, account))
}

#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_account(s, &id))
}

#[tauri::command]
pub fn list_transactions(state: State<'_, AppState>) -> CmdResult<Vec<Transaction>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_transactions(s))
}

#[tauri::command]
pub fn create_transaction(state: State<'_, AppState>, input: TransactionInput) -> CmdResult<Transaction> {
    sqlite::run(&mut *lock(&state)?, |s| store::create_transaction(s, input))
}

#[tauri::command]
pub fn update_transaction(state: State<'_, AppState>, transaction: serde_json::Value) -> CmdResult<Transaction> {
    // Gövdede tagIds yoksa (eski arayüz) etiketler korunur
    let keep = transaction.get("tagIds").is_none();
    let t: Transaction = serde_json::from_value(transaction).map_err(|e| format!("Geçersiz işlem: {e}"))?;
    let tags = if keep { None } else { Some(t.tag_ids.clone()) };
    sqlite::run(&mut *lock(&state)?, |s| store::update_transaction_with(s, t, tags))
}

#[tauri::command]
pub fn delete_transaction(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_transaction(s, &id))
}

#[tauri::command]
pub fn list_recurring(state: State<'_, AppState>) -> CmdResult<Vec<RecurringItem>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_recurring(s))
}

#[tauri::command]
pub fn create_recurring(state: State<'_, AppState>, item: RecurringItem) -> CmdResult<RecurringItem> {
    sqlite::run(&mut *lock(&state)?, |s| store::create_recurring(s, item))
}

#[tauri::command]
pub fn update_recurring(state: State<'_, AppState>, item: RecurringItem) -> CmdResult<RecurringItem> {
    sqlite::run(&mut *lock(&state)?, |s| store::update_recurring(s, item))
}

#[tauri::command]
pub fn set_recurring_exception(state: State<'_, AppState>, id: String, month: String, amount: Option<f64>, note: String) -> CmdResult<RecurringItem> {
    sqlite::run(&mut *lock(&state)?, |s| store::set_recurring_exception(s, &id, store::ExceptionRequest { month, amount, note }))?
        .ok_or_else(|| "Kayıt bulunamadı.".to_string())
}

/// "Verileri sıfırla": varsayılan kategoriler ve boş "Genel Hesap"
#[tauri::command]
pub fn reset_seed() -> store::ResetSeed {
    store::reset_seed(&ymd(istanbul_today(unix_now())))
}

#[derive(serde::Serialize)]
pub struct Matured {
    account: Account,
    transaction: Option<Transaction>,
}

/// Dönemsel raporlar (dönem, karşılaştırma, kırılım, gelir akışı)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reports_report(
    state: State<'_, AppState>,
    preset: String,
    from: Option<String>,
    to: Option<String>,
    compare: String,
    kind: String,
    group: String,
) -> CmdResult<finans_core::reports::ReportsReport> {
    let today = ymd(istanbul_today(unix_now()));
    let (txs, cats) = sqlite::run(&mut *lock(&state)?, |s| Ok((store::list_transactions(s)?, store::list_categories(s)?)))?;
    Ok(finans_core::reports::report(&finans_core::reports::ReportsInput {
        transactions: &txs,
        categories: &cats,
        preset: &preset,
        from: from.as_deref().filter(|s| !s.is_empty()),
        to: to.as_deref().filter(|s| !s.is_empty()),
        compare: &compare,
        kind: &kind,
        group: &group,
        today: &today,
    })?)
}

/// İşleme ek: ham gövde dosya içeriği; işlem kimliği ve ad (URL kodlu) başlıklarda. Eşzamansız: büyük dosya arayüzü
/// bekletmesin
#[tauri::command]
pub async fn attachment_add(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<db::Attachment> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Dosya içeriği okunamadı.".into()) };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let name = percent_decode(&header("x-name"));
    let tx = header("x-transaction-id");
    sqlite::run(&mut *lock(&state)?, |s| store::add_attachment(s, &tx, &name, bytes, None))
}

#[tauri::command]
pub fn attachment_list(state: State<'_, AppState>, transaction_id: String) -> CmdResult<Vec<db::Attachment>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_attachments(s, &transaction_id))
}

#[tauri::command]
pub fn attachment_counts(state: State<'_, AppState>) -> CmdResult<std::collections::BTreeMap<String, i64>> {
    sqlite::run(&mut *lock(&state)?, store::attachment_counts)
}

/// Ek içeriği ham bayt olarak (arayüzde ArrayBuffer)
#[tauri::command]
pub async fn attachment_content(state: State<'_, AppState>, id: String) -> CmdResult<tauri::ipc::Response> {
    let found = sqlite::run(&mut *lock(&state)?, |s| store::get_attachment(s, &id))?;
    found.map(|(_, data)| tauri::ipc::Response::new(data)).ok_or_else(|| "Belge bulunamadı.".to_string())
}

#[tauri::command]
pub fn attachment_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if sqlite::run(&mut *lock(&state)?, |s| store::delete_attachment(s, &id))? {
        Ok(())
    } else {
        Err("Belge bulunamadı.".into())
    }
}

/// PDF fişten tutar ve tarih önerisi (ham gövde); ayrıştırıcı panikleri yakalanır
#[tauri::command]
pub async fn receipt_parse(request: tauri::ipc::Request<'_>) -> CmdResult<finans_core::receipt::ReceiptHint> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Dosya içeriği okunamadı.".into()) };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || finans_core::receipt::parse_pdf(&bytes)).await.map_err(|e| e.to_string())?
}

/// Vadesi dolan mevduatın faizini kaydeder; yeniler ya da vadesize çevirir
#[tauri::command]
pub fn deposit_mature(state: State<'_, AppState>, id: String, renew: bool) -> CmdResult<Matured> {
    let today = ymd(istanbul_today(unix_now()));
    let (account, transaction) = sqlite::run(&mut *lock(&state)?, |s| store::deposit_mature(s, &id, renew, &today))?;
    Ok(Matured { account, transaction })
}

/// Otomatik kaydı açık düzenli kayıtların günü gelmiş ödemelerini işlem olarak ekler; eklenenler ve eklenemeyenler
#[tauri::command]
pub fn auto_post_recurring(state: State<'_, AppState>) -> CmdResult<store::AutoPostResult> {
    sqlite::run(&mut *lock(&state)?, |s| store::auto_post_recurring(s, &ymd(istanbul_today(unix_now()))))
}

#[tauri::command]
pub fn delete_recurring(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_recurring(s, &id))
}

#[tauri::command]
pub fn list_budgets(state: State<'_, AppState>) -> CmdResult<Vec<Budget>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_budgets(s))
}

#[tauri::command]
pub fn set_budget(state: State<'_, AppState>, category_id: String, amount: Option<f64>) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::set_budget(s, &category_id, amount))
}

#[tauri::command]
pub fn set_budget_rollover(state: State<'_, AppState>, category_id: String, from: Option<String>) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::set_budget_rollover(s, &category_id, from.as_deref()))
}

// Yedekteki her veri türü ayrı argüman (arayüzün gönderdiği biçim)
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn restore_data(state: State<'_, AppState>, categories: Vec<Category>, accounts: Vec<Account>, transactions: Vec<Transaction>, recurring: Vec<RecurringItem>, budgets: Vec<Budget>, goals: Option<Vec<Goal>>, tags: Option<Vec<Tag>>) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::restore_data(s, categories, accounts, transactions, recurring, budgets, goals.unwrap_or_default(), tags))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<serde_json::Map<String, serde_json::Value>> {
    sqlite::run(&mut *lock(&state)?, |s| store::get_settings(s))
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::set_setting(s, &key, value))
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
pub async fn parse_statement_bytes(request: tauri::ipc::Request<'_>) -> CmdResult<finans_core::import::StatementRead> {
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
    // Tablo, özet ve sütun tahmini Rust'ta (finans-core::import)
    finans_core::import::read_statement(&finans_core::statement::parse(&name, bytes)?)
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

/// EVDS anahtarı girilmiş mi (anahtarın kendisi arayüze dönmez)
#[tauri::command]
pub fn evds_key_set(state: State<'_, AppState>) -> bool {
    read_config(&state.config_path).evds_api_key.is_some_and(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn set_evds_key(state: State<'_, AppState>, key: Option<String>) -> CmdResult<()> {
    let mut config = read_config(&state.config_path);
    config.evds_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    write_config(&state.config_path, &config)
}
