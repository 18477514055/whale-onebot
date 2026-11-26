package com.whaleonebot;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * 极简状态端点：127.0.0.1:8787
 *  - GET /status  -> JSON：running / pid / tail
 *  - GET /log     -> text：容器日志尾部
 * 只绑回环；不监听外部。用途：手机本机其它进程（Termux/adb）能读运行状态，
 * 也作为后续控制面板的临时入口。
 */
final class HttpStatusServer implements Runnable {

    static final int PORT = 8787;
    private final ContainerService svc;
    private volatile boolean stopped = false;
    private ServerSocket server;

    HttpStatusServer(ContainerService svc) { this.svc = svc; }

    void stop() {
        stopped = true;
        try { if (server != null) server.close(); } catch (Throwable ignored) {}
    }

    @Override public void run() {
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 8);
            svc.logLine("http listening on 127.0.0.1:" + PORT);
            while (!stopped) {
                Socket s = server.accept();
                new Thread(() -> handle(s), "whale-http").start();
            }
        } catch (Throwable t) {
            svc.logLine("http 状态端点退出: " + t);
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), "UTF-8"));
            String req = in.readLine();
            while (true) {
                String h = in.readLine();
                if (h == null || h.isEmpty()) break;
            }
            String path = "/";
            if (req != null) {
                String[] parts = req.split(" ");
                if (parts.length > 1) path = parts[1];
            }
            String body;
            String type = "text/plain; charset=utf-8";
            if (path.startsWith("/bindings?")) {
                type = "application/json; charset=utf-8";
                body = ContainerService.bindingStatus(svc,param(path,"bot")).toString();
            } else if (path.startsWith("/status")) {
                type = "application/json; charset=utf-8";
                body = "{\"running\":" + ContainerService.isRunning()
                        + ",\"pid\":" + ContainerService.containerPid() + "}";
            } else if (path.startsWith("/exec")) {
                String cmd = param(path, "cmd");
                body = !legacyDebugEnabled() ? "debug disabled" : cmd.isEmpty() ? "(need cmd)" : ContainerService.execInContainer(svc.getFilesDir(), cmd);
            } else if (path.startsWith("/botstart")) {
                ContainerService.startBot(svc);
                body = "bot-start-requested";
            } else if (path.startsWith("/botstop")) {
                ContainerService.stopBot();
                body = "bot-stop-requested";
            } else if (path.startsWith("/botlog")) {
                body = tail(new File(svc.getFilesDir(), "rootfs/opt/whale/qq-state/bot.log"), 200);
            } else if (path.startsWith("/bot")) {
                type = "application/json; charset=utf-8";
                body = BindingControl.legacy(svc.getFilesDir(),false) && ContainerService.botRunning(svc)
                        ? readAll(new File(svc.getFilesDir(), "rootfs/opt/whale/qq-state/bot.json")) : "{\"phase\":\"stopped\"}";
            } else if (path.startsWith("/raw")) {
                String cmd = param(path, "cmd");
                body = !legacyDebugEnabled() ? "debug disabled" : cmd.isEmpty() ? "(need cmd)" : ContainerService.execHost(svc.getFilesDir(), cmd);
            } else {
                body = tail(new File(svc.getFilesDir(), "logs/container.log"), 300);
            }
            byte[] b = body.getBytes("UTF-8");
            OutputStream out = sock.getOutputStream();
            String head = "HTTP/1.1 200 OK\r\nContent-Type: " + type
                    + "\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes("UTF-8"));
            out.write(b);
            out.flush();
        } catch (Throwable t) {
            svc.logLine("http handler error: " + t);
        }
    }

    // Loopback is shared with other Android apps. Never expose a modern session through a shell.
    private boolean legacyDebugEnabled() {
        return (svc.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0
                && new File(svc.getFilesDir(),"allow-legacy-debug-shell").isFile()
                && legacyDebugRegistry();
    }
    private boolean legacyDebugRegistry(){
        try{if(!BindingControl.legacy(svc.getFilesDir(),true))return false;
            org.json.JSONObject bot=BindingControl.find(BindingControl.bots(svc.getFilesDir()),"whale-1");return bot.getJSONArray("platforms").length()==1&&(bot.optJSONArray("bindings")==null||bot.getJSONArray("bindings").length()==1);
        }catch(Exception e){return false;}
    }

    /** 从 "/exec?cmd=xxx" 里取并 URL 解码参数。 */
    static String param(String path, String name) {
        int q = path.indexOf('?');
        if (q < 0) return "";
        for (String kv : path.substring(q + 1).split("&")) {
            int eq = kv.indexOf('=');
            if (eq > 0 && name.equals(kv.substring(0, eq))) {
                try {
                    return java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                } catch (Throwable t) {
                    return "";
                }
            }
        }
        return "";
    }

    /** 读一个小的 UTF-8 文本文件（状态文件用）。 */
    static String readAll(File f) {
        if (f == null || !f.isFile()) return "{}";
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            byte[] buf = new byte[(int) Math.min(raf.length(), 64 * 1024)];
            raf.readFully(buf);
            return new String(buf, "UTF-8");
        } catch (Exception e) {
            return "{\"error\":" + "\"" + e.getMessage() + "\"}";
        }
    }

    static String tail(File f, int n) {        if (f == null || !f.isFile()) return "(no log)";
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long len = raf.length();
            int take = (int) Math.min(len, 64 * 1024);
            raf.seek(len - take);
            byte[] buf = new byte[take];
            raf.readFully(buf);
            String s = new String(buf, "UTF-8");
            String[] lines = s.split("\n");
            int from = Math.max(0, lines.length - n);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < lines.length; i++) sb.append(lines[i]).append('\n');
            return sb.toString();
        } catch (Exception e) {
            return "(read log failed: " + e.getMessage() + ")";
        }
    }
}
