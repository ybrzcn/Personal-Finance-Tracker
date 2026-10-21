//! Veri uç noktaları: masaüstündeki Tauri komutlarının REST karşılığı. Tüm iş kuralları finans-core::store'da.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use finans_core::db::{
    Account, AccountInput, Budget, Category, CategoryInput, Goal, RecurringItem, Tag, Transaction, TransactionInput,
};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::store;
use serde::Deserialize;
use serde_json::{json, Value};

use std::process::Stdio;
use std::time::Duration;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

/// Geri yükleme ve ekstre dosyaları için gövde sınırı.
const BODY_LIMIT: usize = 25 * 1024 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/categories", get(list_categories).post(create_category))
        .route("/api/categories/{id}", put(update_category).delete(delete_category))
        .route("/api/accounts", get(list_accounts).post(create_account))
        .route("/api/accounts/{id}", put(update_account).delete(delete_account))
        .route("/api/transactions", get(list_transactions).post(create_transaction))
        .route("/api/transactions/{id}", put(update_transaction).delete(delete_transaction))
        .route("/api/recurring", get(list_recurring).post(create_recurring))
        .route("/api/recurring/{id}", put(update_recurring).delete(delete_recurring))
        .route("/api/recurring/{id}/exception", put(set_recurring_exception))
        .route("/api/reset/seed", get(reset_seed))
        .route("/api/budgets", get(list_budgets))
        .route("/api/budgets/{category_id}", put(set_budget))
        .route("/api/settings", get(get_settings))
        .route("/api/settings/{key}", put(set_setting))
        .route("/api/restore", post(restore))
        .route("/api/export", get(export))
        .route("/api/statements/parse", post(parse_statement))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

fn check_id(path_id: &str, body_id: &str) -> R<()> {
    if path_id == body_id {
        Ok(())
    } else {
        Err("Kayıt kimliği uyuşmuyor.".to_string().into())
    }
}

/// Bir kaynak için listele / ekle / güncelle / sil işleyicileri.
macro_rules! crud {
    ($list:ident, $create:ident, $update:ident, $delete:ident, $ty:ty, $input:ty) => {
        async fn $list(State(s): S, user: AuthUser) -> R<Json<Vec<$ty>>> {
            Ok(Json(with_user_db(&s, &user, |c| store::$list(c)).await?))
        }

        async fn $create(State(s): S, user: AuthUser, Json(input): Json<$input>) -> R<(StatusCode, Json<$ty>)> {
            Ok((StatusCode::CREATED, Json(with_user_db(&s, &user, move |c| store::$create(c, input)).await?)))
        }

        async fn $update(State(s): S, user: AuthUser, Path(id): Path<String>, Json(item): Json<$ty>) -> R<Json<$ty>> {
            check_id(&id, &item.id)?;
            Ok(Json(with_user_db(&s, &user, move |c| store::$update(c, item)).await?))
        }

        async fn $delete(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
            with_user_db(&s, &user, move |c| store::$delete(c, &id)).await?;
            Ok(StatusCode::NO_CONTENT)
        }
    };
}

crud!(list_categories, create_category, update_category, delete_category, Category, CategoryInput);
crud!(list_accounts, create_account, update_account, delete_account, Account, AccountInput);
async fn list_transactions(State(s): S, user: AuthUser) -> R<Json<Vec<Transaction>>> {
    Ok(Json(with_user_db(&s, &user, |c| store::list_transactions(c)).await?))
}

async fn create_transaction(State(s): S, user: AuthUser, Json(input): Json<TransactionInput>) -> R<(StatusCode, Json<Transaction>)> {
    Ok((StatusCode::CREATED, Json(with_user_db(&s, &user, move |c| store::create_transaction(c, input)).await?)))
}

/// Gövdede `tagIds` yoksa (eski istemci) işlemin etiketleri korunur
async fn update_transaction(State(s): S, user: AuthUser, Path(id): Path<String>, Json(body): Json<Value>) -> R<Json<Transaction>> {
    let keep = body.get("tagIds").is_none();
    let item: Transaction = serde_json::from_value(body).map_err(|e| ApiError::from(format!("Geçersiz işlem: {e}")))?;
    check_id(&id, &item.id)?;
    let tags = if keep { None } else { Some(item.tag_ids.clone()) };
    Ok(Json(with_user_db(&s, &user, move |c| store::update_transaction_with(c, item, tags)).await?))
}

async fn delete_transaction(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| store::delete_transaction(c, &id)).await?;
    Ok(StatusCode::NO_CONTENT)
}
// Düzenli kayıt eklenirken gövde tam kayıttır; id yok sayılır (yenisi üretilir)
crud!(list_recurring, create_recurring, update_recurring, delete_recurring, RecurringItem, RecurringItem);

