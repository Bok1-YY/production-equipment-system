package com.ysm.equipment.mobiletest;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.CapConfig;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int pendingWorkOrderId;
    private int pendingModificationTaskId;
    private int pendingNotificationId;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PatrolCameraPlugin.class);
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
            pendingModificationTaskId = intent.getIntExtra(RepairNotificationService.EXTRA_MODIFICATION_TASK_ID, 0);
            pendingNotificationId = intent.getIntExtra(RepairNotificationService.EXTRA_NOTIFICATION_ID, 0);
        }
    }

    synchronized int consumePendingWorkOrderId() {
        int value = pendingWorkOrderId;
        pendingWorkOrderId = 0;
        if (getIntent() != null) getIntent().removeExtra(RepairNotificationService.EXTRA_WORK_ORDER_ID);
        return value;
    }

    synchronized int consumePendingModificationTaskId() {
        int value = pendingModificationTaskId;
        pendingModificationTaskId = 0;
        if (getIntent() != null) getIntent().removeExtra(RepairNotificationService.EXTRA_MODIFICATION_TASK_ID);
        return value;
    }

    synchronized int consumePendingNotificationId() {
        int value = pendingNotificationId;
        pendingNotificationId = 0;
        if (getIntent() != null) getIntent().removeExtra(RepairNotificationService.EXTRA_NOTIFICATION_ID);
        return value;
    }
}
