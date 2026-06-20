//! Export-to-PDF command (C1).
//!
//! `export_pdf` renders the focused webview's *current document* to a PDF file
//! at a user-chosen path, under **print media** so the Phase-A `@media print`
//! stylesheet applies (app chrome — toolbar, tab strip, sidebar, status bar,
//! comment highlights — is excluded and the print margins/pagination take
//! effect). The native save dialog runs on the frontend
//! (`@tauri-apps/plugin-dialog` `save()`); this command receives the already-
//! chosen absolute path and never prompts.
//!
//! ## Pure helpers vs. per-OS backend
//!
//! The filename/URI/error logic is deliberately **outside** any `cfg` block so
//! it is unit-testable on every host (see the `tests` module at the bottom):
//!
//! * [`default_pdf_filename`] — `<stem>.pdf` derivation for the dialog default.
//! * [`file_uri_for`] — `file://<path>` URI the Linux backend feeds WebKitGTK.
//! * [`NO_DOCUMENT_ERR`] — the user-facing "no active document" toast text.
//!
//! The `#[cfg(target_os = "…")]` arms of [`export_pdf`] wrap the raw webview
//! handle and call the per-OS PDF API. Only the Linux arm compiles+runs on this
//! host; the Windows / macOS arms are `cfg`-gated out here and validated on
//! their own agents via D1's headless export smoke.

use std::path::Path;

/// User-facing error when there is no active rendered document to export.
/// Matches the contract wording (surfaced verbatim as the toast message).
///
/// The no-document guard runs frontend-side (`main.ts` aborts before invoking
/// when there is no active doc), so the Rust command never returns this today;
/// the constant is pinned here as the single source of truth for the wording
/// and is exercised by the unit test below.
#[allow(dead_code)]
pub const NO_DOCUMENT_ERR: &str = "No document is open";

/// Derive the default PDF filename (`<stem>.pdf`) the save dialog pre-fills,
/// from the active document's source path. Only the file *stem* is used — the
/// directory is chosen separately by the caller (the document's folder when it
/// has a local parent; the platform default save dir otherwise).
///
/// `notes.md` → `notes.pdf`, `README` (no extension) → `README.pdf`,
/// `spec.markdown` → `spec.pdf`. A path with no file name at all falls back to
/// `document.pdf` so the dialog always has a sensible default.
///
/// The dialog default is computed frontend-side (`main.ts` builds the
/// `defaultPath`), so this Rust mirror is not called by the command today; it
/// pins the derivation rule as the unit-testable contract.
///
/// **Contract mirror (intentionally unused).** This is a tested mirror of the
/// canonical TS `defaultPdfPath` stem derivation in `src/main.ts`. It is kept
/// — with its unit tests — against the day the default-filename derivation
/// moves into Rust (so the command can pre-fill the dialog itself rather than
/// the frontend). Until then it is `#[allow(dead_code)]` on purpose: do NOT
/// delete it, and keep it in lockstep with the TS rule.
#[allow(dead_code)]
pub fn default_pdf_filename(source_path: &str) -> String {
    let stem = Path::new(source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("document");
    format!("{stem}.pdf")
}

/// Build the `file://<absolute-path>` URI the Linux WebKitGTK backend uses as
/// the print-to-file `output-uri`. The path is assumed absolute (the frontend
/// always hands the command an absolute path from the save dialog); we prefix
/// the `file://` scheme and keep the path verbatim.
pub fn file_uri_for(path: &str) -> String {
    format!("file://{path}")
}

/// Export the focused webview's current document to a PDF at `path`.
///
/// Returns `Ok(path)` on success (the frontend shows an `Exported to <path>`
/// toast) or `Err(message)` on failure (surfaced as an error toast). **Never
/// panics** — a panic would crash the WebView; every backend failure is mapped
/// into `Err(format!("Failed to write PDF: {e}"))`.
///
/// ## Thread bridging
///
/// `WebviewWindow::with_webview` runs its closure on the platform (GTK main)
/// thread, and the WebKitGTK print operation completes **asynchronously** —
/// it emits a `finished` (or `failed`) signal once the PDF has been written.
/// The D1 smoke depends on the file existing the moment this `async fn`
/// resolves, so we bridge the signal back to the async context with a
/// `oneshot` channel: the closure starts the print and wires the channel into
/// the `finished`/`failed` handlers; this fn `await`s the channel so it only
/// returns after the file is on disk (or the print failed).
#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    export_pdf_inner(window, path).await
}

