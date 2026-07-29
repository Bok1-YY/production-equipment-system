package com.ysm.equipment.mobiletest;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.service.notification.StatusBarNotification;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

public class RepairNotificationService extends Service {
    static final String ACTION_START = "com.ysm.equipment.mobiletest.START_REPAIR_NOTIFICATIONS";
    static final String ACTION_STOP = "com.ysm.equipment.mobiletest.STOP_REPAIR_NOTIFICATIONS";
    static final String EXTRA_SERVER_URL = "server_url";
    static final String EXTRA_NOTIFICATION_TOKEN = "notification_token";
    static final String EXTRA_USER_ID = "user_id";
    static final String EXTRA_WORK_ORDER_ID = "work_order_id";

    private static final String PREFS = "repair_notifications";
    private static final String PREF_TOKEN_CIPHER = "notification_token_cipher";
    private static final String PREF_TOKEN_IV = "notification_token_iv";
    private static final String KEY_ALIAS = "ysm_repair_notification_token";
    private static final String CHANNEL_MONITOR = "repair_monitor";
    private static final String CHANNEL_REPAIRS = "new_repairs";
    private static final String GROUP_REPAIRS = "ysm_pending_repairs";
    private static final int MONITOR_ID = 9100;
    private static final int SUMMARY_ID = 9101;
    private static final long POLL_SECONDS = 30;

