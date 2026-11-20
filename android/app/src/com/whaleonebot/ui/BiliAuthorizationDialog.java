package com.whaleonebot.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import io.nayuki.qrcodegen.QrCode;

/** Paint the provider's one-time challenge in memory; never put it in an Intent, URL, file or accessibility text. */
final class BiliAuthorizationDialog {
    static AlertDialog show(Activity a,String challenge,String uid,Runnable cancel) {
        if(!BiliWebLogin.accepts(challenge)||BiliWebLogin.START.equals(challenge))return null;
        final QrCode qr=QrCode.encodeText(challenge,QrCode.Ecc.MEDIUM);
        LinearLayout box=Ui.column(a);int p=Ui.dp(a,Theme.S3);box.setPadding(p,p,p,p);
        TextView note=new TextView(a);note.setText("请用另一台设备的哔哩哔哩官方 App 扫码，并核对本人 UID："+uid+"。不要转发此码。确认后会自动核验账号。");box.addView(note);
        View image=new View(a){final Paint paint=new Paint();protected void onDraw(Canvas c){
            c.drawColor(0xffffffff);int step=Math.min(getWidth(),getHeight())/(qr.size+8);if(step<1)return;
            int x=(getWidth()-qr.size*step)/2,y=(getHeight()-qr.size*step)/2;paint.setColor(0xff000000);paint.setAntiAlias(false);
            for(int j=0;j<qr.size;j++)for(int i=0;i<qr.size;i++)if(qr.getModule(i,j))c.drawRect(x+i*step,y+j*step,x+(i+1)*step,y+(j+1)*step,paint);
        }};image.setContentDescription("本次 B 站官方授权二维码");box.addView(image,new LinearLayout.LayoutParams(-1,Ui.dp(a,260)));
        AlertDialog d=new AlertDialog.Builder(a).setTitle("B 站官方授权").setView(box).setPositiveButton("返回查看状态",null).setNegativeButton("取消本次授权",(w,k)->cancel.run()).create();
        d.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if((a.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0) {
            d.setButton(AlertDialog.BUTTON_NEUTRAL,"在本机官方网页确认",(w,k)->BiliWebLogin.open(a,challenge));
        } else {
            d.setButton(AlertDialog.BUTTON_NEUTRAL,"打开官方登录首页",(w,k)->{
                try{a.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,android.net.Uri.parse(BiliWebLogin.START)));}
                catch(android.content.ActivityNotFoundException ignored){android.widget.Toast.makeText(a,"未找到浏览器",android.widget.Toast.LENGTH_SHORT).show();}
            });
            note.append(" 调试版仅可用此码授权；单独打开登录首页不会授权机器人。");
        }
        d.show();return d;
    }
}