/// Shared per-OS PDF backend, factored out of the [`export_pdf`] command so
/// BOTH the IPC command and D1's headless `--export-pdf` CLI arm
/// (`run_headless_export` in `main.rs`) drive the *same* backend — the
/// per-OS print path is implemented exactly once.
///
/// Returns `Ok(path)` (the path written) on success or `Err(message)` on
/// failure. Never panics.
pub(crate) async fn export_pdf_inner(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        export_pdf_linux(window, path).await
    }
    #[cfg(windows)]
    {
        export_pdf_windows(window, path).await
    }
    #[cfg(target_os = "macos")]
    {
        export_pdf_macos(window, path).await
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        let _ = (window, path);
        Err("Printing to PDF is not supported on this platform".into())
    }
}

/// Default name of the GTK file print backend's virtual printer, used as the
/// **fallback** when runtime enumeration ([`find_file_backend_printer_name`])
/// turns up nothing. On an English locale the file backend registers its
/// printer under exactly this name; on other locales the displayed name is
/// translated, which is why we prefer enumeration-by-backend-identity and only
/// fall back to this literal.
#[cfg(target_os = "linux")]
const FILE_PRINTER_FALLBACK: &str = "Print to File";

/// Locate the GTK *file* print backend's virtual printer by **backend
/// identity** rather than by its (localized) display name, returning its name
/// for the `printer` print-setting.
///
/// The display name of the file backend's printer is translated per locale
/// ("Print to File" in English, "Datei drucken", "Imprimer dans un fichier",
/// …), so selecting it by the hardcoded English string fails everywhere else.
/// Instead we enumerate every printer (`gtk_enumerate_printers`, run
/// synchronously with `wait = TRUE`) and match on the GType name of each
/// printer's backend — the file backend is `GtkPrintBackendFile` regardless of
/// locale. We return that printer's own (possibly-localized) name, which is the
/// value GTK then matches when resolving the `printer` setting.
///
/// Returns `None` if enumeration finds no file-backend printer (the caller then
/// falls back to [`FILE_PRINTER_FALLBACK`]). MUST be called on the GTK main
/// thread — it is, from inside `with_webview`'s closure.
#[cfg(target_os = "linux")]
fn find_file_backend_printer_name() -> Option<String> {
    use std::ffi::CStr;
    use std::os::raw::{c_char, c_int, c_void};

    // Minimal FFI into the already-linked libgtk-3 / libgobject-2.0. The Rust
    // `gtk` 0.18 crate does not bind `GtkPrinter` / `gtk_enumerate_printers`,
    // so we declare just the four C symbols we need. All are stable public GTK
    // API; the shared libs are guaranteed present (WebKitGTK pulls them in).
    extern "C" {
        // gboolean (*GtkPrinterFunc)(GtkPrinter *printer, gpointer data);
        // wait = TRUE makes enumeration synchronous (blocks until done).
        fn gtk_enumerate_printers(
            func: extern "C" fn(*mut c_void, *mut c_void) -> c_int,
            data: *mut c_void,
            destroy: *mut c_void,
            wait: c_int,
        );
        fn gtk_printer_get_name(printer: *mut c_void) -> *const c_char;
        fn gtk_printer_get_backend(printer: *mut c_void) -> *mut c_void;
        // From <glib-object.h>: the GType name of a GObject instance. The file
        // backend instance's type name is "GtkPrintBackendFile".
        fn g_type_name_from_instance(instance: *mut c_void) -> *const c_char;
    }

    // Accumulator the C callback writes the matched printer name into.
    let mut found: Option<String> = None;

    // Per-printer callback. Returns gboolean: TRUE stops enumeration early. We
    // stop as soon as we match the file backend. `data` is a `*mut Option<String>`.
    extern "C" fn on_printer(printer: *mut c_void, data: *mut c_void) -> c_int {
        // SAFETY: `data` is the `&mut Option<String>` we handed to
        // `gtk_enumerate_printers`; `printer`/its backend are live GtkPrinter /
        // GtkPrintBackend pointers owned by GTK for the duration of this call.
        unsafe {
            let backend = gtk_printer_get_backend(printer);
            if backend.is_null() {
                return 0; // keep going
            }
            let type_name_ptr = g_type_name_from_instance(backend);
            if type_name_ptr.is_null() {
                return 0;
            }
            let type_name = CStr::from_ptr(type_name_ptr).to_string_lossy();
            if type_name == "GtkPrintBackendFile" {
                let name_ptr = gtk_printer_get_name(printer);
                if !name_ptr.is_null() {
                    let name = CStr::from_ptr(name_ptr).to_string_lossy().into_owned();
                    let out = &mut *(data as *mut Option<String>);
                    *out = Some(name);
                    return 1; // matched — stop enumeration
                }
            }
        }
        0 // not the file backend — continue
    }

    // SAFETY: synchronous enumeration on the GTK main thread; `&mut found`
    // outlives the call (it returns before this fn does, thanks to wait = TRUE).
    unsafe {
        gtk_enumerate_printers(
            on_printer,
            &mut found as *mut Option<String> as *mut c_void,
            std::ptr::null_mut(),
            1, // wait = TRUE
        );
    }

    found
}