/// Ödeme Takvimi'nde "bu ay yatmayacak" / geri alma; başka kullanıcının kaydı 404
async fn set_recurring_exception(State(s): S, user: AuthUser, Path(id): Path<String>, Json(req): Json<store::ExceptionRequest>) -> R<Json<RecurringItem>> {
    match with_user_db(&s, &user, move |c| store::set_recurring_exception(c, &id, req)).await? {
        Some(item) => Ok(Json(item)),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "Bulunamadı.")),
    }
}

/// "Verileri sıfırla": varsayılan kategoriler ve boş "Genel Hesap" (arayüz bugünkü gibi geri yükler)
async fn reset_seed(_user: AuthUser) -> Json<store::ResetSeed> {
    Json(store::reset_seed(&ymd(istanbul_today(unix_now()))))
}

async fn list_budgets(State(s): S, user: AuthUser) -> R<Json<Vec<Budget>>> {
    Ok(Json(with_user_db(&s, &user, |c| store::list_budgets(c)).await?))
}

#[derive(Deserialize)]
struct BudgetBody {
    amount: Option<f64>,
}

async fn set_budget(State(s): S, user: AuthUser, Path(category_id): Path<String>, Json(b): Json<BudgetBody>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| store::set_budget(c, &category_id, b.amount)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_settings(State(s): S, user: AuthUser) -> R<Json<serde_json::Map<String, Value>>> {
    Ok(Json(with_user_db(&s, &user, |c| store::get_settings(c)).await?))
}

async fn set_setting(State(s): S, user: AuthUser, Path(key): Path<String>, Json(value): Json<Value>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| store::set_setting(c, &key, value)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RestoreBody {
    categories: Vec<Category>,
    accounts: Vec<Account>,
    transactions: Vec<Transaction>,
    recurring: Vec<RecurringItem>,
    budgets: Vec<Budget>,
    /// Eski yedeklerde yok
    #[serde(default)]
    goals: Vec<Goal>,
    /// Eski yedeklerde yok
    #[serde(default)]
    tags: Option<Vec<Tag>>,
}

async fn restore(State(s): S, user: AuthUser, Json(b): Json<RestoreBody>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| {
        store::restore_data(c, b.categories, b.accounts, b.transactions, b.recurring, b.budgets, b.goals, b.tags)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Kullanıcının tüm verisi (yedek indirme / "bu cihaza indir").
async fn export(State(s): S, user: AuthUser) -> R<Json<Value>> {
    let data = with_user_db(&s, &user, |c| {
        Ok(json!({
            "categories": store::list_categories(c)?,
            "accounts": store::list_accounts(c)?,
            "transactions": store::list_transactions(c)?,
            "recurring": store::list_recurring(c)?,
            "budgets": store::list_budgets(c)?,
            "goals": store::list_goals(c)?,
            "tags": store::list_tags(c)?,
            "settings": store::get_settings(c)?,
        }))
    })
    .await?;
    Ok(Json(data))
}

#[derive(Deserialize)]
struct NameQuery {
    name: String,
}

/// Ekstre dosyasını okur; veritabanına dokunmaz. Ayrıştırma bellek/süre sınırlı bir alt süreçte çalışır
/// (bozuk ya da kötü niyetli Excel/PDF sunucuyu düşüremesin); kullanıcı başına hız ve eşzamanlılık sınırı vardır.
async fn parse_statement(State(s): S, user: AuthUser, Query(q): Query<NameQuery>, body: Bytes) -> R<Json<Value>> {
    use tokio::io::AsyncWriteExt;
    if !s.limiter.allow(&format!("parse:{}", user.id), 20, Duration::from_secs(60)) {
        return Err(ApiError::too_many());
    }
    let _permit = s.parse_permits.acquire().await.map_err(ApiError::internal)?;
    let unreadable = || ApiError::from("Dosya okunamadı: çok büyük, bozuk ya da desteklenmeyen biçim.".to_string());
    let exe = std::env::current_exe().map_err(ApiError::internal)?;
    let name: String = q.name.chars().take(255).collect();
    let mut child = tokio::process::Command::new(exe)
        .arg("parse-statement")
        .arg(name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(ApiError::internal)?;
    if let Some(mut stdin) = child.stdin.take() {
        // Alt süreç erken çıkarsa yazma hatası önemsiz; sonucu çıktısı belirler
        let _ = stdin.write_all(&body).await;
    }
    let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| unreadable())?
        .map_err(ApiError::internal)?;
    if !out.status.success() {
        return Err(unreadable());
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| unreadable())?;
    match v.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(Json(v.get("file").cloned().unwrap_or(Value::Null))),
        _ => Err(v.get("error").and_then(Value::as_str).map(str::to_string).map(ApiError::from).unwrap_or_else(unreadable)),
    }
}
