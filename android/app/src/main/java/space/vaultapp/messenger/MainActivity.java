package space.vaultapp.messenger;

import android.os.Bundle;
import android.util.Log;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebSettingsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must run before super.onCreate() — that's what actually builds
        // the Bridge and consumes this registration list.
        registerPlugin(ExternalOpenerPlugin.class);
        super.onCreate(savedInstanceState);
        // Android's WebView does not inherit the system Settings > Display >
        // Font size accessibility setting on its own — unlike native views,
        // where it applies automatically to `sp` units. `textZoom` is the
        // WebView-level escape hatch: a post-layout percentage multiplier
        // applied to all rendered text regardless of whether the CSS used
        // px, rem, or em, so it fixes this for the whole app without
        // touching any of the client's ~250 fixed-px font-size classes.
        // fontScale isn't declared in AndroidManifest's configChanges, so
        // Android recreates this Activity (re-running onCreate) whenever
        // the user changes the setting — no extra listener needed.
        float fontScale = getResources().getConfiguration().fontScale;
        getBridge().getWebView().getSettings().setTextZoom(Math.round(fontScale * 100));

        // Android's embedded WebView (unlike Chrome itself) exposes no
        // WebAuthn/navigator.credentials support at all unless an app opts
        // in explicitly — this is that opt-in. Without it, lib/crypto/
        // webauthn.js's isPrfSupported() correctly reports false and the
        // whole Biometric Vault Unlock feature silently disappears from
        // Settings, on every device, not just older ones. The other half of
        // this — a Digital Asset Links file at
        // https://app.vaultapp.space/.well-known/assetlinks.json — lives
        // server-side (deploy/nginx) and proves this app owns that origin,
        // which Android's Credential Manager verifies independently before
        // it will hand out a platform authenticator prompt to it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(
                getBridge().getWebView().getSettings(),
                WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
            );
        } else {
            Log.w("Vault", "WebView build does not support the WEB_AUTHENTICATION feature — biometric unlock will stay unavailable on this device.");
        }
    }
}
