package com.ysm.equipment.mobiletest;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class ServerUrlPolicy {
    private ServerUrlPolicy() {}

    static String normalize(String input, boolean allowPrivateHttp) {
        return normalize(input, allowPrivateHttp, "");
    }

    static String normalize(String input, boolean allowPrivateHttp, String packagedTestHttpUrl) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("请填写服务器地址");
        }
        if (!value.contains("://")) {
            value = "https://" + value;
        }

        final URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("服务器地址格式不正确");
        }

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("服务器地址只能使用 http:// 或 https://");
        }
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("服务器地址缺少有效域名或 IP");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("服务器地址不能包含账号或密码");
        }
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            throw new IllegalArgumentException("只填写服务器根地址，不要附带网页路径");
        }
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("服务器地址不能包含参数或锚点");
        }
        int port = uri.getPort();
        if (port == 0 || port > 65535) {
            throw new IllegalArgumentException("服务器端口不正确");
        }
        String authority = uri.getRawAuthority();
        String normalized = scheme + "://" + authority;
        boolean packagedTestServer = allowPrivateHttp
            && normalized.equals(normalizePackagedTestHttpUrl(packagedTestHttpUrl));
        if ("http".equals(scheme)
            && (!allowPrivateHttp || (!isPrivateHost(host) && !packagedTestServer))) {
            throw new IllegalArgumentException(
                allowPrivateHttp
                    ? "HTTP 只允许局域网私有 IP 或安装包指定的云端测试服务器"
                    : "正式版只允许 HTTPS 服务器地址"
            );
        }

        return normalized;
    }

    private static String normalizePackagedTestHttpUrl(String input) {
        String value = input == null ? "" : input.trim().replaceAll("/+$", "");
        if (!value.startsWith("http://")) return "";
        try {
            URI uri = new URI(value);
            if (uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null) return "";
            String path = uri.getRawPath();
            if (path != null && !path.isEmpty() && !"/".equals(path)) return "";
            return "http://" + uri.getRawAuthority();
        } catch (URISyntaxException error) {
            return "";
        }
    }

    static boolean isPrivateHost(String input) {
        String host = input == null ? "" : input.toLowerCase(Locale.ROOT);
        if ("localhost".equals(host) || "::1".equals(host) || "[::1]".equals(host)) return true;
        if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;

        String[] pieces = host.split("\\.", -1);
        if (pieces.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < pieces.length; index++) {
                if (pieces[index].isEmpty()) return false;
                octets[index] = Integer.parseInt(pieces[index]);
                if (octets[index] < 0 || octets[index] > 255) return false;
            }
        } catch (NumberFormatException error) {
            return false;
        }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
    }
}
