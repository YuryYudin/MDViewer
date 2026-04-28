use mdviewer_lib::build_info;

#[test]
fn build_info_constants_are_populated() {
    let info = build_info();
    assert!(!info.version.is_empty(), "MDVIEWER_VERSION must be non-empty");
    assert!(
        !info.commit_hash.is_empty(),
        "MDVIEWER_COMMIT_HASH must be non-empty"
    );
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
}
