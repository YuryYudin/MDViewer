# ---------------------------------------------------------------------------
# R8 / ProGuard rules for the :app release variant.
#
# Empty on purpose for B4 — the only consumers we ship are Compose
# (which already supplies its own consumer rules via the BOM) and the
# :core AAR (whose generated UniFFI bindings ship `proguard-rules.pro`
# alongside their AAR). Real keep-rules land in E4 once the release
# build is exercised end-to-end and we know which entry points need
# pinning.
#
# Notes on what we deliberately omit:
#   - No `-keep class dev.mdviewer.core.**` rule: UniFFI's bindings
#     are reflected via JNA which keeps its own classes; piling on
#     would be cargo-cult.
#   - No reflection-based serialization rules: kotlinx.serialization
#     and similar aren't on the classpath in v1.
# ---------------------------------------------------------------------------
