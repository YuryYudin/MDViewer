# UniFFI's Kotlin bindings drive the Rust side via JNA reflection
# (`com.sun.jna.Native.load(...)`); R8 has no way of knowing which
# generated symbols the Rust scaffolding looks up by name, so anything
# under `dev.mdviewer.core` and the JNA runtime itself must be kept.
#
# These rules are *consumer* rules — embedded in the published AAR
# via `consumerProguardFiles` so downstream :app benefits from them
# without copy/paste. They only kick in when R8 is enabled (debug
# builds skip minification entirely, per build.gradle.kts).
-keep class dev.mdviewer.core.** { *; }
-keep class com.sun.jna.** { *; }
-keepclassmembers class com.sun.jna.** { *; }
