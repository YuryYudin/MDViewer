//! Shared helpers for Drive integration test crates. Each test crate that
//! needs `stub_server` declares `mod common;` at the top — Rust's integration
//! test layout requires the `mod` declaration in every crate that consumes
//! it (a single `tests/common/mod.rs` is *not* auto-linked).

// Note: `router` is `FnMut`, not `Fn`, so callers can hold mutable counters
// in the closure (B6's `let mut id_counter = 0u32; move |_req| { id_counter
// += 1; ... }` pattern). `Fn` would force `RefCell`/`AtomicUsize` boilerplate
// at every callsite; `FnMut` is a strict superset (every `Fn` is also a
// `FnMut`), so A4's existing `move |_req| { ... }` callsites compile
// unchanged. The router runs serially on the spawned thread, so interior
// mutability is safe without a lock.
pub fn stub_server(
    mut router: impl FnMut(&tiny_http::Request) -> tiny_http::Response<std::io::Cursor<Vec<u8>>>
        + Send
        + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let base = format!("http://127.0.0.1:{}", port);
    let handle = std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let resp = router(&req);
            let _ = req.respond(resp);
        }
    });
    (base, handle)
}