    private final Set<Integer> visibleRepairIds = new HashSet<>();
    private ScheduledExecutorService executor;
    private NotificationManager notifications;
    private SharedPreferences preferences;
    private int consecutiveFailures;
    private long nextAttemptAt;

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopMonitoring();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra(EXTRA_SERVER_URL)) {
            preferences.edit()
                .putString(EXTRA_SERVER_URL, intent.getStringExtra(EXTRA_SERVER_URL))
                .putInt(EXTRA_USER_ID, intent.getIntExtra(EXTRA_USER_ID, 0))
                .apply();
            try {
                storeNotificationToken(intent.getStringExtra(EXTRA_NOTIFICATION_TOKEN));
            } catch (Exception error) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        startForeground(MONITOR_ID, monitorNotification());
        startPolling();
        return START_STICKY;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel monitor = new NotificationChannel(
            CHANNEL_MONITOR, "报修通知运行状态", NotificationManager.IMPORTANCE_LOW);
        monitor.setDescription("保持厂区 Wi-Fi 下的报修消息监听");
        monitor.setShowBadge(false);
        notifications.createNotificationChannel(monitor);

        NotificationChannel repairs = new NotificationChannel(
            CHANNEL_REPAIRS, "新设备报修", NotificationManager.IMPORTANCE_HIGH);
        repairs.setDescription("通知技术员有新的待接单设备报修");
        repairs.enableVibration(true);
        repairs.setShowBadge(true);
        repairs.setLightColor(Color.RED);
        repairs.enableLights(true);
        notifications.createNotificationChannel(repairs);
    }

    private Notification monitorNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_MONITOR)
            .setSmallIcon(R.drawable.ic_stat_repair)
            .setContentTitle("报修通知已开启")
            .setContentText("正在通过厂区 Wi-Fi 监听新的设备报修")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private synchronized void startPolling() {
        if (executor != null && !executor.isShutdown()) return;
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::pollSafely, 0, POLL_SECONDS, TimeUnit.SECONDS);
    }

    private void pollSafely() {
        if (System.currentTimeMillis() < nextAttemptAt) return;
        try {
            PollResult result = fetchRepairs();
            if (result.unauthorized) {
                stopMonitoring();
                return;
            }
            consecutiveFailures = 0;
            nextAttemptAt = 0;
            showRepairs(result.repairs);
        } catch (Exception ignored) {
            // Wi-Fi 临时切换或服务维护时指数退避，避免手机在断网期间持续唤醒和耗电。
            consecutiveFailures += 1;
            nextAttemptAt = System.currentTimeMillis()
                + TimeUnit.SECONDS.toMillis(retryDelaySeconds(consecutiveFailures));
        }
    }

    static long retryDelaySeconds(int failures) {
        if (failures <= 0) return 0;
        return Math.min(300, 30L << Math.min(failures - 1, 4));
    }

    private PollResult fetchRepairs() throws Exception {
        String serverUrl = preferences.getString(EXTRA_SERVER_URL, "");
        String token = loadNotificationToken();
        if (serverUrl.isBlank() || token.isBlank()) throw new IllegalStateException("missing notification token");
        URL url = new URL(serverUrl.replaceAll("/+$", "") + "/api/notifications/repairs");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        int status = connection.getResponseCode();
        if (status == 401 || status == 403) {
            connection.disconnect();
            return new PollResult(true, new JSONArray());
        }
        if (status != 200) {
            connection.disconnect();
            throw new IllegalStateException("HTTP " + status);
        }
        String body = readAll(connection.getInputStream());
        connection.disconnect();
        JSONObject payload = new JSONObject(body);
        return new PollResult(false, payload.getJSONArray("data"));
    }

    private String readAll(InputStream stream) throws Exception {
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) output.append(line);
        }
        return output.toString();
    }

    private synchronized void showRepairs(JSONArray repairs) {
        Set<Integer> current = new HashSet<>();
        int count = repairs.length();
        for (int index = 0; index < count; index++) {
            JSONObject repair = repairs.optJSONObject(index);
            if (repair == null) continue;
            int id = repair.optInt("id");
            if (id <= 0) continue;
            current.add(id);
            notifications.notify(notificationId(id), repairNotification(repair, count));
        }

        for (int oldId : visibleRepairIds) {
            if (!current.contains(oldId)) notifications.cancel(notificationId(oldId));
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            for (StatusBarNotification active : notifications.getActiveNotifications()) {
                int notificationId = active.getId();
                if (notificationId >= 100000 && !current.contains(notificationId - 100000)) {
                    notifications.cancel(notificationId);
                }
            }
        }
        visibleRepairIds.clear();
        visibleRepairIds.addAll(current);

        if (count > 0) notifications.notify(SUMMARY_ID, summaryNotification(count));
        else notifications.cancel(SUMMARY_ID);
    }

    private Notification repairNotification(JSONObject repair, int count) {
        int id = repair.optInt("id");
        String line = value(repair, "line_name", "未知产线");
        String equipment = value(repair, "equipment_alias",
            value(repair, "equipment_name", value(repair, "process_name", "未指定设备")));
        String code = repair.optString("equipment_code", "");
        String fault = value(repair, "fault_symptom", value(repair, "description", "有人提交了设备报修"));
        boolean downtime = repair.optInt("is_downtime") == 1;
        String title = (downtime ? "停机报修 · " : "新报修 · ") + line;
        String machine = code.isBlank() ? equipment : code + " " + equipment;
        String detail = machine + "：" + fault;

        Intent open = new Intent(this, MainActivity.class);
        open.putExtra(EXTRA_WORK_ORDER_ID, id);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, notificationId(id), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_REPAIRS)
            .setSmallIcon(R.drawable.ic_stat_repair)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(pendingIntent)
            .setGroup(GROUP_REPAIRS)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(downtime ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_HIGH)
            .setNumber(count)
            .setOnlyAlertOnce(true)
            .setOngoing(false)
            .build();
    }

    private Notification summaryNotification(int count) {
        Intent open = new Intent(this, MainActivity.class);
        open.putExtra(EXTRA_WORK_ORDER_ID, -1);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, SUMMARY_ID, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_REPAIRS)
            .setSmallIcon(R.drawable.ic_stat_repair)
            .setContentTitle("有 " + count + " 条设备报修待接单")
            .setContentText("点击进入待接单池")
            .setContentIntent(pendingIntent)
            .setGroup(GROUP_REPAIRS)
            .setGroupSummary(true)
            .setNumber(count)
            .setOnlyAlertOnce(true)
            .build();
    }

    private String value(JSONObject source, String key, String fallback) {
        String value = source.optString(key, "").trim();
        return value.isEmpty() || "null".equals(value) ? fallback : value;
    }

    private int notificationId(int workOrderId) {
        return 100000 + Math.floorMod(workOrderId, 1000000000);
    }

    private synchronized void stopMonitoring() {
        String serverUrl = preferences.getString(EXTRA_SERVER_URL, "");
        String token = loadNotificationToken();
        if (!serverUrl.isBlank() && !token.isBlank()) {
            new Thread(() -> revokeToken(serverUrl, token), "ysm-notification-revoke").start();
        }
        if (executor != null) executor.shutdownNow();
        executor = null;
        for (int id : visibleRepairIds) notifications.cancel(notificationId(id));
        visibleRepairIds.clear();
        notifications.cancel(SUMMARY_ID);
        notifications.cancel(MONITOR_ID);
        preferences.edit().clear().apply();
        stopForeground(true);
        stopSelf();
    }

    private SecretKey notificationKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    private void storeNotificationToken(String token) throws Exception {
        if (token == null || token.isBlank()) throw new IllegalArgumentException("empty notification token");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, notificationKey());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        preferences.edit()
            .putString(PREF_TOKEN_CIPHER, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(PREF_TOKEN_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .apply();
    }

    private String loadNotificationToken() {
        String encrypted = preferences.getString(PREF_TOKEN_CIPHER, "");
        String iv = preferences.getString(PREF_TOKEN_IV, "");
        if (encrypted.isBlank() || iv.isBlank()) return "";
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, notificationKey(),
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] clear = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP));
            return new String(clear, StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "";
        }
    }

    private void revokeToken(String serverUrl, String token) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(serverUrl.replaceAll("/+$", "") + "/api/notification-device");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("DELETE");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.getResponseCode();
        } catch (Exception ignored) {
            // 令牌还有绝对有效期；断网时由服务端自动过期，不能因此阻塞登出。
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        executor = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static final class PollResult {
        final boolean unauthorized;
        final JSONArray repairs;

        PollResult(boolean unauthorized, JSONArray repairs) {
            this.unauthorized = unauthorized;
            this.repairs = repairs;
        }
    }
}
