package com.ysm.equipment.mobiletest;

import static org.junit.Assert.*;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void productionSensitiveComponentsAreNotExportedOrBackedUp() throws Exception {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(BuildConfig.APPLICATION_ID, appContext.getPackageName());
        ApplicationInfo applicationInfo = appContext.getApplicationInfo();
        assertEquals(0, applicationInfo.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        ServiceInfo serviceInfo = appContext.getPackageManager().getServiceInfo(
            new ComponentName(appContext, RepairNotificationService.class), 0);
        assertFalse(serviceInfo.exported);
    }
}
