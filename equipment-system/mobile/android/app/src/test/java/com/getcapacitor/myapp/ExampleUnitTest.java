package com.ysm.equipment.mobiletest;

import static org.junit.Assert.*;

import org.junit.Test;

public class ExampleUnitTest {

    @Test
    public void notificationRetryUsesBoundedExponentialBackoff() {
        assertEquals(0, RepairNotificationService.retryDelaySeconds(0));
        assertEquals(30, RepairNotificationService.retryDelaySeconds(1));
        assertEquals(60, RepairNotificationService.retryDelaySeconds(2));
        assertEquals(120, RepairNotificationService.retryDelaySeconds(3));
        assertEquals(240, RepairNotificationService.retryDelaySeconds(4));
        assertEquals(300, RepairNotificationService.retryDelaySeconds(5));
        assertEquals(300, RepairNotificationService.retryDelaySeconds(20));
    }

    @Test
    public void serverUrlPolicyAllowsHttpsAndDebugPrivateHttp() {
        assertEquals(
            "https://equipment.example.com",
            ServerUrlPolicy.normalize(" equipment.example.com/ ", false)
        );
        assertEquals(
            "http://192.168.31.185:8788",
            ServerUrlPolicy.normalize("http://192.168.31.185:8788/", true)
        );
    }

    @Test
    public void serverUrlPolicyRejectsUnsafeOrNonRootAddresses() {
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize("http://equipment.example.com", true)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize("http://192.168.31.185:8788", false)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize("https://user:secret@example.com", false)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize("https://example.com/app", false)
        );
    }

    @Test
    public void serverUrlPolicyOnlyAllowsThePackagedPublicHttpTestServer() {
        assertEquals(
            "http://203.0.113.10:8788",
            ServerUrlPolicy.normalize(
                "http://203.0.113.10:8788/",
                true,
                "http://203.0.113.10:8788"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize(
                "http://203.0.113.10:8787",
                true,
                "http://203.0.113.10:8788"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerUrlPolicy.normalize(
                "http://203.0.113.11:8788",
                true,
                "http://203.0.113.10:8788"
            )
        );
    }
}
