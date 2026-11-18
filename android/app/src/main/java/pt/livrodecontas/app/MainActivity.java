package pt.livrodecontas.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App's own plugin (Google Drive permission for the phone/PC sync), registered before the bridge starts.
        registerPlugin(DriveAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
