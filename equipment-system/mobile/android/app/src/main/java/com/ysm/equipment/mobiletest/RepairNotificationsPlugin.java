package com.ysm.equipment.mobiletest;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "RepairNotifications",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class RepairNotificationsPlugin extends Plugin {
    private static final String USER_ID = "userId";

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("enabled", false);
            result.put("reason", "permission-denied");
            call.resolve(result);
            return;
        }
        startService(call);
    }

    private void startService(PluginCall call) {
        String serverUrl = getBridge().getServerUrl();
        String cookie = serverUrl == null ? null : CookieManager.getInstance().getCookie(serverUrl);
        int userId = call.getInt(USER_ID, 0);
        if (serverUrl == null || serverUrl.isBlank() || cookie == null || cookie.isBlank() || userId <= 0) {
            call.reject("登录会话尚未准备好，暂时无法开启报修通知");
            return;
        }

        Intent intent = new Intent(getContext(), RepairNotificationService.class);
        intent.setAction(RepairNotificationService.ACTION_START);
        intent.putExtra(RepairNotificationService.EXTRA_SERVER_URL, serverUrl);
        intent.putExtra(RepairNotificationService.EXTRA_COOKIE, cookie);
        intent.putExtra(RepairNotificationService.EXTRA_USER_ID, userId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        JSObject result = new JSObject();
        result.put("enabled", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        Intent intent = new Intent(getContext(), RepairNotificationService.class);
        intent.setAction(RepairNotificationService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void getPendingWorkOrder(PluginCall call) {
        int workOrderId = 0;
        if (getActivity() instanceof MainActivity) {
            workOrderId = ((MainActivity) getActivity()).consumePendingWorkOrderId();
        }
        JSObject result = new JSObject();
        result.put("workOrderId", workOrderId);
        call.resolve(result);
    }
}
