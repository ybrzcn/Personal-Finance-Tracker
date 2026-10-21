//! Form önizlemeleri (oturum gerekir): işlem, hesap ve düzenli kayıt formlarının kayıttan önceki hesapları. Hesap finans-core::forms'ta.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use finans_core::forms::{self, needs_transactions, wants_suggestion, AccountDraft, AccountPreview, RecurringDraft, RecurringPreview, TransactionDraft, TransactionPreview};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::import::{card_for, statement_totals, CardDraft, StatementCard, StatementTotals, TotalsDraft};
use finans_core::rules::{read_rules, rule_preview, RuleDraft, RulePreview};
use finans_core::store;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/preview/transaction", post(transaction))
        .route("/api/preview/account", post(account))
        .route("/api/preview/recurring", post(recurring))
        .route("/api/preview/statement-card", post(statement_card))
        .route("/api/preview/statement-totals", post(statement_totals_route))
        .route("/api/preview/category-rule", post(category_rule))
}

fn today() -> String {
    ymd(istanbul_today(unix_now()))
}

async fn transaction(State(s): State<Arc<AppState>>, user: AuthUser, Json(d): Json<TransactionDraft>) -> Result<Json<TransactionPreview>, ApiError> {
    let today = today();
    let out = with_user_db(&s, &user, move |c| {
        let accounts = store::list_accounts(c)?;
        // İşlemler yalnız nakit eksi denetimi ve kategori önerisi için; kategoriler ve kurallar yalnız öneri için gerekir
        let txs = if needs_transactions(&d, &accounts) { store::list_transactions(c)? } else { Vec::new() };
        let (cats, rules) = if wants_suggestion(&d) { (store::list_categories(c)?, read_rules(&store::get_settings(c)?)) } else { (Vec::new(), Vec::new()) };
        Ok(forms::transaction_preview(&d, &accounts, &txs, &cats, &rules, &today))
    })
    .await?;
    Ok(Json(out))
}

async fn account(State(s): State<Arc<AppState>>, user: AuthUser, Json(d): Json<AccountDraft>) -> Result<Json<AccountPreview>, ApiError> {
    let today = today();
    let out = with_user_db(&s, &user, move |c| {
        let usage = match d.account_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => c.account_usage(id)?,
            None => 0,
        };
        Ok(forms::account_preview(&d, usage, &today))
    })
    .await?;
    Ok(Json(out))
}

async fn recurring(_user: AuthUser, Json(d): Json<RecurringDraft>) -> Json<RecurringPreview> {
    Json(forms::recurring_preview(&d, &today()))
}

async fn statement_card(State(s): State<Arc<AppState>>, user: AuthUser, Json(d): Json<CardDraft>) -> Result<Json<StatementCard>, ApiError> {
    let out = with_user_db(&s, &user, move |c| Ok(card_for(&d, &store::list_accounts(c)?))).await?;
    Ok(Json(out))
}

async fn statement_totals_route(_user: AuthUser, Json(d): Json<TotalsDraft>) -> Json<StatementTotals> {
    Json(statement_totals(&d.rows, d.period_spending))
}

async fn category_rule(State(s): State<Arc<AppState>>, user: AuthUser, Json(d): Json<RuleDraft>) -> Result<Json<RulePreview>, ApiError> {
    let out = with_user_db(&s, &user, move |c| Ok(rule_preview(&d, &store::list_transactions(c)?))).await?;
    Ok(Json(out))
}
