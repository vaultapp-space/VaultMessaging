package space.vaultapp.messenger;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// @capacitor/browser opens links in a Chrome Custom Tab — a view that
// shares this app's own task/back-stack rather than being a fully separate
// browser instance. Fine for viewing an ordinary page, but Custom Tabs
// have known reliability problems completing a large binary (.apk)
// download: the in-app update banner's "Update" link needs a real handoff
// to whatever the user's actual default browser app is, so the download
// goes through that browser's own already-proven Download Manager
// integration — the exact same path as any other website triggering an
// APK download, which is what this app's own docs already point people
// at for a manual download.
@CapacitorPlugin(name = "ExternalOpener")
public class ExternalOpenerPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("Missing url");
            return;
        }

        // This plugin is reachable from any JS running in the WebView —
        // window.Capacitor.Plugins.ExternalOpener.open(...) — not just the
        // one call site in externalOpener.js. Without a scheme check, a
        // link-preview render or any future XSS could hand it an intent:
        // or custom-scheme URI and have this app launch it with attacker-
        // controlled data against another installed app's deep-link
        // handler. The whole point of this plugin is "open a web page in
        // the real browser", so only http(s) is ever a legitimate call.
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            call.reject("Only http/https URLs are allowed");
            return;
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            // No browser installed to hand this off to — reject the call
            // rather than let the exception propagate uncaught off this
            // plugin's own thread, which otherwise kills the whole app.
            call.reject("No app available to open this link");
        }
    }
}
