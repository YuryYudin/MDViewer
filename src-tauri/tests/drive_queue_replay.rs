//! B6: integration coverage for the offline queue replay path.
//!
//! These tests pre-seed the NDJSON queue file (as if the user had authored
//! comments while the network was down), then drive `replay()` against a
//! tiny_http stub that mints distinct Drive ids per request. The assertions
//! are:
//!
//! * FIFO drain order — the first queued op gets the first Drive id, the
//!   second gets the second. A reordering bug would mis-attach Drive ids to
//!   local comments and corrupt the IdMap.
//! * On success, the queue file is fully drained (zero bytes remain) so the
//!   next poll cycle doesn't re-replay the same ops.
//! * On mid-stream failure, the failed op AND every op behind it are
//!   re-appended in their original order so a network blip never silently
//!   drops user comments.
//!
//! The shared `stub_server` lives in `tests/common/mod.rs` (created in A4
//! with the FnMut signature precisely so B6 can hold a mutable id counter
//! in the closure). Each test is `#[serial_test::serial]` because the
//! `MDVIEWER_DRIVE_API_BASE` env var is process-global.

mod common;
use common::stub_server;

#[test]
#[serial_test::serial]
fn queue_replay_on_reconnect_drains_in_fifo_and_updates_id_map() {
    let dir = tempfile::tempdir().unwrap();
    // Pre-seed the queue file as if the user wrote two comments offline.
    let q = mdviewer_lib::drive::queue::DriveQueue::open(dir.path(), "FID");
    q.append(mdviewer_lib::drive::queue::QueueOp::CreateThread {
        local_id: "L1".into(),
        content: "first".into(),
        quoted: "".into(),
    })
    .unwrap();
    q.append(mdviewer_lib::drive::queue::QueueOp::CreateThread {
        local_id: "L2".into(),
        content: "second".into(),
        quoted: "".into(),
    })
    .unwrap();

    let mut id_counter = 0u32;
    let (base, _h) = stub_server(move |_req| {
        id_counter += 1;
        let body = format!(r#"{{"id":"DID-{}","content":"server"}}"#, id_counter);
        tiny_http::Response::from_string(body)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let api = mdviewer_lib::drive::api::DriveApi::with_token("fake".into());
    let id_map = std::sync::Mutex::new(mdviewer_lib::drive::comments::IdMap::default());
    mdviewer_lib::drive::queue::replay(&q, &api, "FID", &id_map).unwrap();

    let m = id_map.lock().unwrap();
    assert_eq!(m.map.get("L1").map(String::as_str), Some("DID-1"));
    assert_eq!(m.map.get("L2").map(String::as_str), Some("DID-2"));
    assert!(q.is_empty(), "queue must be drained on success");
}

#[test]
#[serial_test::serial]
fn queue_replay_requeues_remaining_ops_when_a_request_fails() {
    let dir = tempfile::tempdir().unwrap();
    let q = mdviewer_lib::drive::queue::DriveQueue::open(dir.path(), "FID");
    // Three ops queued. The stub will succeed on #1, fail on #2, and the
    // third must never be sent (we exit on the first failure).
    q.append(mdviewer_lib::drive::queue::QueueOp::CreateThread {
        local_id: "L1".into(),
        content: "first".into(),
        quoted: "".into(),
    })
    .unwrap();
    q.append(mdviewer_lib::drive::queue::QueueOp::CreateThread {
        local_id: "L2".into(),
        content: "second".into(),
        quoted: "".into(),
    })
    .unwrap();
    q.append(mdviewer_lib::drive::queue::QueueOp::CreateThread {
        local_id: "L3".into(),
        content: "third".into(),
        quoted: "".into(),
    })
    .unwrap();

    let mut call = 0u32;
    let (base, _h) = stub_server(move |_req| {
        call += 1;
        if call == 1 {
            tiny_http::Response::from_string(r#"{"id":"DID-1","content":"server"}"#)
        } else {
            // 4xx (non-retried) so replay returns an error promptly without
            // burning the test on the api-layer retry/backoff.
            tiny_http::Response::from_string(r#"{"error":{"code":400,"message":"nope"}}"#)
                .with_status_code(400)
        }
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let api = mdviewer_lib::drive::api::DriveApi::with_token("fake".into());
    let id_map = std::sync::Mutex::new(mdviewer_lib::drive::comments::IdMap::default());
    let res = mdviewer_lib::drive::queue::replay(&q, &api, "FID", &id_map);
    assert!(res.is_err(), "replay must surface the api error to the caller");

    // L1 succeeded → recorded. L2/L3 must be re-queued for the next attempt.
    let m = id_map.lock().unwrap();
    assert_eq!(m.map.get("L1").map(String::as_str), Some("DID-1"));
    assert!(m.map.get("L2").is_none());
    assert!(m.map.get("L3").is_none());
    drop(m);

    assert!(!q.is_empty(), "failed ops must remain on disk for the next replay");
    let remaining = q.drain().unwrap();
    assert_eq!(remaining.len(), 2, "L2 and L3 must be re-appended in order");
    match &remaining[0] {
        mdviewer_lib::drive::queue::QueueOp::CreateThread { local_id, .. } => {
            assert_eq!(local_id, "L2");
        }
        _ => panic!("expected CreateThread for L2"),
    }
    match &remaining[1] {
        mdviewer_lib::drive::queue::QueueOp::CreateThread { local_id, .. } => {
            assert_eq!(local_id, "L3");
        }
        _ => panic!("expected CreateThread for L3"),
    }
}