/// Linux backend: WebKitGTK `WebKitPrintOperation` with a print-to-file
/// `PrintSettings` (output URI `file://<path>`, format `pdf`), run via
/// `print()` so **no** GTK dialog is shown. The `@media print` stylesheet
/// applies because the operation prints the live document under print media.
///
/// The print runs on the GTK main thread (where `with_webview`'s closure
/// executes). We connect the `finished`/`failed` signals to a `oneshot` sender
/// so the `async fn` resolves only once the file write has completed.
#[cfg(target_os = "linux")]
async fn export_pdf_linux(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use tokio::sync::oneshot;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    // GTK print-settings keys (see gtk_print_settings_* / the GTK print API):
    // `output-uri` is the destination, `output-file-format` selects the
    // backend ("pdf"). WebKitGTK's print operation honors both when `print()`
    // is invoked without a dialog. `printer` names the backend's virtual
    // printer — we set it to the GTK *file* backend's printer so `print()`
    // writes straight to `output-uri` WITHOUT needing a CUPS daemon (which may
    // be absent, e.g. on CI / this host). Without a named printer, WebKitGTK
    // looks for a default/CUPS printer and fails with "Printer not found".
    const OUTPUT_URI: &str = "output-uri";
    const OUTPUT_FORMAT: &str = "output-file-format";
    const PRINTER: &str = "printer";

    let output_uri = file_uri_for(&path);
    let (tx, rx) = oneshot::channel::<Result<(), String>>();

    // `with_webview` hands us the raw `webkit2gtk::WebView` on the GTK thread.
    // Build + start the print operation there; bridge completion back via `tx`.
    window
        .with_webview(move |wv| {
            let webview = wv.inner();
            let settings = gtk::PrintSettings::new();
            settings.set(OUTPUT_URI, Some(output_uri.as_str()));
            settings.set(OUTPUT_FORMAT, Some("pdf"));
            // Resolve the GTK file backend's printer by BACKEND IDENTITY (not
            // its localized display name) so this works on any locale; fall
            // back to the English "Print to File" literal if enumeration finds
            // nothing. Done here because enumeration must run on the GTK thread.
            let printer_name = find_file_backend_printer_name()
                .unwrap_or_else(|| FILE_PRINTER_FALLBACK.to_string());
            settings.set(PRINTER, Some(printer_name.as_str()));

            let print_op = PrintOperation::new(&webview);
            print_op.set_print_settings(&settings);

            // The sender is moved into whichever signal fires first; wrap it so
            // both closures can take it (only one will, GTK guarantees a single
            // terminal signal per operation).
            let tx_cell = Rc::new(RefCell::new(Some(tx)));
            let tx_finished = tx_cell.clone();
            print_op.connect_finished(move |_| {
                if let Some(tx) = tx_finished.borrow_mut().take() {
                    let _ = tx.send(Ok(()));
                }
            });
            let tx_failed = tx_cell.clone();
            print_op.connect_failed(move |_, err| {
                if let Some(tx) = tx_failed.borrow_mut().take() {
                    let _ = tx.send(Err(err.to_string()));
                }
            });

            // `print()` runs the operation without showing the GTK dialog,
            // writing straight to the configured output URI. The operation
            // completes ASYNCHRONOUSLY (it returns immediately and emits
            // `finished`/`failed` later on the GTK main loop), so the
            // `PrintOperation` must outlive this closure or the signal never
            // fires. We `forget` it: the GObject stays alive for the duration
            // of the single-shot export process, guaranteeing the terminal
            // signal lands and `tx` is sent before the runtime tears down.
            print_op.print();
            std::mem::forget(print_op);
        })
        .map_err(|e| format!("Failed to write PDF: {e}"))?;

    match rx.await {
        Ok(Ok(())) => Ok(path),
        Ok(Err(e)) => Err(format!("Failed to write PDF: {e}")),
        // The sender was dropped without firing a terminal signal — treat as a
        // backend failure rather than hanging or panicking.
        Err(_) => Err("Failed to write PDF: print operation did not complete".into()),
    }
}

