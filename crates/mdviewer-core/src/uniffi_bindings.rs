//! UniFFI-facing wrappers.
//!
//! The UDL (`mdviewer_core.udl`) declares the *shape* of the FFI surface
//! Kotlin sees; this module supplies the *bodies* the scaffolding
//! dispatches to. Names + signatures here MUST match the UDL exactly.
//!
//! ## Why these are wrappers, not direct re-exports
//!
//! - The on-disk types in `anchor.rs`, `comments.rs`, and `document.rs`
//!   carry `usize` offsets, optional fields, and serde / ts-rs derives
//!   that the UDL machinery doesn't model. The wrappers narrow each
//!   shape to a Kotlin-friendly form and down-cast `usize -> u32`
//!   (sidecars and source files are bounded well below 4 GiB).
//! - `CommentsStore` itself is `&mut`-mutable in Rust. UniFFI's
//!   threading model demands interior mutability behind a single
//!   `Arc<T>` handle, so we wrap it in `Mutex` and expose only `&self`
//!   methods. Mutation methods land in D1.
//! - Errors produced by the inner crates flow as `anyhow::Error`. The
//!   `From` impl on `CoreError::Internal` funnels them through the
//!   UDL's `[Throws=CoreError]` channel without losing the message.

use crate::anchor::Anchor as CoreAnchor;
use crate::comments::{
    merge_stores as core_merge_stores, Comment as CoreComment, CommentsStore,
    NewComment as CoreNewComment, NewThread as CoreNewThread, Thread as CoreThread,
};
use crate::document::{
    render_markdown as core_render, RenderOptions as CoreRenderOptions,
    RenderResult as CoreRenderResult,
};
use crate::sidecar::{
    load_sidecar_bytes as core_load_sidecar, save_sidecar_bytes as core_save_sidecar,
};
use crate::sidecar_path::sidecar_filename as core_sidecar_filename;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Single error type surfaced through UniFFI's `[Throws=CoreError]`.
///
/// The UDL declares `[Error] enum CoreError` with fieldless variants,
/// which maps to a Kotlin sealed class whose subclasses each carry the
/// thrown message via `Throwable.message` (UniFFI 0.28 forwards the
/// `Display` impl as the exception's `message` field). Keeping the Rust
/// enum fieldless (matching the UDL) makes the macro-generated FFI
/// shims compile; we still get a useful message at the Kotlin call site
/// because the `Display` impls below stamp the relevant detail string.
///
/// The `last_error_message` accessor exists so the wrappers can stash a
/// per-thread copy of the underlying message without forcing the UDL to
/// switch from the simpler fieldless shape to a payload-bearing
/// `[Error] interface`. The accessor is not exposed via the UDL.
#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("parse: {0}")]
    Parse(String),
    #[error("schema: {0}")]
    Schema(String),
    #[error("automerge: {0}")]
    Automerge(String),
    #[error("internal: {0}")]
    Internal(String),
    /// D1: surfaced when a mutation references a `thread_id` that no
    /// longer exists in the store. Distinct from `Internal` so the
    /// Kotlin layer can route the error to a "thread no longer exists"
    /// toast rather than a generic crash banner.
    #[error("not found: {0}")]
    NotFound(String),
}

