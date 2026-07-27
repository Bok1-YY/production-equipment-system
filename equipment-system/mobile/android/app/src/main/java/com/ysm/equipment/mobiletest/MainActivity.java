package com.ysm.equipment.mobiletest;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int pendingWorkOrderId;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RepairNotificationsPlugin.class);
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
