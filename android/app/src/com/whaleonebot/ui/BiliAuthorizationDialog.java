package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import io.nayuki.qrcodegen.QrCode;

/**
 * [layer: shell-android] Render the one-time QR in memory inside unified PromptSheet.
 * Only a user-triggered, domain-verified app handoff may carry the link.
 */
final class BiliAuthorizationDialog {
    static View image(Activity a, String challenge) {
        if (!BiliWebLogin.accepts(challenge) || BiliWebLogin.START.equals(challenge)) {
            throw new IllegalArgumentException("invalid challenge");
        }
        final QrCode qr = QrCode.encodeText(challenge, QrCode.Ecc.MEDIUM);
        View image = new View(a) {
            final Paint paint = new Paint();
            protected void onDraw(Canvas c) {
                c.drawColor(0xffffffff);
                int step = Math.min(getWidth(), getHeight()) / (qr.size + 8);
                if (step < 1) return;
                int x = (getWidth() - qr.size * step) / 2;
                int y = (getHeight() - qr.size * step) / 2;
                paint.setColor(0xff000000);
                paint.setAntiAlias(false);
                for (int j = 0; j < qr.size; j++) {
                    for (int i = 0; i < qr.size; i++) {
                        if (qr.getModule(i, j)) {
                            c.drawRect(x + i * step, y + j * step, x + (i + 1) * step, y + (j + 1) * step, paint);
                        }
                    }
                }
            }
        };
        image.setContentDescription("本次 B 站官方授权二维码");
        return image;
    }

    static Dialog show(Activity a, String challenge, String uid, Runnable cancel) {
        if (!BiliWebLogin.accepts(challenge) || BiliWebLogin.START.equals(challenge)) return null;
        Theme t = PromptSheet.currentTheme(a);
        View image = image(a, challenge);
        LinearLayout box = Ui.column(a);
        TextView note = Ui.text(a,
                "用哔哩哔哩扫码，或截图后从扫一扫的相册识码。核对账号：" + uid + "。不要转发此码。确认后会自动核验账号。",
                Theme.T_BODY, t.textSecondary);
        box.addView(note);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(a, 260));
        ilp.topMargin = Ui.dp(a, Theme.S2);
        box.addView(image, ilp);

        return PromptSheet.custom(
                a, t, "B 站官方授权", box,
                "用本机哔哩哔哩确认", (d, btn) -> {
                    if (BiliLocalConfirmation.open(a, challenge)) d.dismiss();
                    else {
                        note.setText("未授权 B 站默认打开链接：可改用「官网网页登录」或截图相册扫码。");
                        BiliLocalConfirmation.openAppLinksSettings(a);
                    }
                },
                "返回查看状态", (d, btn) -> d.dismiss(),
                "取消本次授权", (d, btn) -> { d.dismiss(); if (cancel != null) cancel.run(); },
                false, false, null, null);
    }
}