impl From<anyhow::Error> for CoreError {
    fn from(e: anyhow::Error) -> Self {
        // Without a structured tag we treat every anyhow error as
        // Internal; callers needing finer routing should map at the
        // source-module boundary (e.g., parse failures in sidecar.rs)
        // before bubbling up.
        CoreError::Internal(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Re-exported / wrapped types whose UDL shape differs from the core shape.
// ---------------------------------------------------------------------------

/// UDL-shaped render options. Re-uses the core type by alias because the
/// field names + types align byte-for-byte (booleans, no offsets).
pub type RenderOptions = CoreRenderOptions;

/// UDL-shaped render result: `html` + `Vec<SrcSpan>`. Core's `RenderResult`
/// has `text_spans: Vec<(usize, usize)>` which UniFFI cannot model
/// (anonymous tuple, `usize`); the wrapper projects each pair to a named
/// `SrcSpan` with a `dom_index` (currently mirrors the array index — the
/// frontend uses it to disambiguate within a stream of identical-text
/// spans).
#[derive(Debug, Clone)]
pub struct RenderResult {
    pub html: String,
    pub spans: Vec<SrcSpan>,
}

#[derive(Debug, Clone)]
pub struct SrcSpan {
    pub dom_index: u32,
    pub src_start: u32,
    pub src_end: u32,
}

impl From<CoreRenderResult> for RenderResult {
    fn from(r: CoreRenderResult) -> Self {
        let spans = r
            .text_spans
            .iter()
            .enumerate()
            .map(|(i, (s, e))| SrcSpan {
                dom_index: u32_or_max(i),
                src_start: u32_or_max(*s),
                src_end: u32_or_max(*e),
            })
            .collect();
        Self {
            html: r.html,
            spans,
        }
    }
}

/// UDL-shaped Anchor. Core's `Anchor` uses `usize` offsets and serde
/// derives we don't surface to Kotlin; the wrapper renames fields to
/// W3C-spec-flavored names (`selector_text` / `context_before|after`)
/// because the Kotlin call sites match the W3C TextQuoteSelector
/// vocabulary that Android's selection-toolbar surfaces.
#[derive(Debug, Clone)]
pub struct Anchor {
    pub selector_text: String,
    pub context_before: String,
    pub context_after: String,
    pub char_start: u32,
    pub char_end: u32,
}

impl From<CoreAnchor> for Anchor {
    fn from(a: CoreAnchor) -> Self {
        Self {
            selector_text: a.exact,
            context_before: a.prefix,
            context_after: a.suffix,
            char_start: u32_or_max(a.start),
            char_end: u32_or_max(a.end),
        }
    }
}

/// D1: reverse direction so the mutation entry points (`create_thread`)
/// can take a UDL-shaped `Anchor` from Kotlin and feed it into core's
/// `CommentsStore::create_thread` without forcing the call site to
/// build a `CoreAnchor` directly. The `u32 -> usize` cast is always
/// widening (target_pointer_width >= 32 is a Rust language guarantee),
/// so no fallibility.
impl From<Anchor> for CoreAnchor {
    fn from(a: Anchor) -> Self {
        Self {
            start: a.char_start as usize,
            end: a.char_end as usize,
            exact: a.selector_text,
            prefix: a.context_before,
            suffix: a.context_after,
        }
    }
}

/// UDL-shaped Comment. Core's `Comment` carries Drive-side optional
/// fields (`author_email`, `drive_id`) that B1 doesn't surface. The
/// Kotlin side gets the minimum it needs to render a thread; D1 widens
/// the shape if the Android UI grows author-avatar or pending-pill
/// affordances.
#[derive(Debug, Clone)]
pub struct Comment {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub author_color: String,
    pub body: String,
    pub created_at: String,
}

impl From<CoreComment> for Comment {
    fn from(c: CoreComment) -> Self {
        Self {
            id: c.id,
            // The legacy Phase-1 schema squashed author identity into a
            // single `author` string. Until D1 introduces a separate
            // identifier (today `author_email` is Drive-only), the wrapper
            // surfaces the same value as both `author_id` and
            // `author_name` so the Kotlin side has stable keys.
            author_id: c.author.clone(),
            author_name: c.author,
            author_color: c.color,
            body: c.body,
            created_at: c.created_at,
        }
    }
}

/// UDL-shaped Thread. The UDL collapses `resolved_at` / `resolved_by`
/// (optional + only useful for resolution audit trails) and exposes only
/// the boolean + a synthesized `created_at`. `created_at` is taken from
/// the first comment's timestamp (the moment the thread was created)
/// because there isn't a separate per-thread timestamp in the model.
#[derive(Debug, Clone)]
pub struct Thread {
    pub id: String,
    pub anchor: Anchor,
    pub comments: Vec<Comment>,
    pub resolved: bool,
    pub created_at: String,
}

impl From<CoreThread> for Thread {
    fn from(t: CoreThread) -> Self {
        let created_at = t
            .comments
            .first()
            .map(|c| c.created_at.clone())
            .unwrap_or_default();
        Self {
            id: t.id,
            anchor: t.anchor.into(),
            comments: t.comments.into_iter().map(Comment::from).collect(),
            resolved: t.resolved,
            created_at,
        }
    }
}

/// UDL-shaped input for `create_thread`. Flattens the core type's
/// nested `first_comment: NewComment` into top-level fields because
/// the Kotlin call site collects "anchor + body + author" from a
/// single form (PostThreadSheet) and a nested struct would force a
/// two-step constructor. The `From` impl below maps back to the core
/// shape so the existing `CommentsStore::create_thread` body is
/// re-used verbatim.
///
/// The `author_id` field is recorded in the synthesized first comment's
/// `author` slot today. When the desktop schema grows a separate
/// per-author identity field (Drive-side, see `author_email` in
/// `comments.rs`), this wrapper will route `author_id` there instead.
#[derive(Debug, Clone)]
pub struct NewThread {
    pub anchor: Anchor,
    pub body: String,
    pub author_id: String,
    pub author_name: String,
    pub author_color: String,
}

impl From<NewThread> for CoreNewThread {
    fn from(n: NewThread) -> Self {
        Self {
            anchor: n.anchor.into(),
            first_comment: CoreNewComment {
                // The legacy v1 schema squashes author identity into a
                // single `author` string; until D-phase widens it we
                // prefer `author_name` here so the rendered thread
                // shows the human-readable label rather than an opaque id.
                author: n.author_name,
                color: n.author_color,
                body: n.body,
            },
        }
    }
}

/// UDL-shaped input for `post_reply`. Mirrors `NewThread` minus the
/// anchor (the parent thread already owns the anchor).
#[derive(Debug, Clone)]
pub struct NewComment {
    pub body: String,
    pub author_id: String,
    pub author_name: String,
    pub author_color: String,
}

impl From<NewComment> for CoreNewComment {
    fn from(n: NewComment) -> Self {
        Self {
            author: n.author_name,
            color: n.author_color,
            body: n.body,
        }
    }
}

// ---------------------------------------------------------------------------
// CommentsStoreHandle — UniFFI's interior-mutable wrapper over CommentsStore.
// ---------------------------------------------------------------------------

/// Opaque interface handle exposed via `interface CommentsStoreHandle` in
/// the UDL. Wraps the inner `CommentsStore` in a `Mutex` so all UniFFI
/// methods can take `&self` (mandatory for UDL methods) while still
/// permitting future mutation entry points (D1).
pub struct CommentsStoreHandle {
    inner: Mutex<CommentsStore>,
}

impl CommentsStoreHandle {
    /// Used by `load_sidecar_bytes` below; not exposed in the UDL.
    fn from_store(store: CommentsStore) -> Self {
        Self {
            inner: Mutex::new(store),
        }
    }

    /// UDL: `sequence<Thread> threads()`. Returns a snapshot (cloned) of
    /// the thread list at call time. Snapshotting is intentional: Kotlin
    /// callers walk the list without holding the lock, and a mutating
    /// caller (D1) can flip a thread's resolved state without
    /// invalidating the iterator the UI thread is walking.
    pub fn threads(&self) -> Vec<Thread> {
        self.inner
            .lock()
            .expect("CommentsStoreHandle mutex poisoned")
            .list_threads()
            .iter()
            .cloned()
            .map(Thread::from)
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Top-level functions wired up by the UDL `namespace mdviewer_core { ... }`.
// ---------------------------------------------------------------------------

/// UDL: `[Throws=CoreError] RenderResult render_markdown(string source, RenderOptions opts);`
pub fn render_markdown(
    source: String,
    opts: RenderOptions,
) -> Result<RenderResult, CoreError> {
    let core_result = core_render(&source, &opts);
    Ok(core_result.into())
}

/// UDL: `[Throws=CoreError] CommentsStoreHandle load_sidecar_bytes(bytes data);`
pub fn load_sidecar_bytes(data: Vec<u8>) -> Result<Arc<CommentsStoreHandle>, CoreError> {
    let store = core_load_sidecar(&data)?;
    Ok(Arc::new(CommentsStoreHandle::from_store(store)))
}

/// UDL: `[Throws=CoreError] bytes save_sidecar_bytes(CommentsStoreHandle store);`
pub fn save_sidecar_bytes(
    store: Arc<CommentsStoreHandle>,
) -> Result<Vec<u8>, CoreError> {
    let guard = store
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    Ok(core_save_sidecar(&guard)?)
}

/// UDL: `string sidecar_filename(string doc_filename, string pattern);`
///
/// Infallible: matches the core helper's signature and the UDL omits
/// `[Throws=CoreError]` accordingly.
pub fn sidecar_filename(doc_filename: String, pattern: String) -> String {
    core_sidecar_filename(&doc_filename, &pattern)
}

// ---------------------------------------------------------------------------
// D1: thread mutation surface.
// ---------------------------------------------------------------------------
//
// Each mutation takes the `Arc<CommentsStoreHandle>` Kotlin already
// owns and reaches the inner `CommentsStore` through its `Mutex`.
// UniFFI does not model `&mut self` on interface methods, so we expose
// these as top-level functions in the namespace and let the lock
// scope match each call.
//
// Returning `Thread` / `Comment` (rather than `()`) is deliberate: the
// caller wants the freshly-minted `id` + `created_at` to push back into
// the UI without a second `threads()` round-trip.
//
// Errors funnel through `CoreError::NotFound("thread")` so the Kotlin
// layer can disambiguate "your thread no longer exists" from a
// generic `Internal`.

/// UDL: `[Throws=CoreError] Thread create_thread(CommentsStoreHandle store, NewThread input);`
pub fn create_thread(
    store: Arc<CommentsStoreHandle>,
    input: NewThread,
) -> Result<Thread, CoreError> {
    let mut guard = store
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    let core_thread = guard.create_thread(input.into());
    Ok(core_thread.into())
}

/// UDL: `[Throws=CoreError] Comment post_reply(CommentsStoreHandle store, string thread_id, NewComment input);`
///
/// Returns the freshly-appended comment so Kotlin can render it
/// without a second snapshot. `CoreError::NotFound("thread")` covers
/// the "user clicked Post on a thread that was just deleted on
/// another device" race.
pub fn post_reply(
    store: Arc<CommentsStoreHandle>,
    thread_id: String,
    input: NewComment,
) -> Result<Comment, CoreError> {
    let mut guard = store
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    guard
        .post_reply(&thread_id, input.into())
        .map_err(|_| CoreError::NotFound("thread".into()))?;
    // post_reply on the core type returns `Result<()>`; pull the
    // freshly-appended comment by reading the last entry of the matching
    // thread. Single-threaded view because we still hold the Mutex guard.
    let last = guard
        .get_thread(&thread_id)
        .and_then(|t| t.comments.last().cloned())
        .ok_or_else(|| CoreError::NotFound("thread".into()))?;
    Ok(last.into())
}

/// UDL: `[Throws=CoreError] void resolve_thread(CommentsStoreHandle store, string thread_id);`
///
/// `by` (the resolver's display name) is sourced from the thread's
/// last comment author. The desktop tracks resolver identity per call
/// from the IPC layer; the Android UI doesn't yet split commenter
/// identity from resolver identity, so the last-comment-author is the
/// closest stable proxy without leaking a synthetic "system" author.
pub fn resolve_thread(
    store: Arc<CommentsStoreHandle>,
    thread_id: String,
) -> Result<(), CoreError> {
    let mut guard = store
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    let by = guard
        .get_thread(&thread_id)
        .and_then(|t| t.comments.last().map(|c| c.author.clone()))
        .unwrap_or_default();
    guard
        .resolve_thread(&thread_id, &by)
        .map_err(|_| CoreError::NotFound("thread".into()))?;
    Ok(())
}

/// UDL: `[Throws=CoreError] void unresolve_thread(CommentsStoreHandle store, string thread_id);`
pub fn unresolve_thread(
    store: Arc<CommentsStoreHandle>,
    thread_id: String,
) -> Result<(), CoreError> {
    let mut guard = store
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    guard
        .unresolve_thread(&thread_id)
        .map_err(|_| CoreError::NotFound("thread".into()))?;
    Ok(())
}

/// UDL: `CommentsStoreHandle merge_stores(CommentsStoreHandle local, CommentsStoreHandle incoming);`
///
/// Wraps `mdviewer_core::comments::merge_stores` — the same Automerge
/// merge the desktop already uses. Returns a NEW handle (not a
/// mutation of `local`) because the Kotlin call site is the
/// auto-merge=Always reload path: it builds a new handle from the
/// merged store and re-renders, dropping the prior local handle.
///
/// Infallible at the UDL level: `merge_stores` falls back to `local`
/// on encode/decode failures, so there is no error to surface.
pub fn merge_stores(
    local: Arc<CommentsStoreHandle>,
    incoming: Arc<CommentsStoreHandle>,
) -> Arc<CommentsStoreHandle> {
    let lg = local
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    let ig = incoming
        .inner
        .lock()
        .expect("CommentsStoreHandle mutex poisoned");
    let merged = core_merge_stores(&lg, &ig);
    Arc::new(CommentsStoreHandle::from_store(merged))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `usize -> u32` saturating cast. Sidecars + source files are bounded
/// well below 4 GiB in practice; the saturate-to-`u32::MAX` fallback is
/// defensive — clipping is preferable to a panic from `try_into().unwrap()`
/// inside the UniFFI scaffolding hot path.
fn u32_or_max(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::Anchor as CoreAnchor;
    use crate::comments::{Comment as CoreComment, Thread as CoreThread};

    /// Round-trip an anchor through the wrapper and verify every field
    /// crosses the boundary intact, including the `usize -> u32` cast.
    #[test]
    fn anchor_into_wrapper_preserves_fields() {
        let core = CoreAnchor {
            start: 10,
            end: 25,
            exact: "selected text".into(),
            prefix: "before".into(),
            suffix: "after".into(),
        };
        let wrapped: Anchor = core.into();
        assert_eq!(wrapped.selector_text, "selected text");
        assert_eq!(wrapped.context_before, "before");
        assert_eq!(wrapped.context_after, "after");
        assert_eq!(wrapped.char_start, 10);
        assert_eq!(wrapped.char_end, 25);
    }

    /// Pin the `created_at` synthesis: empty comment list -> empty
    /// string. A regression here would surface as Kotlin nullability
    /// surprises at the UI layer.
    #[test]
    fn thread_with_no_comments_has_empty_created_at() {
        let core = CoreThread {
            id: "t1".into(),
            anchor: CoreAnchor {
                start: 0,
                end: 0,
                exact: String::new(),
                prefix: String::new(),
                suffix: String::new(),
            },
            comments: vec![],
            resolved: false,
            resolved_at: None,
            resolved_by: None,
        };
        let wrapped: Thread = core.into();
        assert_eq!(wrapped.created_at, "");
        assert_eq!(wrapped.comments.len(), 0);
    }

    /// First-comment timestamp drives the synthesized thread
    /// `created_at`. Pin it so a future re-ordering of comments doesn't
    /// silently change the field's meaning.
    #[test]
    fn thread_created_at_uses_first_comment_timestamp() {
        let core = CoreThread {
            id: "t1".into(),
            anchor: CoreAnchor {
                start: 0,
                end: 1,
                exact: "x".into(),
                prefix: String::new(),
                suffix: String::new(),
            },
            comments: vec![
                CoreComment {
                    id: "c1".into(),
                    author: "alice".into(),
                    color: "#ff0000".into(),
                    body: "hi".into(),
                    created_at: "2025-01-01T00:00:00Z".into(),
                    author_email: None,
                    drive_id: None,
                },
                CoreComment {
                    id: "c2".into(),
                    author: "bob".into(),
                    color: "#00ff00".into(),
                    body: "yo".into(),
                    created_at: "2025-01-02T00:00:00Z".into(),
                    author_email: None,
                    drive_id: None,
                },
            ],
            resolved: false,
            resolved_at: None,
            resolved_by: None,
        };
        let wrapped: Thread = core.into();
        assert_eq!(wrapped.created_at, "2025-01-01T00:00:00Z");
        assert_eq!(wrapped.comments.len(), 2);
        assert_eq!(wrapped.comments[0].author_id, "alice");
        assert_eq!(wrapped.comments[0].author_name, "alice");
    }

    /// `usize::MAX` saturates to `u32::MAX` rather than panicking. This
    /// guards the `usize -> u32` cast on a 64-bit host where a stray
    /// large offset (test fixture, fuzzer input) shouldn't crash the
    /// FFI boundary.
    #[test]
    fn u32_or_max_saturates_on_overflow() {
        assert_eq!(u32_or_max(0), 0);
        assert_eq!(u32_or_max(42), 42);
        assert_eq!(u32_or_max(u32::MAX as usize), u32::MAX);
        // Only meaningful on 64-bit; 32-bit treats usize == u32 so the
        // cast is identity. `cfg!` keeps the test honest on either.
        if cfg!(target_pointer_width = "64") {
            assert_eq!(u32_or_max(usize::MAX), u32::MAX);
        }
    }

    /// `From<anyhow::Error>` always lands in `Internal` and preserves
    /// the underlying message. Pin it so the UDL's `[Throws=CoreError]`
    /// contract stays meaningful for opaque failure modes.
    #[test]
    fn anyhow_error_funnels_into_internal_variant() {
        let err: CoreError = anyhow::anyhow!("kaboom").into();
        match err {
            CoreError::Internal(msg) => assert!(msg.contains("kaboom")),
            other => panic!("expected Internal variant, got {other:?}"),
        }
    }

    /// Render-result projection: text_spans -> SrcSpan with monotonic
    /// `dom_index`. Empty input must produce empty `spans`.
    #[test]
    fn render_result_projection_assigns_dom_index() {
        let core = CoreRenderResult {
            html: "<h1>hi</h1>".into(),
            text_spans: vec![(0, 1), (1, 2), (2, 3)],
        };
        let wrapped: RenderResult = core.into();
        assert_eq!(wrapped.html, "<h1>hi</h1>");
        assert_eq!(wrapped.spans.len(), 3);
        for (i, span) in wrapped.spans.iter().enumerate() {
            assert_eq!(span.dom_index as usize, i);
        }
        assert_eq!(wrapped.spans[2].src_start, 2);
        assert_eq!(wrapped.spans[2].src_end, 3);

        let empty = CoreRenderResult {
            html: String::new(),
            text_spans: vec![],
        };
        let wrapped_empty: RenderResult = empty.into();
        assert!(wrapped_empty.spans.is_empty());
    }

    /// End-to-end: load empty bytes -> save -> load again. The handle's
    /// `threads()` snapshot must match across the round-trip. This is the
    /// same path the Kotlin smoke test will exercise once B5 wires the
    /// generated bindings up.
    #[test]
    fn handle_round_trip_through_load_save_load() {
        let handle = load_sidecar_bytes(Vec::new()).expect("load empty");
        assert!(handle.threads().is_empty());
        let bytes = save_sidecar_bytes(handle.clone()).expect("save");
        let restored = load_sidecar_bytes(bytes).expect("reload");
        assert_eq!(handle.threads().len(), restored.threads().len());
    }

    /// `render_markdown` wrapper produces an HTML string with the
    /// expected tag for a top-level heading. The point isn't to retest
    /// the renderer (that lives in document.rs) — it's to prove the
    /// wrapper actually delegates instead of returning a stub.
    #[test]
    fn render_markdown_wrapper_delegates_to_core() {
        let result = render_markdown(
            "# Hello".into(),
            RenderOptions {
                syntax_highlighting: false,
                mermaid_enabled: false,
            },
        )
        .expect("render");
        assert!(result.html.contains("<h1"));
    }

    /// Sidecar filename helper round-trips a `{name}` token. Same
    /// rationale as the render test — this is the wrapper's wiring,
    /// not the underlying logic.
    #[test]
    fn sidecar_filename_wrapper_substitutes_token() {
        assert_eq!(
            sidecar_filename("notes.md".into(), "{name}.md.comments.json".into()),
            "notes.md.comments.json"
        );
    }
}
