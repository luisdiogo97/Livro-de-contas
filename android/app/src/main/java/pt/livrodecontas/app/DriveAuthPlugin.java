package pt.livrodecontas.app;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.util.Collections;

/**
 * Asks Google for permission to keep the app's data in the person's Google Drive
 * (only the hidden app folder, scope drive.appdata) and returns an access token.
 * Uses the Google Play services Authorization API: after the first "Allow", later
 * calls return a fresh token without showing anything.
 */
@CapacitorPlugin(name = "DriveAuth")
public class DriveAuthPlugin extends Plugin {
    private static final String SCOPE = "https://www.googleapis.com/auth/drive.appdata";
    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall pending;

    @Override
    public void load() {
        consent = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::onConsent);
    }

    private AuthorizationRequest request() {
        return AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(SCOPE)))
            .build();
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        Activity activity = getActivity();
        Identity.getAuthorizationClient(activity).authorize(request())
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) { resolve(call, result); return; }
                if (!interactive || result.getPendingIntent() == null) { call.reject("Login needed", "login"); return; }
                if (pending != null) pending.reject("Cancelled", "login");
                pending = call;
                try {
                    IntentSender sender = result.getPendingIntent().getIntentSender();
                    consent.launch(new IntentSenderRequest.Builder(sender).build());
                } catch (Exception e) {
                    pending = null;
                    call.reject("Could not open Google sign-in", "login", e);
                }
            })
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage()), "error", e));
    }

    private void onConsent(ActivityResult res) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        Intent data = res.getData();
        if (res.getResultCode() != Activity.RESULT_OK || data == null) { call.reject("Cancelled", "login"); return; }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(data);
            resolve(call, result);
        } catch (Exception e) {
            call.reject("Google sign-in failed", "login", e);
        }
    }

    private void resolve(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) { call.reject("No token", "login"); return; }
        JSObject out = new JSObject();
        out.put("accessToken", token);
        call.resolve(out);
    }
}
