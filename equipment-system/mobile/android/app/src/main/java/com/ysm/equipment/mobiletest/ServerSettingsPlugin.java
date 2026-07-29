package com.ysm.equipment.mobiletest;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ServerSettings")
public class ServerSettingsPlugin extends Plugin {
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getConfig(PluginCall call) {
        JSObject result = new JSObject();
        result.put("serverUrl", ServerSettings.effectiveUrl(getContext()));
        result.put("defaultUrl", ServerSettings.packagedUrl(getContext()));
        result.put("custom", ServerSettings.hasCustomUrl(getContext()));
        result.put("allowPrivateHttp", ServerSettings.allowPrivateHttp(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void validate(PluginCall call) {
        try {
            String serverUrl = ServerSettings.normalize(
                getContext(), call.getString("serverUrl", ""));
            JSObject result = new JSObject();
            result.put("serverUrl", serverUrl);
            call.resolve(result);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void testConnection(PluginCall call) {
        final String serverUrl;
        try {
            serverUrl = ServerSettings.normalize(
                getContext(), call.getString("serverUrl", ""));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        networkExecutor.execute(() -> probe(serverUrl, call));
    }

    @PluginMethod
    public void save(PluginCall call) {
        try {
            String serverUrl = ServerSettings.save(getContext(), call.getString("serverUrl", ""));
            JSObject result = new JSObject();
            result.put("serverUrl", serverUrl);
            call.resolve(result);
            restartApp();
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void reset(PluginCall call) {
        String serverUrl = ServerSettings.reset(getContext());
        JSObject result = new JSObject();
        result.put("serverUrl", serverUrl);
        call.resolve(result);
        restartApp();
    }

    @Override
    protected void handleOnDestroy() {
        networkExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private void probe(String serverUrl, PluginCall call) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(serverUrl + "/api/health/ready");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(6000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            String body = readLimited(stream, 2048);
            if (status < 200 || status >= 300) {
                call.reject("服务器健康检查失败（HTTP " + status + "）");
                return;
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("serverUrl", serverUrl);
            result.put("status", status);
            result.put("response", body);
            call.resolve(result);
        } catch (Exception error) {
            String message = error.getMessage();
            call.reject("无法连接该服务器" + (message == null || message.isBlank() ? "" : "：" + message));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimited(InputStream stream, int limit) throws Exception {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            int value;
            while (result.length() < limit && (value = reader.read()) != -1) {
                result.append((char) value);
            }
        }
        return result.toString();
    }

    private void restartApp() {
        Intent stop = new Intent(getContext(), RepairNotificationService.class);
        stop.setAction(RepairNotificationService.ACTION_STOP);
        try {
            getContext().startService(stop);
        } catch (RuntimeException ignored) {
            getContext().stopService(stop);
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (getActivity() != null && !getActivity().isFinishing()) getActivity().recreate();
        }, 350);
    }
}
