# ---------------------------------------------------------------------------
# R8 / ProGuard rules for the :app release variant (E4).
#
# Why each rule is here:
#
#   * UniFFI's generated Kotlin facade under `dev.mdviewer.core.**` is
#     reflection-driven (the bindings call into JNA via `Native.load` and
#     resolve scaffolding symbols by name). Any rename / dead-code-elim
#     by R8 produces NoSuchMethodError at runtime. Keeping the whole
#     package wholesale is the design's accepted pattern — narrower keep
#     rules would be brittle against UniFFI codegen changes.
#
#   * JNA itself ships native callbacks that R8 cannot see; without the
#     keep rule below `Native.load("mdviewer_jni")` resolves but every
#     subsequent symbol lookup fails. The Structure subclass keep is
#     required for any C struct mapped through JNA — UniFFI generates
#     these for the FFI surface.
#
#   * kotlinx.serialization generates per-class `$$serializer` companions
#     and `serializer(...)` factory methods that the JSON format
#     resolves reflectively at runtime. Without these keeps, encode /
#     decode of `RecentEntry`, `Profile`, etc. throws
#     `SerializationException: Serializer for ... not found`.
#
#   * AppAuth (libs.appauth) is on the classpath for v2 cloud-comments.
#     v1 doesn't perform OAuth, but R8 still needs to keep its
#     RedirectUriReceiverActivity surface stable so the resolved
#     manifest entries from manifestPlaceholders match the runtime class
#     names. Cheap rule, prevents a v2-rollout regression.
# ---------------------------------------------------------------------------

# UniFFI generated bindings (Kotlin facade) — reflection-driven.
-keep class dev.mdviewer.core.** { *; }

# JNA — UniFFI runtime.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.Structure {
    *;
}
# JNA bundles optional desktop integrations (Native$AWT helpers) that
# reference java.awt.* — those classes don't exist on Android and R8
# escalates the missing reference to a build failure under fullMode.
# The AWT entry points are unreachable on Android (UniFFI never calls
# them) so the missing-class warnings are safe to silence.
-dontwarn java.awt.**
-dontwarn com.sun.jna.Native$AWT

# kotlinx.serialization — keep generated serializers + Companion lookups.
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers class * {
    *** Companion;
}
-keepclasseswithmembers class * {
    kotlinx.serialization.KSerializer serializer(...);
}

# AppAuth — RedirectUriReceiverActivity is referenced by manifest merge.
-keep class net.openid.appauth.** { *; }

# WebView JavascriptInterface — D2's selection bridge attaches a JS
# interface to the WebView; @JavascriptInterface methods are resolved by
# name at runtime and must not be renamed by R8.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
