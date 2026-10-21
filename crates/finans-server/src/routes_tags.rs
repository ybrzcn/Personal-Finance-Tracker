//! Etiketler ve işlemlere toplu etiket (oturum gerekir). Kurallar finans-core::store'da, rapor finans-core::tags'ta.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use finans_core::db::{Tag, TagInput, Transaction};
use finans_core::store;
use finans_core::tags::{self, TagsReport};
use serde::Deserialize;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/tags", get(list).post(create))
        .route("/api/tags/report", get(report))
        .route("/api/tags/{id}", put(update).delete(remove))
        .route("/api/transactions/tags", post(bulk))
}

async fn list(State(s): S, user: AuthUser) -> R<Json<Vec<Tag>>> {
    Ok(Json(with_user_db(&s, &user, |c| store::list_tags(c)).await?))
}

async fn create(State(s): S, user: AuthUser, Json(input): Json<TagInput>) -> R<(StatusCode, Json<Tag>)> {
    Ok((StatusCode::CREATED, Json(with_user_db(&s, &user, move |c| store::create_tag(c, input)).await?)))
}

async fn update(State(s): S, user: AuthUser, Path(id): Path<String>, Json(tag): Json<Tag>) -> R<Json<Tag>> {
    if tag.id != id {
        return Err("Kayıt kimliği uyuşmuyor.".to_string().into());
    }
    Ok(Json(with_user_db(&s, &user, move |c| store::update_tag(c, tag)).await?))
}

async fn remove(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| store::delete_tag(c, &id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn report(State(s): S, user: AuthUser) -> R<Json<TagsReport>> {
    Ok(Json(
        with_user_db(&s, &user, |c| {
            let list = store::list_tags(c)?;
            let txs = store::list_transactions(c)?;
            Ok(tags::report(&list, &txs))
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkBody {
    transaction_ids: Vec<String>,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

async fn bulk(State(s): S, user: AuthUser, Json(b): Json<BulkBody>) -> R<Json<Vec<Transaction>>> {
    Ok(Json(with_user_db(&s, &user, move |c| store::set_transaction_tags(c, &b.transaction_ids, &b.add, &b.remove)).await?))
}
