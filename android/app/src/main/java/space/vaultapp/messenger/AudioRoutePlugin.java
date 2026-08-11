package space.vaultapp.messenger;

import android.content.Context;
import android.media.AudioManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Call audio routing for Android.
//
// The web client switches speaker/earpiece with HTMLMediaElement.setSinkId(),
// which does not exist in Android's WebView — it is a desktop-browser API. So
// on Android the speaker button was permanently disabled and every call came
// out of whichever output the system happened to pick, with no way to change
// it.
//
// Routing a voice call on Android is not just an output choice, either. Unless
// AudioManager is put in MODE_IN_COMMUNICATION, the stream is treated as media
// rather than a call: it plays at media volume, the physical volume keys adjust
// the wrong stream, and echo cancellation is not applied. That is why call
// audio through the earpiece was quiet or absent even when it was nominally
// working.
//
// MODIFY_AUDIO_SETTINGS is already declared in AndroidManifest.xml (it was
// added for getUserMedia), so this needs no new permission.
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /**
     * Enter or leave call mode. Called when a call becomes active and again
     * when it ends — leaving the device in MODE_IN_COMMUNICATION after a call
     * would keep every other app's audio behaving as though a call were still
     * up, so the restore half matters as much as the set.
     */
    @PluginMethod
    public void setInCall(PluginCall call) {
        Boolean inCall = call.getBoolean("inCall");
        if (inCall == null) {
            call.reject("Missing 'inCall'");
            return;
        }

        AudioManager am = audioManager();
        if (am == null) {
            call.reject("AudioManager unavailable");
            return;
        }

        getActivity().runOnUiThread(() -> {
            if (inCall) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            } else {
                // Speakerphone is a property of the device, not of this app —
                // clear it before handing the audio system back, or the next
                // app to play something inherits it.
                am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
            }
        });
        call.resolve();
    }

    /** Route call audio to the loudspeaker (true) or the earpiece (false). */
    @PluginMethod
    public void setSpeakerphone(PluginCall call) {
        Boolean on = call.getBoolean("on");
        if (on == null) {
            call.reject("Missing 'on'");
            return;
        }

        AudioManager am = audioManager();
        if (am == null) {
            call.reject("AudioManager unavailable");
            return;
        }

        getActivity().runOnUiThread(() -> {
            // Setting the mode here as well as in setInCall: on some OEM
            // builds setSpeakerphoneOn is ignored unless the device is already
            // in communication mode, and the two calls can race on a fast
            // accept.
            if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            am.setSpeakerphoneOn(on);
        });
        call.resolve();
    }

    /** Whether the loudspeaker is currently selected. */
    @PluginMethod
    public void isSpeakerphoneOn(PluginCall call) {
        AudioManager am = audioManager();
        JSObject result = new JSObject();
        result.put("on", am != null && am.isSpeakerphoneOn());
        call.resolve(result);
    }
}
