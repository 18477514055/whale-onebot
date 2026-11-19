package com.whaleonebot.ui;

import android.graphics.Bitmap;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 二维码区。规则和 MainActivity 里的一致，这里只负责展示：
 * <ul>
 *   <li>只有 {@code host.qrLive()} 为真才显示码 —— 旧码、过期码一律不显示；</li>
 *   <li>码上方不叠任何东西（会挡扫），倒计时放在白纸下面的胶囊里；</li>
 *   <li>Bitmap 引用没变就不重新 setImageBitmap。</li>
 * </ul>
 */
final class QrPanel extends LinearLayout {

    private static final int PAPER_H = 276;

    private final AppShell shell;
    private final Theme t;
    private final ImageView img;
    private final LinearLayout placeholder;
    private final TextView hint;
    private final TextView count;

    private Bitmap shown;
    private int lastSec = -1;
    private String lastHint;

    QrPanel(AppShell shell) {
        super(shell.activity);
        this.shell = shell;
        this.t = shell.theme;
        setOrientation(VERTICAL);

        // ---------- 白纸 ----------
        FrameLayout paper = new FrameLayout(shell.activity);
        paper.setBackground(Drawables.round(t.qrPaper, 0, 0,
                Ui.dp(shell.activity, Theme.R_PANEL)));
        paper.setClipToOutline(true);
        Ui.elevate(paper, 3f, t);

        img = new ImageView(shell.activity);
        img.setScaleType(ImageView.ScaleType.FIT_CENTER);
        img.setAdjustViewBounds(false);
        int pad = Ui.dp(shell.activity, 14);
        img.setPadding(pad, pad, pad, pad);
        img.setVisibility(View.GONE);
        paper.addView(img, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        placeholder = Ui.column(shell.activity);
        placeholder.setGravity(Gravity.CENTER);
        placeholder.setPadding(pad, pad, pad, pad);
        IconView glyph = new IconView(shell.activity, IconView.QR, Ui.alpha(t.qrInk, 0.55f));
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(
                Ui.dp(shell.activity, 44), Ui.dp(shell.activity, 44));
        glp.gravity = Gravity.CENTER;
        glp.bottomMargin = Ui.dp(shell.activity, Theme.S2);
        placeholder.addView(glyph, glp);

        hint = Ui.text(shell.activity, "", Theme.T_BODY, Ui.alpha(t.qrInk, 0.95f));
        hint.setGravity(Gravity.CENTER);
        placeholder.addView(hint, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        paper.addView(placeholder, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        addView(paper, Ui.llp(MATCH_PARENT, Ui.dp(shell.activity, PAPER_H)));

        // ---------- 倒计时（保持在位，撑住布局，避免码消失时页面跳动） ----------
        count = Ui.text(shell.activity, "", Theme.T_CAP, t.toneStrong);
        count.setGravity(Gravity.CENTER);
        count.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        count.setLetterSpacing(0.04f);
        count.setBackground(Drawables.round(Ui.alpha(t.accent, t.dark ? 0.18f : 0.16f),
                0, 0, Ui.dp(shell.activity, Theme.R_PILL)));
        count.setPadding(Ui.dp(shell.activity, 12), Ui.dp(shell.activity, 5),
                Ui.dp(shell.activity, 12), Ui.dp(shell.activity, 5));
        count.setVisibility(View.INVISIBLE);

        LinearLayout wrap = Ui.row(shell.activity);
        wrap.setGravity(Gravity.CENTER);
        wrap.addView(count, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        LinearLayout.LayoutParams wlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        wlp.topMargin = Ui.dp(shell.activity, 10);
        wlp.gravity = Gravity.CENTER_HORIZONTAL;
        addView(wrap, wlp);
    }

    void refresh() {
        boolean live = shell.host.qrLive();
        Bitmap b = live ? shell.host.qrBitmap() : null;

        if (b != null) {
            if (b != shown) {
                img.setImageBitmap(b);
                shown = b;
            }
            img.setVisibility(View.VISIBLE);
            placeholder.setVisibility(View.GONE);

            long left = Math.max(0L, shell.host.qrLeftSeconds());
            int sec = (int) Math.min(Integer.MAX_VALUE, left);
            if (sec != lastSec) {
                count.setText(sec + " 秒后过期");
                lastSec = sec;
            }
            count.setVisibility(View.VISIBLE);
        } else {
            if (shown != null) {
                img.setImageDrawable(null);
                shown = null;
            }
            img.setVisibility(View.GONE);
            placeholder.setVisibility(View.VISIBLE);
            count.setVisibility(View.INVISIBLE);
            lastSec = -1;

            String h = hintText();
            if (!h.equals(lastHint)) {
                hint.setText(h);
                lastHint = h;
            }
        }
    }

    private String hintText() {
        String uin = shell.host.loginUin();
        if (uin != null && uin.length() > 0) return "已登录，无需扫码";
        if (!shell.host.containerRunning()) return "容器未启动，先点上面的「启动容器」";
        if (shell.qrSeenLive) return "二维码已过期，点「换一张码」重新获取";
        if (shell.qrRequestedAt > 0) return "正在向 QQ 请求二维码…首次约 40 秒";
        return "点「QQ 登录」获取二维码";
    }
}
