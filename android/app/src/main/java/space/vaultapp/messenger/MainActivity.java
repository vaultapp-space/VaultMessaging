package space.vaultapp.messenger;

import android.os.Bundle;
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
    }
}
