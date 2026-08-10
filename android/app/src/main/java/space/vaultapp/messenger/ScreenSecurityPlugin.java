package space.vaultapp.messenger;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Opt-in FLAG_SECURE. With it set, Android refuses to put the window's
// contents in a screenshot, a screen recording, or the recent-apps
// thumbnail — the last of which is the one that bites a messenger by
// default, since the OS snapshots whatever conversation was on screen and
// keeps showing it in the task switcher long after the app is backgrounded.
//
// Off by default rather than forced on: a burn-on-read app has a real
// argument for making screenshots hard, but plenty of legitimate use
// (saving a QR sync code, capturing a bug, keeping a receipt of a
// conversation you're a party to) depends on them, and silently breaking
// the screenshot button with no explanation is worse than letting the user
// decide. See the Settings > Privacy toggle in ChatSidebar.svelte.
//
// The preference is duplicated into SharedPreferences rather than living
// only in the WebView's localStorage, because localStorage isn't readable
// until the WebView has loaded — which is already too late. MainActivity
// reads this in onCreate and applies the flag before the first frame is
// ever produced, so a protected session never has an unprotected window
// even briefly during a cold start.
@CapacitorPlugin(name = "ScreenSecurity")
public class ScreenSecurityPlugin extends Plugin {
    static final String PREFS = "vault_screen_security";
    static final String KEY_ENABLED = "enabled";

    static boolean isEnabled(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_ENABLED, false);
    }

    /** Applies (or clears) FLAG_SECURE. Must run on the UI thread. */
    static void apply(android.app.Activity activity, boolean enabled) {
        if (enabled) {
            activity.getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
            );
        } else {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Missing 'enabled'");
            return;
        }

        getContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply();

        // setFlags/clearFlags touch the window, so they have to be on the UI
        // thread — a @PluginMethod is not guaranteed to already be there.
        getActivity().runOnUiThread(() -> apply(getActivity(), enabled));
        call.resolve();
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", isEnabled(getContext()));
        call.resolve(result);
    }
}
