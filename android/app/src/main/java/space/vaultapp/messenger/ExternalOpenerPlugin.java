package space.vaultapp.messenger;

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
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(intent);
        call.resolve();
    }
}
