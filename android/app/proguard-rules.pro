# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ── Capacitor plugins ────────────────────────────────────────────────
# @capacitor/android already contributes -keep rules for anything extending
# com.getcapacitor.Plugin via consumerProguardFiles, which covers both the
# bundled plugins (App, Browser, Haptics, StatusBar) and this app's own two.
# They are named explicitly anyway: these classes are reached by reflection
# from registerPlugin() and by JS through the bridge, never by a direct Java
# call site R8 can see, so if that consumer rule ever changes the failure
# would be a plugin silently missing at runtime in release builds only —
# exactly the kind of thing that gets shipped before it gets noticed.
-keep class space.vaultapp.messenger.ExternalOpenerPlugin { *; }
-keep class space.vaultapp.messenger.ScreenSecurityPlugin { *; }

# Plugin method dispatch reads these annotations at runtime.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# ── Crash reports ────────────────────────────────────────────────────
# Keep stack traces readable. Line numbers are retained but original source
# file names are replaced, so this leaks no more than the class names R8
# already emits.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
