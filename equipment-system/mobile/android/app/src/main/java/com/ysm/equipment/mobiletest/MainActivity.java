package com.ysm.equipment.mobiletest;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.CapConfig;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int pendingWorkOrderId;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RepairNotificationsPlugin.class);
        registerPlugin(ServerSettingsPlugin.class);
        CapConfig packaged = CapConfig.loadDefault(this);
        config = new CapConfig.Builder(this)
            .setHTML5mode(packaged.isHTML5Mode())
            .setServerUrl(ServerSettings.effectiveUrl(this))
            .setErrorPath(packaged.getErrorPath())
            .setHostname(packaged.getHostname())
            .setStartPath(packaged.getStartPath())
            .setAndroidScheme(packaged.getAndroidScheme())
            .setAllowNavigation(packaged.getAllowNavigation())
            .setOverriddenUserAgentString(packaged.getOverriddenUserAgentString())
            .setAppendedUserAgentString(packaged.getAppendedUserAgentString())
            .setBackgroundColor(packaged.getBackgroundColor())
            .setAllowMixedContent(packaged.isMixedContentAllowed())
            .setCaptureInput(packaged.isInputCaptured())
            .setUseLegacyBridge(packaged.isUsingLegacyBridge())
            .setResolveServiceWorkerRequests(packaged.isResolveServiceWorkerRequests())
            .setWebContentsDebuggingEnabled(packaged.isWebContentsDebuggingEnabled())
            .setZoomableWebView(packaged.isZoomableWebView())
            .setLoggingEnabled(packaged.isLoggingEnabled())
            .setInitialFocus(packaged.isInitialFocus())
            .create();
        super.onCreate(savedInstanceState);
        rememberNotificationIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        rememberNotificationIntent(intent);
    }

    private void rememberNotificationIntent(Intent intent) {
        if (intent != null) {
            pendingWorkOrderId = intent.getIntExtra(RepairNotificationService.EXTRA_WORK_ORDER_ID, 0);
        }
    }

    synchronized int consumePendingWorkOrderId() {
        int value = pendingWorkOrderId;
        pendingWorkOrderId = 0;
        if (getIntent() != null) getIntent().removeExtra(RepairNotificationService.EXTRA_WORK_ORDER_ID);
        return value;
    }
}
