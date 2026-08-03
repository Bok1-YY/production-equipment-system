package com.ysm.equipment.mobiletest;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.nio.file.Files;

@CapacitorPlugin(
    name = "PatrolCamera",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class PatrolCameraPlugin extends Plugin {
    private File pendingPhoto;

    @PluginMethod
    public void takePhoto(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        launchCamera(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("需要相机权限才能提交巡检记录", "CAMERA_PERMISSION_DENIED");
            return;
        }
        launchCamera(call);
    }

    private void launchCamera(PluginCall call) {
        try {
            File directory = new File(getContext().getCacheDir(), "patrol-camera");
            if (!directory.exists() && !directory.mkdirs()) {
                call.reject("无法准备拍照缓存，请重试", "CAMERA_CACHE_FAILED");
                return;
            }
            pendingPhoto = File.createTempFile("patrol-", ".jpg", directory);
            Uri outputUri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", pendingPhoto);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, outputUri);
            intent.setClipData(ClipData.newRawUri("patrol-photo", outputUri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                discardPendingPhoto();
                call.reject("这台设备没有可用的相机", "CAMERA_UNAVAILABLE");
                return;
            }
            startActivityForResult(call, intent, "cameraResult");
        } catch (Exception error) {
            discardPendingPhoto();
            call.reject("无法打开相机，请重试", "CAMERA_OPEN_FAILED", error);
        }
    }

    @ActivityCallback
    private void cameraResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            discardPendingPhoto();
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK) {
            discardPendingPhoto();
            call.reject("拍摄已取消", "CAMERA_CANCELLED");
            return;
        }
        if (pendingPhoto == null || !pendingPhoto.isFile() || pendingPhoto.length() == 0) {
            discardPendingPhoto();
            call.reject("相机没有返回有效照片，请重新拍摄", "CAMERA_EMPTY_RESULT");
            return;
        }
        try {
            byte[] bytes = Files.readAllBytes(pendingPhoto.toPath());
            JSObject response = new JSObject();
            response.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            response.put("name", pendingPhoto.getName());
            response.put("size", bytes.length);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("无法读取刚拍摄的照片，请重新拍摄", "CAMERA_READ_FAILED", error);
        } finally {
            discardPendingPhoto();
        }
    }

    private void discardPendingPhoto() {
        if (pendingPhoto != null && pendingPhoto.exists()) pendingPhoto.delete();
        pendingPhoto = null;
    }
}