/// Windows backend: WebView2 `ICoreWebView2_7::PrintToPdf(path, settings)` via
/// `webview2-com`. `PrintToPdf` renders under print media (honoring `@media
/// print`) directly to the target file; its completion handler bridges back to
/// the `async fn` through a `oneshot` so the file exists on return.
///
/// `cfg`-gated out on Linux — validated on the Windows agent by D1's smoke.
#[cfg(windows)]
async fn export_pdf_windows(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::Interface;
    use windows::core::HSTRING;

    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    // Clone for the `move` closure so the outer `path` survives to be returned
    // in the Ok arm below (mirrors the Linux/macOS backends).
    let target_path = path.clone();

    window
        .with_webview(move |wv| {
            // Wrap the sender so the completion handler (which is `FnMut`) can
            // take it exactly once; a setup error before the call also reports
            // through the same cell.
            let tx_cell = Rc::new(RefCell::new(Some(tx)));
            let tx_done = tx_cell.clone();

            // The controller's CoreWebView2 implements ICoreWebView2_7 (the
            // interface that introduced PrintToPdf). Query for it; an older
            // runtime that lacks it surfaces as a backend error rather than a
            // panic.
            let result = (|| -> Result<(), String> {
                let controller = wv.controller();
                let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
                let core7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;
                let target = HSTRING::from(target_path.as_str());
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, success| {
                    // webview2-com 0.38 passes the completion flag as a Rust `bool`
                    // (already converted from the native BOOL), so use it directly.
                    let outcome = if hr.is_ok() && success {
                        Ok(())
                    } else {
                        Err(format!(
                            "PrintToPdf failed (hr={hr:?}, success={success:?})"
                        ))
                    };
                    if let Some(tx) = tx_done.borrow_mut().take() {
                        let _ = tx.send(outcome);
                    }
                    Ok(())
                }));
                // `None` print settings uses the WebView2 print defaults, which
                // render under print media (honoring @media print).
                unsafe { core7.PrintToPdf(&target, None, &handler) }
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(e) = result {
                if let Some(tx) = tx_cell.borrow_mut().take() {
                    let _ = tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("Failed to write PDF: {e}"))?;

    match rx.await {
        Ok(Ok(())) => Ok(path),
        Ok(Err(e)) => Err(format!("Failed to write PDF: {e}")),
        Err(_) => Err("Failed to write PDF: print operation did not complete".into()),
    }
}

/// macOS backend: WKWebView `printOperation(with:)` to a PDF file. We use the
/// print operation (NOT `createPDF`, which snapshots **screen** media and would
/// defeat `@media print`) with `showsPrintPanel`/`showsProgressPanel` off and a
/// `jobDisposition` of "save to file" pointed at `path`, run on the main
/// thread; completion is bridged back through a `oneshot`.
///
/// `cfg`-gated out on Linux — validated on the macOS agent by D1's smoke.
#[cfg(target_os = "macos")]
async fn export_pdf_macos(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
    };
    use objc2_foundation::{NSString, NSURL};
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    // Clone for the closure so the outer `path` survives to be returned in the
    // success arm (the closure moves its capture).
    let target_path = path.clone();

    window
        .with_webview(move |wv| {
            // SAFETY: `inner()` is the live WKWebView pointer for the focused
            // webview; we only message it on the main thread inside this closure.
            let outcome = unsafe {
                let webview = wv.inner() as *mut AnyObject;
                if webview.is_null() {
                    Err("WKWebView handle was null".to_string())
                } else {
                    // Build an NSPrintInfo whose jobDisposition saves to a file
                    // URL at `path` (NSPrintSaveJob / NSPrintJobSavingURL). The
                    // print operation renders the document under PRINT media —
                    // honoring @media print — unlike `createPDF`, which would
                    // snapshot screen media and defeat the print stylesheet.
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&target_path));

                    // Start from the shared/default print info and mutate its
                    // attribute dictionary in place. `dictionary()` returns the
                    // live `NSMutableDictionary<NSPrintInfoAttributeKey, AnyObject>`
                    // backing the print info, so writes through it are reflected
                    // in the operation. We avoid `initWithDictionary:` (whose
                    // signature wants an `&NSDictionary<NSPrintInfoAttributeKey,
                    // AnyObject>`) and instead set the two keys we need: the
                    // "save to file" disposition and the destination URL.
                    let print_info: Retained<NSPrintInfo> = NSPrintInfo::new();
                    let attrs = print_info.dictionary();
                    // NSPrintJobDisposition = NSPrintSaveJob (write to a file).
                    // The generated statics have place-type `&'static NSString`,
                    // so `&*X` is the `&NSString` we message with.
                    let save_job: &NSString = &*NSPrintSaveJob;
                    let disposition_key: &NSString = &*NSPrintJobDisposition;
                    let saving_url_key: &NSString = &*NSPrintJobSavingURL;
                    let _: () = msg_send![
                        &*attrs,
                        setObject: save_job as &AnyObject,
                        forKey: disposition_key as &NSObject,
                    ];
                    // NSPrintJobSavingURL = file://<path> destination.
                    let _: () = msg_send![
                        &*attrs,
                        setObject: &*url as &AnyObject,
                        forKey: saving_url_key as &NSObject,
                    ];
                    // Mirror the disposition through the typed setter so the
                    // print info is internally consistent.
                    print_info.setJobDisposition(save_job);

                    let op: Option<Retained<NSPrintOperation>> = msg_send![
                        webview as *mut NSObject,
                        printOperationWithPrintInfo: &*print_info,
                    ];
                    match op {
                        Some(op) => {
                            op.setShowsPrintPanel(false);
                            op.setShowsProgressPanel(false);
                            if op.runOperation() {
                                Ok(())
                            } else {
                                Err("NSPrintOperation reported failure".to_string())
                            }
                        }
                        None => Err("WKWebView returned no print operation".to_string()),
                    }
                }
            };
            let _ = tx.send(outcome);
        })
        .map_err(|e| format!("Failed to write PDF: {e}"))?;

    match rx.await {
        Ok(Ok(())) => Ok(path),
        Ok(Err(e)) => Err(format!("Failed to write PDF: {e}")),
        Err(_) => Err("Failed to write PDF: print operation did not complete".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pdf_filename_replaces_md_extension() {
        assert_eq!(default_pdf_filename("/docs/notes.md"), "notes.pdf");
    }

    #[test]
    fn default_pdf_filename_handles_markdown_extension() {
        assert_eq!(default_pdf_filename("/docs/spec.markdown"), "spec.pdf");
    }

    #[test]
    fn default_pdf_filename_handles_no_extension() {
        assert_eq!(default_pdf_filename("/docs/README"), "README.pdf");
    }

    #[test]
    fn default_pdf_filename_handles_bare_name() {
        assert_eq!(default_pdf_filename("notes.md"), "notes.pdf");
    }

    #[test]
    fn default_pdf_filename_falls_back_when_no_filename() {
        // A path that is just a directory separator has no file stem.
        assert_eq!(default_pdf_filename("/"), "document.pdf");
        assert_eq!(default_pdf_filename(""), "document.pdf");
    }

    #[test]
    fn file_uri_for_prefixes_scheme() {
        assert_eq!(file_uri_for("/tmp/out.pdf"), "file:///tmp/out.pdf");
    }

    #[test]
    fn no_document_error_matches_contract() {
        assert_eq!(NO_DOCUMENT_ERR, "No document is open");
    }
}
