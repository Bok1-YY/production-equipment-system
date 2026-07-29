package com.ysm.equipment.mobiletest;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import com.getcapacitor.CapConfig;

final class ServerSettings {
    private static final String PREFERENCES = "ysm_server_settings";
    private static final String SERVER_URL = "server_url";

    private ServerSettings() {}

    private static String configuredUrl(Context context) {
        String value = CapConfig.loadDefault(context).getServerUrl();
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("安装包没有配置默认服务器地址");
        }
        return value;
    }

    static String packagedUrl(Context context) {
        String value = configuredUrl(context);
        return ServerUrlPolicy.normalize(value, allowPrivateHttp(context), value);
    }

    static String normalize(Context context, String input) {
        return ServerUrlPolicy.normalize(input, allowPrivateHttp(context), configuredUrl(context));
    }

    static String effectiveUrl(Context context) {
        String fallback = packagedUrl(context);
        String saved = preferences(context).getString(SERVER_URL, "");
        if (saved == null || saved.isBlank()) return fallback;
        try {
            return normalize(context, saved);
        } catch (IllegalArgumentException error) {
            preferences(context).edit().remove(SERVER_URL).apply();
            return fallback;
        }
    }

    static boolean hasCustomUrl(Context context) {
        return preferences(context).contains(SERVER_URL);
    }

    static String save(Context context, String input) {
        String value = normalize(context, input);
        preferences(context).edit().putString(SERVER_URL, value).apply();
        return value;
    }

    static String reset(Context context) {
        preferences(context).edit().remove(SERVER_URL).apply();
        return packagedUrl(context);
    }

    static boolean allowPrivateHttp(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
