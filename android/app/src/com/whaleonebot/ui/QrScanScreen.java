package com.whaleonebot.ui;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.remote.QrDecoder;
import com.whaleonebot.remote.RemoteControlManager;
import com.whaleonebot.remote.RemoteStore;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 内置扫码配对页（Camera2 高清采集 + 比例旋转校正 + 点击对焦 + 扫描光条动画 + 相册选图 + 口令粘贴，零 GMS 依赖）。
 */
final class QrScanScreen extends Screen {

    private static final String TAG = "WhaleQr";
    static final int REQ_CAMERA = 0x5711;
    static final int REQ_PICK_QR_IMAGE = 0x5712;

    private TextureView preview;
    private View scanLine;
    private ObjectAnimator scanAnim;
    private TextView statusText;
    private TextView torchBtn;
    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private CaptureRequest.Builder previewRequest;
    private ImageReader imageReader;
    private HandlerThread camThread;
    private Handler camHandler;
    private Size previewSize = new Size(1280, 720);
    private Size decodeSize = new Size(1280, 720);
    private int sensorOrientation = 90;
    private int bestAfMode = CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
    private boolean torchOn;
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private final AtomicBoolean pairing = new AtomicBoolean(false);
    private long lastDecodeAt = 0L;
    private long lastNonPairHintAt = 0L;
    private int framesProcessed = 0;

    QrScanScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView sv = new ScrollView(activity);
        sv.setFillViewport(true);
        root.addView(sv, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        sv.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("扫码配对远端设备"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 摄像头预览卡 ----------
        FrameLayout camCard = Ui.card(activity, t);
        camCard.setClipToOutline(true);
        preview = new TextureView(activity);
        preview.setOnClickListener(v -> triggerTapFocus());
        camCard.addView(preview, new FrameLayout.LayoutParams(MATCH_PARENT, dp(340)));

        // 取景框 + 动态扫描光条
        int boxPx = dp(224);
        FrameLayout finderBox = new FrameLayout(activity);
        finderBox.setBackground(Drawables.round(0x00000000, t.accent, dp(2), dp(16)));
        finderBox.setClipToOutline(true);

        scanLine = new View(activity);
        scanLine.setBackgroundColor(Ui.alpha(t.accent, 0.85f));
        FrameLayout.LayoutParams lineLp = new FrameLayout.LayoutParams(MATCH_PARENT, dp(3), Gravity.TOP);
        lineLp.leftMargin = dp(8);
        lineLp.rightMargin = dp(8);
        finderBox.addView(scanLine, lineLp);
        camCard.addView(finderBox, new FrameLayout.LayoutParams(boxPx, boxPx, Gravity.CENTER));

        statusText = Ui.text(activity, "正在启动摄像头…", Theme.T_CAP, 0xFFFFFFFF);
        statusText.setGravity(Gravity.CENTER);
        statusText.setBackground(Drawables.round(0xB3000000, 0, 0, dp(Theme.R_PILL)));
        statusText.setPadding(dp(12), dp(6), dp(12), dp(6));
        FrameLayout.LayoutParams stLp = new FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        stLp.bottomMargin = dp(12);
        camCard.addView(statusText, stLp);

        LinearLayout.LayoutParams cardLp = Ui.llp(MATCH_PARENT, dp(340));
        cardLp.topMargin = dp(Theme.S3);
        col.addView(camCard, cardLp);

        // ---------- 快捷方式卡（相册识别 + 粘贴口令 + 手电筒） ----------
        LinearLayout ops = Ui.addCard(col, activity, t, Theme.S3);
        ops.addView(Ui.strong(activity, "其他配对方式", Theme.T_CARD, t.textPrimary));
        TextView tip = Ui.text(activity,
                "拍另一台手机屏幕时请保持约 15–25 cm 距离，画面发虚可轻点取景框重新对焦；异地配对可直接「从相册选二维码」或「粘贴配对口令」（60 秒有效）。",
                Theme.T_CAP, t.textSecondary);
        tip.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams tipLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        tipLp.topMargin = dp(Theme.S1);
        ops.addView(tip, tipLp);

        LinearLayout row = Ui.row(activity);
        TextView pickImg = Ui.button(activity, t, "从相册选二维码", true);
        pickImg.setOnClickListener(v -> openGallery());
        TextView pasteBtn = Ui.button(activity, t, "粘贴配对口令", false);
        pasteBtn.setOnClickListener(v -> openPasteDialog());
        LinearLayout.LayoutParams b1 = Ui.llp(0, dp(Theme.TOUCH));
        b1.weight = 1f;
        LinearLayout.LayoutParams b2 = Ui.llp(0, dp(Theme.TOUCH));
        b2.weight = 1f;
        b2.leftMargin = dp(Theme.S2);
        row.addView(pickImg, b1);
        row.addView(pasteBtn, b2);
        LinearLayout.LayoutParams rowLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        rowLp.topMargin = dp(Theme.S3);
        ops.addView(row, rowLp);

        torchBtn = Ui.button(activity, t, "打开手电筒", false);
        torchBtn.setOnClickListener(v -> toggleTorch());
        LinearLayout.LayoutParams tlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        tlp.topMargin = dp(Theme.S2);
        ops.addView(torchBtn, tlp);

        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                ensureCameraStarted();
            }
            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) {
                configurePreviewTransform(w, h);
            }
            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) {
                stopCamera();
                return true;
            }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture s) {}
        });
    }

    @Override
    void onAttach() {
        ensureCameraStarted();
    }

    @Override
    boolean handleBack() {
        stopCamera();
        return false;
    }

    void onCameraPermissionGranted() {
        ensureCameraStarted();
    }

    void onImagePicked(Uri uri) {
        if (uri == null) return;
        setStatus("正在识别图片中的二维码…");
        new Thread(() -> {
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
                Bitmap bmp = BitmapFactory.decodeStream(in, null, opts);
                if (bmp == null) throw new IllegalArgumentException("无法读取图片");
                int maxSide = Math.max(bmp.getWidth(), bmp.getHeight());
                if (maxSide > 1280) {
                    float scale = 1280f / maxSide;
                    Bitmap scaled = Bitmap.createScaledBitmap(bmp,
                            Math.max(1, Math.round(bmp.getWidth() * scale)),
                            Math.max(1, Math.round(bmp.getHeight() * scale)), true);
                    if (scaled != bmp) bmp.recycle();
                    bmp = scaled;
                }
                int w = bmp.getWidth(), h = bmp.getHeight();
                int[] px = new int[w * h];
                bmp.getPixels(px, 0, w, 0, 0, w, h);
                bmp.recycle();
                String text = QrDecoder.decodeArgb(px, w, h);
                if (text == null || text.isEmpty()) {
                    activity.runOnUiThread(() -> {
                        setStatus("未在图片中识别到二维码，请换清晰原图或粘贴口令");
                        host().toast("未识别到二维码");
                    });
                    return;
                }
                handleDecodedPayload(text);
            } catch (Throwable e) {
                activity.runOnUiThread(() -> {
                    setStatus("识别失败：" + e.getMessage());
                    host().toast("图片识别失败");
                });
            }
        }, "qr-gallery-decode").start();
    }

    private void openGallery() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            activity.startActivityForResult(Intent.createChooser(intent, "选择包含配对二维码的图片"), REQ_PICK_QR_IMAGE);
        } catch (Throwable e) {
            host().toast("无法打开系统相册");
        }
    }

    private void openPasteDialog() {
        PromptSheet.showInput(activity, "粘贴配对口令",
                "输入以 whale-pair://v1? 开头的 3 分钟单次配对口令（可从被控设备的配对页一键复制）：",
                "whale-pair://v1?...", "", false, "立即配对",
                text -> handleDecodedPayload(text));
    }

    private void handleDecodedPayload(final String raw) {
        if (raw == null || !raw.contains("whale-pair://v1?")) {
            long now = System.currentTimeMillis();
            if (now - lastNonPairHintAt > 2000L) {
                lastNonPairHintAt = now;
                activity.runOnUiThread(() -> {
                    setStatus("已扫到普通二维码，请对准本应用配对码");
                    host().toast("不是 WhaleOneBot 配对码");
                });
            }
            return;
        }
        if (!pairing.compareAndSet(false, true)) return;
        Log.i(TAG, "decoded pair payload len=" + raw.length());
        activity.runOnUiThread(() -> {
            stopScanAnim();
            setStatus("已识别配对码！正在并发探测直连与加密信令…");
        });
        new Thread(() -> {
            try {
                RemoteStore.PairedPeer peer = RemoteControlManager.get(activity).pairWithUri(
                        raw, msg -> activity.runOnUiThread(() -> setStatus(msg)));
                Log.i(TAG, "pair success: " + peer.displayName());
                activity.runOnUiThread(() -> {
                    stopCamera();
                    host().toast("配对成功：" + peer.displayName());
                    shell.switchTargetDevice(peer.deviceId);
                });
            } catch (Throwable t) {
                pairing.set(false);
                String msg = t.getMessage() == null ? "配对失败" : t.getMessage();
                Log.w(TAG, "pair failed: " + msg, t);
                activity.runOnUiThread(() -> {
                    startScanAnim();
                    setStatus("配对失败：" + msg);
                    host().toast(msg);
                });
            }
        }, "qr-pair-connect").start();
    }

    private void ensureCameraStarted() {
        if (cameraDevice != null || preview == null || !preview.isAvailable()) return;
        if (activity.checkSelfPermission("android.permission.CAMERA") != PackageManager.PERMISSION_GRANTED) {
            setStatus("需要相机权限以实时扫码，也可直接选相册图片或粘贴口令");
            activity.requestPermissions(new String[]{"android.permission.CAMERA"}, REQ_CAMERA);
            return;
        }
        try {
            camThread = new HandlerThread("whale-cam2");
            camThread.start();
            camHandler = new Handler(camThread.getLooper());
            CameraManager cm = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
            if (cm == null) return;
            String backId = null;
            CameraCharacteristics chosenChars = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics cc = cm.getCameraCharacteristics(id);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    backId = id;
                    chosenChars = cc;
                    break;
                }
            }
            if (backId == null && cm.getCameraIdList().length > 0) {
                backId = cm.getCameraIdList()[0];
                chosenChars = cm.getCameraCharacteristics(backId);
            }
            if (backId == null || chosenChars == null) {
                setStatus("本机未检测到可用摄像头，请使用相册选图或粘贴口令");
                return;
            }
            Integer ori = chosenChars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = ori == null ? 90 : ori;
            bestAfMode = pickAfMode(chosenChars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES));

            StreamConfigurationMap map = chosenChars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map != null) {
                decodeSize = pickBestSize(map.getOutputSizes(ImageFormat.YUV_420_888), 1280, 960);
                previewSize = pickBestSize(map.getOutputSizes(SurfaceTexture.class),
                        decodeSize.getWidth(), decodeSize.getHeight());
            }
            Log.i(TAG, "camera=" + backId + " ori=" + sensorOrientation
                    + " preview=" + previewSize.getWidth() + "x" + previewSize.getHeight()
                    + " decode=" + decodeSize.getWidth() + "x" + decodeSize.getHeight());

            imageReader = ImageReader.newInstance(
                    decodeSize.getWidth(), decodeSize.getHeight(), ImageFormat.YUV_420_888, 2);
            imageReader.setOnImageAvailableListener(reader -> {
                Image img = null;
                try {
                    img = reader.acquireLatestImage();
                    if (img == null || pairing.get()) return;
                    long now = System.currentTimeMillis();
                    if (now - lastDecodeAt < 180L || !decoding.compareAndSet(false, true)) return;
                    lastDecodeAt = now;
                    final int w = img.getWidth();
                    final int h = img.getHeight();
                    Image.Plane yPlane = img.getPlanes()[0];
                    ByteBuffer buf = yPlane.getBuffer();
                    buf.rewind();
                    int rowStride = yPlane.getRowStride();
                    int pixelStride = yPlane.getPixelStride();
                    final byte[] luma = new byte[w * h];
                    if (pixelStride == 1 && rowStride == w) {
                        buf.get(luma, 0, Math.min(luma.length, buf.remaining()));
                    } else if (pixelStride == 1) {
                        byte[] rowBuf = new byte[rowStride];
                        for (int y = 0; y < h; y++) {
                            int take = Math.min(rowStride, buf.remaining());
                            if (take <= 0) break;
                            buf.get(rowBuf, 0, take);
                            System.arraycopy(rowBuf, 0, luma, y * w, Math.min(w, take));
                        }
                    } else {
                        for (int y = 0; y < h; y++) {
                            int rowBase = y * rowStride;
                            for (int x = 0; x < w; x++) {
                                int idx = rowBase + x * pixelStride;
                                if (idx < buf.limit()) luma[y * w + x] = buf.get(idx);
                            }
                        }
                    }
                    new Thread(() -> {
                        try {
                            QrDecoder.DecodeResult dr = QrDecoder.decodeLumaWithDiag(luma, w, h);
                            framesProcessed++;
                            if (dr.text != null && !dr.text.isEmpty()) {
                                handleDecodedPayload(dr.text);
                            } else if (!pairing.get()) {
                                final int seen = dr.maxFindersSeen;
                                final int count = framesProcessed;
                                activity.runOnUiThread(() -> {
                                    if (pairing.get()) return;
                                    if (seen >= 1) {
                                        setStatus("检测到二维码轮廓（" + seen + "/3），微调距离或轻点画面对焦");
                                    } else if (count == 1 || count % 12 == 0) {
                                        setStatus("扫描中（" + w + "×" + h + " · 轻点画面对焦）");
                                    }
                                });
                            }
                        } catch (Throwable err) {
                            Log.w(TAG, "decode frame error", err);
                        } finally {
                            decoding.set(false);
                        }
                    }, "qr-frame-decode").start();
                } catch (Throwable ignored) {
                } finally {
                    if (img != null) img.close();
                }
            }, camHandler);

            cm.openCamera(backId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    cameraDevice = camera;
                    startPreviewSession();
                }
                @Override
                public void onDisconnected(CameraDevice camera) {
                    stopCamera();
                }
                @Override
                public void onError(CameraDevice camera, int error) {
                    stopCamera();
                    activity.runOnUiThread(() -> setStatus("摄像头打开失败（#" + error + "），可使用相册选图或粘贴口令"));
                }
            }, camHandler);
        } catch (Throwable e) {
            Log.w(TAG, "camera start failed", e);
            setStatus("摄像头启动失败（" + e.getClass().getSimpleName() + "），请用相册选图或粘贴口令");
        }
    }

    private void startPreviewSession() {
        try {
            if (cameraDevice == null || preview == null || !preview.isAvailable() || imageReader == null) return;
            SurfaceTexture st = preview.getSurfaceTexture();
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            activity.runOnUiThread(() -> {
                configurePreviewTransform(preview.getWidth(), preview.getHeight());
                startScanAnim();
                setStatus("扫描中（" + decodeSize.getWidth() + "×" + decodeSize.getHeight() + " · 轻点画面对焦）");
            });
            Surface previewSurface = new Surface(st);
            Surface readerSurface = imageReader.getSurface();
            previewRequest = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewRequest.addTarget(previewSurface);
            previewRequest.addTarget(readerSurface);
            previewRequest.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            previewRequest.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            previewRequest.set(CaptureRequest.CONTROL_AF_MODE, bestAfMode);
            cameraDevice.createCaptureSession(Arrays.asList(previewSurface, readerSurface),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession session) {
                            if (cameraDevice == null) return;
                            captureSession = session;
                            try {
                                captureSession.setRepeatingRequest(previewRequest.build(), null, camHandler);
                            } catch (Throwable e) {
                                Log.w(TAG, "setRepeatingRequest failed", e);
                                activity.runOnUiThread(() -> setStatus("预览流启动失败：" + e.getMessage()));
                            }
                        }
                        @Override
                        public void onConfigureFailed(CameraCaptureSession session) {
                            Log.e(TAG, "CameraCaptureSession configure failed");
                            activity.runOnUiThread(() -> setStatus("相机会话配置失败，请点击下方「从相册选二维码」或「粘贴口令」"));
                        }
                    }, camHandler);
        } catch (Throwable e) {
            Log.w(TAG, "startPreviewSession failed", e);
            activity.runOnUiThread(() -> setStatus("预览启动异常：" + e.getMessage()));
        }
    }

    /** 保持预览不拉伸、居中铺满（center-crop），让取景框内画面与传感器采集画面一致。 */
    private void configurePreviewTransform(int viewW, int viewH) {
        if (preview == null || viewW <= 0 || viewH <= 0) return;
        int rot = 0;
        try {
            rot = activity.getWindowManager().getDefaultDisplay().getRotation();
        } catch (Throwable ignored) {}
        boolean swap = (rot == Surface.ROTATION_0 || rot == Surface.ROTATION_180)
                ? (sensorOrientation == 90 || sensorOrientation == 270)
                : (sensorOrientation == 0 || sensorOrientation == 180);
        float bufW = swap ? previewSize.getHeight() : previewSize.getWidth();
        float bufH = swap ? previewSize.getWidth() : previewSize.getHeight();
        if (bufW <= 0 || bufH <= 0) return;
        float scaleX = bufW / viewW;
        float scaleY = bufH / viewH;
        float maxScale = Math.max(scaleX, scaleY);
        // TextureView 默认把缓冲拉伸到 viewW×viewH，这里反推 center-crop 缩放比
        float sx = (bufW / bufH) / ((float) viewW / viewH);
        float sy = 1f;
        if (sx < 1f) {
            sy = 1f / sx;
            sx = 1f;
        }
        Matrix m = new Matrix();
        m.setScale(sx, sy, viewW / 2f, viewH / 2f);
        if (maxScale > 0) preview.setTransform(m);
    }

    /** 轻点取景框主动触发一次自动对焦，解决近距拍手机屏失焦。 */
    private void triggerTapFocus() {
        if (captureSession == null || previewRequest == null || camHandler == null) return;
        try {
            setStatus("正在重新对焦…");
            CaptureRequest.Builder once = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            SurfaceTexture st = preview.getSurfaceTexture();
            if (st != null) once.addTarget(new Surface(st));
            if (imageReader != null) once.addTarget(imageReader.getSurface());
            once.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            once.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
            once.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
            captureSession.capture(once.build(), null, camHandler);
            camHandler.postDelayed(() -> {
                try {
                    if (captureSession != null && previewRequest != null) {
                        previewRequest.set(CaptureRequest.CONTROL_AF_MODE, bestAfMode);
                        previewRequest.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_IDLE);
                        captureSession.setRepeatingRequest(previewRequest.build(), null, camHandler);
                    }
                } catch (Throwable ignored) {}
            }, 900L);
        } catch (Throwable ignored) {
        }
    }

    private void startScanAnim() {
        if (scanLine == null) return;
        stopScanAnim();
        scanLine.setVisibility(View.VISIBLE);
        scanAnim = ObjectAnimator.ofFloat(scanLine, "translationY", dp(10), dp(210));
        scanAnim.setDuration(1800L);
        scanAnim.setRepeatCount(ValueAnimator.INFINITE);
        scanAnim.setRepeatMode(ValueAnimator.REVERSE);
        scanAnim.setInterpolator(new LinearInterpolator());
        scanAnim.start();
    }

    private void stopScanAnim() {
        if (scanAnim != null) {
            scanAnim.cancel();
            scanAnim = null;
        }
        if (scanLine != null) scanLine.setVisibility(View.INVISIBLE);
    }

    private static int pickAfMode(int[] modes) {
        if (modes == null) return CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
        for (int m : modes) if (m == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) return m;
        for (int m : modes) if (m == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) return m;
        for (int m : modes) if (m == CaptureRequest.CONTROL_AF_MODE_AUTO) return m;
        return CaptureRequest.CONTROL_AF_MODE_OFF;
    }

    /** 选择 900–1920 宽度区间、最接近目标分辨率的高清输出尺寸，保证二维码每模块足够像素数。 */
    private static Size pickBestSize(Size[] sizes, int wantW, int wantH) {
        if (sizes == null || sizes.length == 0) return new Size(wantW, wantH);
        Size best = null;
        long bestDiff = Long.MAX_VALUE;
        long targetArea = (long) wantW * wantH;
        for (Size s : sizes) {
            int w = s.getWidth(), h = s.getHeight();
            if (w < 640 || h < 480 || w > 1920 || h > 1440) continue;
            long area = (long) w * h;
            long diff = Math.abs(area - targetArea);
            // 略微偏爱 >= 1280x720 以便高密二维码每个点都有 6+ 像素
            if (area < 900_000L) diff += 600_000L;
            if (diff < bestDiff) {
                bestDiff = diff;
                best = s;
            }
        }
        return best != null ? best : sizes[0];
    }

    private void toggleTorch() {
        if (captureSession == null || previewRequest == null) return;
        torchOn = !torchOn;
        try {
            previewRequest.set(CaptureRequest.FLASH_MODE,
                    torchOn ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
            captureSession.setRepeatingRequest(previewRequest.build(), null, camHandler);
            torchBtn.setText(torchOn ? "关闭手电筒" : "打开手电筒");
        } catch (Throwable ignored) {
        }
    }

    private void stopCamera() {
        stopScanAnim();
        try {
            if (captureSession != null) { captureSession.close(); captureSession = null; }
        } catch (Throwable ignored) {}
        try {
            if (cameraDevice != null) { cameraDevice.close(); cameraDevice = null; }
        } catch (Throwable ignored) {}
        try {
            if (imageReader != null) { imageReader.close(); imageReader = null; }
        } catch (Throwable ignored) {}
        try {
            if (camThread != null) { camThread.quitSafely(); camThread = null; camHandler = null; }
        } catch (Throwable ignored) {}
    }

    private void setStatus(String text) {
        if (statusText != null) statusText.setText(text);
    }
}
